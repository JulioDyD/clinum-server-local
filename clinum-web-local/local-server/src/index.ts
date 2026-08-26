import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { AckFrame, ConfigUpdateFrame, IncomingFrame, LampEffectiveState, LampStateFrame, LocationSettings } from "./types.js";
import { SqliteStore } from "./store/sqliteStore.js";
import { RealtimeHub } from "./ws/realtimeHub.js";
import { SerialGateway } from "./serial/serialGateway.js";
import { FirebaseBridge } from "./firebase/firebaseBridge.js";

const firebaseEnabled = FirebaseBridge.initAdmin(config.firebaseProjectId, !config.localOnly);

const app = Fastify({ logger: true });
const store = new SqliteStore(config.localDbFile);
const firebase = new FirebaseBridge(config.firebaseProjectId, !config.localOnly);

// Socket.IO se adjunta al servidor HTTP de Fastify directamente
const hub = new RealtimeHub(app.server, (socket) => {
  // Envía estado actual al cliente recién conectado
  socket.emit("active_calls", store.getActiveCalls());
  socket.emit("device_list", store.getDevices());
  socket.emit("lamp_list", store.getLamps());
  socket.emit("call_history", store.getCallHistory());
  socket.emit("location_settings", store.getLocationSettings());
});

const gateway = new SerialGateway(config.serialPort, config.serialBaud, {
  onFrame: (frame) => void handleFrame(frame),
  onInvalidFrame: (raw) => app.log.warn({ raw }, "Invalid serial frame"),
});

type PendingEndCommand = {
  deviceId: string;
  commandSeq: number;
  targetCallSeq: number;
  attempts: number;
  lastSentAtMs: number;
};

const pendingEndCommands = new Map<string, PendingEndCommand>();
const confirmedEndCalls = new Map<string, number>();
let remoteCommandSeq = Date.now() >>> 0;
let lampRevisionCounter = 0;
type PendingLampState = { frame: LampStateFrame; attempts: number; lastSentAtMs: number };
const pendingLampStates = new Map<string, PendingLampState>();
const lampRetryDelaysMs = [150, 250, 500, 1000, 2000];

function nextRemoteCommandSeq(): number {
  remoteCommandSeq = (remoteCommandSeq + 1) >>> 0;
  if (remoteCommandSeq === 0) remoteCommandSeq = 1;
  return remoteCommandSeq;
}

function nextLampRevision(): number {
  lampRevisionCounter = (lampRevisionCounter + 1) % 1000;
  return Date.now() * 1000 + lampRevisionCounter;
}

function lampStateCode(state: LampEffectiveState): 0 | 1 | 2 {
  if (state === "emergency") return 2;
  if (state === "normal") return 1;
  return 0;
}

function syncLampState(lampId: string): void {
  const state = store.getEffectiveLampState(lampId);
  const lamp = store.getLamp(lampId);
  const profile = store.getLampAlertProfile(state === "emergency" ? "emergency" : "normal");
  const frame: LampStateFrame = {
    msgType: "lamp_state",
    lampId,
    commandSeq: nextRemoteCommandSeq(),
    stateRevision: nextLampRevision(),
    associationRevision: Date.now() >>> 0,
    effectiveState: lampStateCode(state),
    normalToggleMs: 500,
    emergencyToggleMs: 200,
    colorPreset: profile?.colorPreset ?? 0,
    animationPreset: profile?.animationPreset ?? 0,
    soundPreset: profile?.soundPreset ?? 0,
    audioEnabled: Boolean(lamp?.audioEnabled && profile?.audioEnabled),
    brightness: lamp?.brightness ?? 100,
    buzzerVolume: lamp?.buzzerVolume ?? 100,
  };
  gateway.sendLampState(frame);
  pendingLampStates.set(lampId, { frame, attempts: 1, lastSentAtMs: Date.now() });
}

function retryPendingLampStates(): void {
  const now = Date.now();
  for (const pending of pendingLampStates.values()) {
    const delay = lampRetryDelaysMs[Math.min(pending.attempts - 1, lampRetryDelaysMs.length - 1)];
    if (now - pending.lastSentAtMs < delay) continue;
    gateway.sendLampState(pending.frame);
    pending.attempts++;
    pending.lastSentAtMs = now;
  }
}

/** Si ya hay un comando en vuelo para la lampara, solo lo reenvia (sin nueva revision);
 * evita el bucle de realimentacion donde cada lamp_snapshot_request/heartbeat dispara una
 * revision nueva mientras el enlace serial ya esta saturado reintentando la anterior. */
function resyncLampIfNeeded(lampId: string): void {
  const pending = pendingLampStates.get(lampId);
  if (pending) {
    gateway.sendLampState(pending.frame);
    pending.lastSentAtMs = Date.now();
    return;
  }
  syncLampState(lampId);
}

function syncCallerLamps(deviceId: string): void {
  for (const lampId of store.getLampIdsForCaller(deviceId)) syncLampState(lampId);
}

function sendPendingEnd(command: PendingEndCommand): void {
  gateway.sendConfig({
    msgType: "config_update",
    deviceId: command.deviceId,
    seq: command.commandSeq,
    config: {
      endCall: true,
      targetCallSeq: command.targetCallSeq,
    },
  });
  command.attempts++;
  command.lastSentAtMs = Date.now();
}

function retryPendingEndCommands(): void {
  const now = Date.now();
  for (const [deviceId, command] of pendingEndCommands) {
    if (command.attempts >= 30) {
      app.log.error({ deviceId, commandSeq: command.commandSeq }, "Remote end was not confirmed");
      pendingEndCommands.delete(deviceId);
      continue;
    }
    if (now - command.lastSentAtMs >= 1000) sendPendingEnd(command);
  }
}

function ack(result: AckFrame["result"], frame: IncomingFrame): void {
  const payload: AckFrame = {
    msgType: "ack",
    deviceId: frame.deviceId,
    seq: frame.seq,
    result,
  };
  gateway.sendAck(payload);
}

async function syncToCloud(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    app.log.warn({ error }, "Cloud sync failed; local state remains persisted");
  }
}

async function handleFrame(frame: IncomingFrame): Promise<void> {
  // La lampara transmite un heartbeat de presencia generico (msgType=4) para que otros
  // nodos la detecten como relay; si el deviceId ya es una lampara conocida, ignorarlo aqui
  // para no registrarla tambien como llamador fantasma en la tabla de dispositivos.
  if (!frame.msgType.startsWith("lamp_") && frame.deviceId && store.getLamp(frame.deviceId)) {
    return;
  }
  if (frame.msgType.startsWith("lamp_")) {
    const lampId = frame.lampId ?? "";
    if (!lampId) return;
    const stateByCode: LampEffectiveState[] = ["off", "normal", "emergency"];
    if (frame.msgType === "lamp_register") {
      store.registerLamp(lampId, frame.srcMac ?? "", frame.relayCapable ?? true, frame.protocolVersion ?? 1);
      syncLampState(lampId);
    } else if (frame.msgType === "lamp_heartbeat" || frame.msgType === "lamp_state_ack" || frame.msgType === "lamp_test_ack") {
      const appliedState = stateByCode[frame.appliedState ?? 0] ?? "off";
      store.touchLamp(lampId, frame.srcMac, frame.appliedRevision ?? frame.stateRevision, appliedState);
      const pending = pendingLampStates.get(lampId);
      if (frame.msgType === "lamp_state_ack" && pending && frame.stateRevision === pending.frame.stateRevision &&
          (frame.result === 1 || frame.result === 2)) {
        pendingLampStates.delete(lampId);
      }
      if (frame.msgType === "lamp_heartbeat" && frame.appliedState !== lampStateCode(store.getEffectiveLampState(lampId))) {
        resyncLampIfNeeded(lampId);
      }
    } else if (frame.msgType === "lamp_snapshot_request") {
      store.touchLamp(lampId, frame.srcMac);
      resyncLampIfNeeded(lampId);
    }
    hub.publishLampList(store.getLamps());
    return;
  }

  if (!frame?.deviceId || typeof frame.seq !== "number" || !frame.msgType) {
    ack("invalid", frame);
    return;
  }

  // Register siempre pasa: el device arrancó, se reinició o reconectó.
  // Bypasear el duplicate check para que reboots queden online correctamente.
  if (frame.msgType === "register") {
    const existingCall = store.getActiveCallForDevice(frame.deviceId);

    if (existingCall) {
      // Terminal se reinicio con llamado activo: conservar el llamado y pedirle que retome
      const device = store.registerDevice(frame.deviceId, frame.srcMac ?? "");
      hub.publishActiveCalls(store.getActiveCalls());
      hub.publishDeviceRegistered(device);
      hub.publishDeviceList(store.getDevices());
      const resumeAck: AckFrame = {
        msgType: "ack",
        deviceId: frame.deviceId,
        seq: frame.seq,
        result: "ok",
        callActive: 1,
        callType: existingCall.call_type,
        callStartedAtS: Math.floor(existingCall.startedAtMs / 1000),
        callCons: existingCall.cons,
        callStartSeq: existingCall.startSeq,
      };
      gateway.sendAck(resumeAck);
      void syncToCloud(async () => {
        await firebase.upsertDevice(device);
        await firebase.mirrorPresence(frame.deviceId);
      });
    } else {
      // Sin llamado activo: cerrar cualquier estado obsoleto
      const { historyRecord } = store.forceEndCall(frame.deviceId);
      const device = store.registerDevice(frame.deviceId, frame.srcMac ?? "");
      if (historyRecord) hub.publishCallHistory(store.getCallHistory());
      hub.publishActiveCalls(store.getActiveCalls());
      ack("ok", frame);
      void syncToCloud(async () => {
        await firebase.upsertDevice(device);
        await firebase.mirrorPresence(frame.deviceId);
      });
      hub.publishDeviceRegistered(device);
      hub.publishDeviceList(store.getDevices());
    }
    return;
  }

  if (frame.msgType === "config_ack") {
    const pending = pendingEndCommands.get(frame.deviceId);
    if (pending && pending.commandSeq === frame.seq && frame.configResult === 1) {
      pendingEndCommands.delete(frame.deviceId);
      confirmedEndCalls.set(frame.deviceId, pending.targetCallSeq);
      app.log.info({ deviceId: frame.deviceId, commandSeq: frame.seq }, "Remote end confirmed by device");
    }
    return;
  }

  if (store.isDuplicateOrOld(frame.deviceId, frame.seq)) {
    ack("duplicate", frame);
    return;
  }

  switch (frame.msgType) {
    case "call_start":
    case "call_insist": {
      if (frame.msgType === "call_start") {
        pendingEndCommands.delete(frame.deviceId);
        confirmedEndCalls.delete(frame.deviceId);
      }
      const cons = Number(frame.cons ?? 1);
      const callType = frame.call_type === "emergency" ? "emergency" : "normal";
      const next = store.applyCallStart(frame.deviceId, frame.seq, cons, callType);
      const device = store.touchDevice(frame.deviceId, frame.srcMac);
      hub.publishCallState(next);
      hub.publishActiveCalls(store.getActiveCalls());
      ack("ok", frame);
      syncCallerLamps(frame.deviceId);
      void syncToCloud(async () => {
        await firebase.upsertCalled(next);
        await firebase.upsertDevice(device);
      });
      return;
    }

    case "call_end": {
      const { state: next, historyRecord } = store.applyCallEnd(frame.deviceId, frame.seq);
      pendingEndCommands.delete(frame.deviceId);
      confirmedEndCalls.set(frame.deviceId, next.startSeq);
      const device = store.touchDevice(frame.deviceId, frame.srcMac);
      hub.publishCallState(next);
      hub.publishActiveCalls(store.getActiveCalls());
      if (historyRecord) hub.publishCallHistory(store.getCallHistory());
      ack("ok", frame);
      syncCallerLamps(frame.deviceId);
      void syncToCloud(async () => {
        await firebase.upsertCalled(next);
        await firebase.upsertDevice(device);
        if (historyRecord) await firebase.saveCallHistory(historyRecord);
      });
      return;
    }

    case "heartbeat": {
      // Heartbeats comparten el contador de radio, pero no representan eventos
      // de llamada. No avanzar seq_tracker: un heartbeat posterior no debe
      // convertir en "antigua" una llamada pendiente que se esta reintentando.
      const device = store.touchDevice(frame.deviceId, frame.srcMac);
      const callState = store.getCallForDevice(frame.deviceId);
      if (callState && !callState.active && callState.startSeq > 0 &&
          confirmedEndCalls.get(frame.deviceId) !== callState.startSeq &&
          !pendingEndCommands.has(frame.deviceId)) {
        const command: PendingEndCommand = {
          deviceId: frame.deviceId,
          commandSeq: nextRemoteCommandSeq(),
          targetCallSeq: callState.startSeq,
          attempts: 0,
          lastSentAtMs: 0,
        };
        pendingEndCommands.set(frame.deviceId, command);
        sendPendingEnd(command);
      }
      ack("ok", frame);
      void syncToCloud(async () => {
        await firebase.upsertDevice(device);
        await firebase.mirrorPresence(frame.deviceId);
      });
      return;
    }

    default:
      ack("invalid", frame);
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.get("/health", async () => ({
  ok: true,
  ts: Date.now(),
  firebaseEnabled,
  serialPort: config.serialPort,
}));

app.get("/devices", async () => ({ items: store.getDevices() }));

app.get("/lamps", async () => ({ items: store.getLamps() }));

app.get("/lamp-alert-profiles", async () => ({ items: store.getLampAlertProfiles() }));

app.get("/location-settings", async () => store.getLocationSettings());

app.patch<{ Body: Partial<LocationSettings> }>("/location-settings", async (req) => {
  const settings = store.updateLocationSettings(req.body ?? {});
  hub.publishLocationSettings(settings);
  return settings;
});

app.patch<{ Params: { callType: string }; Body: Partial<{ label: string; enabled: boolean; colorPreset: number; animationPreset: number; soundPreset: number; audioEnabled: boolean }> }>("/lamp-alert-profiles/:callType", async (req, reply) => {
  const profile = store.updateLampAlertProfile(req.params.callType, req.body ?? {});
  if (!profile) return reply.status(404).send({ error: "Alert profile not found" });
  for (const lamp of store.getLamps()) syncLampState(lamp.lampId);
  return profile;
});

app.patch<{ Params: { id: string }; Body: { name?: string; audioEnabled?: boolean; brightness?: number; buzzerVolume?: number } }>("/lamps/:id", async (req, reply) => {
  const lamp = store.updateLamp(req.params.id, req.body ?? {});
  if (!lamp) return reply.status(404).send({ error: "Lamp not found" });
  hub.publishLampList(store.getLamps());
  syncLampState(lamp.lampId);
  return lamp;
});

app.delete<{ Params: { id: string } }>("/lamps/:id", async (req, reply) => {
  if (!store.deleteLamp(req.params.id)) return reply.status(404).send({ error: "Lamp not found" });
  hub.publishLampList(store.getLamps());
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { state?: "normal" | "emergency"; durationMs?: number } }>("/lamps/:id/test", async (req, reply) => {
  const lamp = store.getLamp(req.params.id);
  if (!lamp) return reply.status(404).send({ error: "Lamp not found" });
  const requestedState = req.body?.state === "emergency" ? "emergency" : "normal";
  const profile = store.getLampAlertProfile(requestedState);
  gateway.sendLampTest({
    msgType: "lamp_test",
    lampId: lamp.lampId,
    commandSeq: nextRemoteCommandSeq(),
    testState: requestedState === "emergency" ? 2 : 1,
    durationMs: Math.max(100, Math.min(30_000, Math.round(req.body?.durationMs ?? 3000))),
    colorPreset: profile?.colorPreset ?? 0,
    animationPreset: profile?.animationPreset ?? 0,
    soundPreset: profile?.soundPreset ?? 0,
    audioEnabled: Boolean(lamp.audioEnabled && profile?.audioEnabled),
    brightness: lamp.brightness,
    buzzerVolume: lamp.buzzerVolume,
  });
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/devices/:id/lamps", async (req) => ({
  lampIds: store.getLampIdsForCaller(req.params.id),
}));

app.put<{ Params: { id: string }; Body: { lampIds?: string[] } }>("/devices/:id/lamps", async (req, reply) => {
  if (!store.getDevice(req.params.id)) return reply.status(404).send({ error: "Device not found" });
  try {
    const previousLampIds = store.getLampIdsForCaller(req.params.id);
    const lampIds = store.setLampAssignments(req.params.id, req.body?.lampIds ?? []);
    for (const lampId of new Set([...previousLampIds, ...lampIds])) syncLampState(lampId);
    hub.publishLampAssignments(req.params.id, lampIds);
    return { callerDeviceId: req.params.id, lampIds };
  } catch (error) {
    return reply.status(400).send({ error: error instanceof Error ? error.message : "Invalid assignment" });
  }
});

app.get<{ Params: { id: string } }>("/devices/:id", async (req, reply) => {
  const device = store.getDevice(req.params.id);
  if (!device) return reply.status(404).send({ error: "Device not found" });
  return device;
});

app.delete<{ Params: { id: string } }>("/devices/:id", async (req, reply) => {
  const { id } = req.params;
  const deleted = store.deleteDevice(id);
  if (!deleted) return reply.status(404).send({ error: "Device not found" });
  hub.publishDeviceList(store.getDevices());
  hub.publishActiveCalls(store.getActiveCalls());
  return { ok: true };
});

app.patch<{ Params: { id: string }; Body: { name?: string; callerLocationType?: string } }>("/devices/:id", async (req, reply) => {
  const { id } = req.params;
  const { name, callerLocationType } = req.body ?? {};
  let device = store.getDevice(id);
  if (!device) return reply.status(404).send({ error: "Device not found" });
  if (name !== undefined) device = store.updateDeviceName(id, name);
  if (callerLocationType !== undefined) device = store.updateDeviceLocationType(id, callerLocationType);
  if (!device) return reply.status(404).send({ error: "Device not found" });
  hub.publishDeviceList(store.getDevices());
  // Envía el nombre al dispositivo vía gateway ESP-NOW
  if (name) {
    const configFrame: ConfigUpdateFrame = {
      msgType: "config_update",
      deviceId: id,
      config: { name },
    };
    gateway.sendConfig(configFrame);
  }
  return device;
});

app.get("/calls/active", async () => ({ items: store.getActiveCalls() }));

app.get("/calls/all", async () => ({ items: store.getAllCalls() }));

app.get<{ Querystring: { deviceId?: string } }>("/calls/history", async (req) => {
  return { items: store.getCallHistory(req.query.deviceId) };
});

app.post<{ Params: { id: string } }>("/calls/:id/end", async (req, reply) => {
  const { id } = req.params;
  const active = store.getActiveCalls().find(c => c.deviceId === id);
  if (!active) return reply.status(404).send({ error: "No active call for this device" });
  const { state, historyRecord } = store.forceEndCall(id);
  syncCallerLamps(id);
  void syncToCloud(async () => {
    await firebase.upsertCalled(state);
    if (historyRecord) await firebase.saveCallHistory(historyRecord);
  });
  hub.publishCallState(state);
  hub.publishActiveCalls(store.getActiveCalls());
  if (historyRecord) hub.publishCallHistory(store.getCallHistory());
  const command: PendingEndCommand = {
    deviceId: id,
    commandSeq: nextRemoteCommandSeq(),
    targetCallSeq: active.startSeq,
    attempts: 0,
    lastSentAtMs: 0,
  };
  pendingEndCommands.set(id, command);
  confirmedEndCalls.delete(id);
  sendPendingEnd(command);
  return { ok: true, delivery: "pending", commandSeq: command.commandSeq };
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  store.markAllOffline();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const publicDir = join(__dirname, "..", "public");

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    wildcard: false,
    serve: true,
    decorateReply: false,
  });

  const stopConfigWatch = firebase.subscribeConfig((deviceId, cfg) => {
    const frame: ConfigUpdateFrame = {
      msgType: "config_update",
      deviceId,
      config: cfg,
    };
    gateway.sendConfig(frame);
  });

  await app.ready();
  await gateway.open();

  // Sincronizar hora al gateway inmediatamente y cada 60 s
  gateway.sendTimeSync();
  setInterval(() => gateway.sendTimeSync(), 60_000);
  setInterval(retryPendingEndCommands, 250);
  setInterval(retryPendingLampStates, 50);

  await app.listen({ port: config.localHttpPort, host: "0.0.0.0" });

  app.log.info(
    { firebaseEnabled, serialPort: config.serialPort, localDbFile: config.localDbFile },
    `Local bridge running on :${config.localHttpPort}`,
  );

  process.on("SIGINT", () => {
    stopConfigWatch();
    store.close();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  app.log.error(err, "Bootstrap failed");
  process.exit(1);
});


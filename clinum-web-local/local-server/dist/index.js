import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { config } from "./config.js";
import { isSpecialCallType, SPECIAL_CALL_TYPES } from "./types.js";
import { isTactileFirmware } from "./deviceTypes.js";
import { SqliteStore } from "./store/sqliteStore.js";
import { RealtimeHub } from "./ws/realtimeHub.js";
import { SerialGateway } from "./serial/serialGateway.js";
import { FirebaseBridge } from "./firebase/firebaseBridge.js";
import { getIntegrationSettings, updateIntegrationSettings } from "./envSettings.js";
const SOUNDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sounds");
/** Solo se aceptan audios existentes y no vacios: evita seleccionar MP3 rotos. */
const isPlayableSound = (file) => {
    if (typeof file !== "string" || !/^[A-Za-z0-9._-]+$/.test(file))
        return false;
    try {
        return statSync(join(SOUNDS_DIR, file)).size > 0;
    }
    catch {
        return false;
    }
};
const SOUND_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a"]);
/** Lista los audios disponibles en la sede para publicarlos en site_sync. */
function listSoundFiles() {
    try {
        return readdirSync(SOUNDS_DIR, { withFileTypes: true })
            .filter(entry => entry.isFile() && SOUND_EXTENSIONS.has(extname(entry.name).toLowerCase()))
            .filter(entry => {
            try {
                return statSync(join(SOUNDS_DIR, entry.name)).size > 0;
            }
            catch {
                return false;
            }
        })
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));
    }
    catch {
        return [];
    }
}
const _integration0 = getIntegrationSettings();
FirebaseBridge.initAdmin(config.firebaseProjectId, !config.localOnly, _integration0.serviceAccountPath);
// HTTPS with site CA when TLS_ENABLED=1 and key/cert exist.
// Otherwise plain HTTP (dev or pre-TLS sites).
function loadTls() {
    if (!config.tls.enabled)
        return undefined;
    if (!existsSync(config.tls.keyFile) || !existsSync(config.tls.certFile)) {
        console.warn(`[TLS] disabled: missing key/cert (${config.tls.keyFile}, ${config.tls.certFile})`);
        return undefined;
    }
    return { key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile) };
}
const tlsOptions = loadTls();
const tlsActive = Boolean(tlsOptions);
// Typed as the plain HTTP instance: at runtime it may wrap an HTTPS server,
// whose API surface used here (routes, listen, server handle) is identical.
const app = (tlsOptions ? Fastify({ logger: true, https: tlsOptions }) : Fastify({ logger: true }));
const store = new SqliteStore(config.localDbFile);
const firebase = new FirebaseBridge(config.firebaseProjectId, !config.localOnly, config.locationId, _integration0.serviceAccountPath);
if (config.outboxEnabled) {
    firebase.setOutboxHandler((kind, docId, payload, deleteFields) => {
        store.enqueueCloudWrite(kind, docId, payload, deleteFields);
    });
}
let stopSiteSettingsWatch = () => undefined;
let stopPatientsWatch = () => undefined;
let stopSiteCommandsWatch = () => undefined;
let presencePublishTimer = null;
let sectionPublishTimer = null;
const dirtySiteSections = new Set();
let lastPresencePublishAt = 0;
let outboxFlushInFlight = false;
// Socket.IO se adjunta al servidor HTTP de Fastify directamente
const hub = new RealtimeHub(app.server, (socket) => {
    // Envía estado actual al cliente recién conectado
    socket.emit("active_calls", store.getActiveCalls());
    socket.emit("device_list", store.getDevices());
    socket.emit("lamp_list", store.getLamps());
    socket.emit("call_history", store.getCallHistory());
    socket.emit("location_settings", store.getLocationSettings());
    socket.emit("patient_list", store.getPatients());
    socket.emit("presence_settings", store.getPresenceSettings());
    for (const sensor of store.getPresenceSensors())
        socket.emit("presence_state", presenceSensorState(sensor));
});
const devicePresenceSentAt = new Map();
const DEVICE_PRESENCE_THROTTLE_MS = 5000;
function publishDevicePresence(device) {
    const now = Date.now();
    if (now - (devicePresenceSentAt.get(device.deviceId) ?? 0) < DEVICE_PRESENCE_THROTTLE_MS)
        return;
    devicePresenceSentAt.set(device.deviceId, now);
    hub.publishDevicePresence(device.deviceId, device.lastSeenMs, device.online);
}
const presenceRuntime = new Map();
function presenceSensorState(sensor, now = Date.now()) {
    const settings = store.getPresenceSettings();
    const runtime = presenceRuntime.get(sensor.deviceId);
    const open = runtime?.sessionId ? store.getPresenceSession(runtime.sessionId) : store.getOpenPresenceSession(sensor.deviceId);
    const lastSeenAtMs = runtime?.lastSeenAtMs ?? open?.lastSeenAtMs ?? 0;
    const stale = lastSeenAtMs > 0 && now - lastSeenAtMs >= settings.staleS * 1000;
    const occupied = Boolean(open);
    const alert = Boolean(open && (open.alertSentAtMs > 0 ||
        (settings.alertEnabled && now - open.enteredAtMs >= settings.longStayMin * 60_000)));
    return {
        deviceId: sensor.deviceId,
        role: sensor.role,
        areaName: store.getDevice(sensor.deviceId)?.name || sensor.areaName || sensor.deviceId,
        state: occupied ? (stale ? "unknown" : "occupied") : (stale || !runtime ? "unknown" : "free"),
        sessionId: open?.id,
        enteredAtMs: open?.enteredAtMs,
        lastSeenAtMs: lastSeenAtMs || undefined,
        alert,
    };
}
function publishPresenceState(deviceId) {
    const sensor = store.getPresenceSensor(deviceId);
    if (!sensor)
        return;
    hub.publishPresenceState(presenceSensorState(sensor));
    // Mantiene el espejo site_sync/presence al día para la pantalla web.
    scheduleSiteSection("presence");
}
function closePresenceRuntimeSession(deviceId, exitedAtMs, reason) {
    const runtime = presenceRuntime.get(deviceId);
    if (!runtime)
        return;
    if (!runtime.sessionId) {
        runtime.present = false;
        return;
    }
    const settings = store.getPresenceSettings();
    const closed = store.closePresenceSession(runtime.sessionId, exitedAtMs, reason, settings.minSessionS * 1000);
    runtime.sessionId = undefined;
    runtime.enteredAtMs = undefined;
    runtime.exitDeadlineMs = undefined;
    runtime.alertSent = false;
    runtime.present = false;
    if (closed)
        hub.publishPresenceSession(closed);
    publishPresenceState(deviceId);
}
function handlePresenceMonitor(deviceId, present, now) {
    const settings = store.getPresenceSettings();
    if (!settings.enabled)
        return;
    const sensor = store.getPresenceSensor(deviceId);
    if (!sensor || !sensor.enabled)
        return;
    const runtime = presenceRuntime.get(deviceId) ?? { present: false, lastSeenAtMs: 0, alertSent: false };
    const wasPresent = runtime.present;
    runtime.lastSeenAtMs = now;
    if (present) {
        runtime.present = true;
        runtime.exitDeadlineMs = undefined;
        if (!runtime.sessionId) {
            const existing = store.getOpenPresenceSession(deviceId);
            if (existing) {
                runtime.sessionId = existing.id;
                runtime.enteredAtMs = existing.enteredAtMs;
                runtime.alertSent = existing.alertSentAtMs > 0;
                store.touchPresenceSession(existing.id, now);
            }
            else {
                const session = store.openPresenceSession(deviceId, sensor.role, sensor.areaName, now, now);
                runtime.sessionId = session.id;
                runtime.enteredAtMs = session.enteredAtMs;
                runtime.alertSent = false;
                hub.publishPresenceSession(session);
            }
        }
        else {
            store.touchPresenceSession(runtime.sessionId, now);
        }
        if (!wasPresent)
            hub.publishPresenceDetection({ deviceId, areaName: sensor.areaName, role: sensor.role });
    }
    else {
        runtime.present = false;
        if (runtime.sessionId && !runtime.exitDeadlineMs) {
            runtime.exitDeadlineMs = now + settings.exitGraceS * 1000;
        }
    }
    presenceRuntime.set(deviceId, runtime);
    publishPresenceState(deviceId);
}
function sweepPresenceMonitor(now = Date.now()) {
    const settings = store.getPresenceSettings();
    if (!settings.enabled)
        return;
    for (const [deviceId, runtime] of presenceRuntime) {
        const sensor = store.getPresenceSensor(deviceId);
        if (!sensor || !sensor.enabled) {
            closePresenceRuntimeSession(deviceId, now, "sensor_disabled");
            presenceRuntime.delete(deviceId);
            continue;
        }
        if (!runtime.sessionId) {
            if (runtime.lastSeenAtMs > 0 && now - runtime.lastSeenAtMs >= settings.staleS * 1000) {
                runtime.present = false;
                publishPresenceState(deviceId);
            }
            continue;
        }
        if (now - runtime.lastSeenAtMs >= settings.staleS * 1000) {
            closePresenceRuntimeSession(deviceId, runtime.lastSeenAtMs || now, "timeout");
            continue;
        }
        if (runtime.exitDeadlineMs && now >= runtime.exitDeadlineMs) {
            closePresenceRuntimeSession(deviceId, runtime.exitDeadlineMs, "sensor");
            continue;
        }
        if (settings.alertEnabled && !runtime.alertSent && runtime.enteredAtMs &&
            now - runtime.enteredAtMs >= settings.longStayMin * 60_000) {
            store.markPresenceSessionAlert(runtime.sessionId, now);
            runtime.alertSent = true;
            const session = store.getPresenceSession(runtime.sessionId);
            if (session)
                hub.publishPresenceSession(session);
            publishPresenceState(deviceId);
        }
    }
}
const gateway = new SerialGateway(config.serialPort, config.serialBaud, {
    onFrame: (frame) => void handleFrame(frame).catch(error => app.log.error({ error, deviceId: frame?.deviceId }, "Frame not committed; sender must retry")),
    onGatewayControl: (frame) => handleGatewayControl(frame),
    onInvalidFrame: (raw) => app.log.warn({ raw }, "Invalid serial frame"),
});
let gatewayControlState = { msgType: "gateway_config_required", protocolVersion: 2 };
let lastGatewaySummary = "";
// Compara sin contadores volatiles (diagnostics): gateway_status llega
// cada ~2s y solo se loguea cuando algo relevante cambia.
function stableGatewaySummary(frame) {
    const { diagnostics, ...rest } = frame;
    void diagnostics;
    return JSON.stringify(rest);
}
function handleGatewayControl(frame) {
    gatewayControlState = frame;
    const summary = stableGatewaySummary(frame);
    if (summary !== lastGatewaySummary) {
        lastGatewaySummary = summary;
        app.log.info({ frame }, "Gateway control state updated");
    }
    if (frame.msgType === "gateway_config_ack" && frame.result === "stored") {
        setTimeout(() => gateway.requestGatewayStatus(), 1500);
    }
}
const pendingEndCommands = new Map();
const confirmedEndCalls = new Map();
let lampRevisionCounter = 0;
const pendingLampStates = new Map();
const lampRetryDelaysMs = [150, 250, 500, 1000, 2000];
const pendingTransportCommands = new Map();
const devicePresence = new Map();
const pendingPatients = new Map();
/** Tope de reintentos para no acumular comandos de dispositivos que ya no responden.
 * Al agotarse se descartan; si el llamador vuelve, su heartbeat/register los re-arma. */
const MAX_PENDING_END_ATTEMPTS = 20;
const MAX_PENDING_NAME_ATTEMPTS = 20;
function nextRemoteCommandSeq() {
    return store.nextCommandSeq();
}
function nextLampRevision() {
    lampRevisionCounter = (lampRevisionCounter + 1) % 1000;
    return Date.now() * 1000 + lampRevisionCounter;
}
function syncPatient(deviceId) {
    pendingPatients.set(deviceId, { seq: nextRemoteCommandSeq(), lastSentAtMs: 0 });
    return sendPendingPatient(deviceId);
}
function sendPendingPatient(deviceId) {
    const patient = store.getPatientByDevice(deviceId);
    const pending = pendingPatients.get(deviceId);
    if (!pending)
        return true;
    pending.lastSentAtMs = Date.now();
    return gateway.sendPatient({
        msgType: "patient_update", deviceId, seq: pending.seq,
        patient: patient ? {
            name: patient.name, age: patient.age === undefined ? "" : String(patient.age),
            admissionDate: patient.admissionDate ?? "", notes: patient.notes ?? "",
        } : null,
    });
}
function publishPatients(deviceIds) {
    let sent = true;
    for (const id of new Set(deviceIds.filter((id) => !!id)))
        sent = syncPatient(id) && sent;
    hub.publishPatientList(store.getPatients());
    hub.publishActiveCalls(store.getActiveCalls());
    return sent;
}
function retryPatients() {
    if (!gateway.isAvailable())
        return;
    for (const [id, pending] of pendingPatients) {
        if (Date.now() - pending.lastSentAtMs >= 45000)
            sendPendingPatient(id);
    }
}
function queueDeviceName(deviceId, name) {
    if (Buffer.byteLength(name, "utf8") > 32 || /[,\r\n]/.test(name)) {
        app.log.warn({ deviceId }, "Stored device name is incompatible with legacy CONFIG; edit name in panel");
        return;
    }
    store.savePendingCommand(deviceId, "name", nextRemoteCommandSeq(), { name });
    retryDeviceNames();
}
function retryDeviceNames() {
    if (!gateway.isAvailable())
        return;
    for (const command of store.getPendingCommands()) {
        if (command.kind !== "name")
            continue;
        if (!store.getDevice(command.deviceId)) {
            store.cancelPendingCommand(command.deviceId, "name");
            app.log.info({ deviceId: command.deviceId }, "Dropped pending name for removed device");
            continue;
        }
        if (command.attempts >= MAX_PENDING_NAME_ATTEMPTS) {
            store.cancelPendingCommand(command.deviceId, "name");
            app.log.info({ deviceId: command.deviceId, attempts: command.attempts }, "Dropped unconfirmed name command");
            continue;
        }
        if (Date.now() - command.lastSentAtMs < 15000)
            continue;
        gateway.sendConfig({ msgType: "config_update", deviceId: command.deviceId, seq: command.seq, config: command.payload });
        store.markCommandSent(command.deviceId, "name");
    }
}
function lampStateCode(state) {
    if (state === "emergency")
        return 2;
    if (state === "normal" || state === "presence" || isSpecialCallType(state))
        return 1;
    return 0;
}
/**
 * Sincroniza las lámparas de perfiles especiales.
 * @param extraCallTypes Tipos finalizados en este evento: deben incluirse aunque ya
 *   no figuren como activos, o sus lámparas nunca recibirían el estado "off".
 */
function syncSpecialProfileLamps(extraCallTypes = []) {
    const types = new Set(store.getActiveCalls()
        .filter(call => call.active && isSpecialCallType(call.call_type))
        .map(call => call.call_type));
    for (const type of extraCallTypes)
        if (isSpecialCallType(type))
            types.add(type);
    if (types.size === 0)
        return;
    for (const lampId of store.getLampIdsForSpecialCallTypes([...types]))
        syncLampState(lampId);
}
function syncLampState(lampId) {
    let state = store.getEffectiveLampState(lampId);
    // Si no hay llamada activa, verificar presencia en el Map
    if (state === "off") {
        const callerIds = store.getCallerIdsForLamp(lampId);
        const hasPresence = callerIds.some(id => devicePresence.get(id) === true);
        if (hasPresence) {
            state = "presence";
        }
    }
    const lamp = store.getLamp(lampId);
    const fallbackPresets = {
        normal: { colorPreset: 10, animationPreset: 1, soundPreset: 1, audioEnabled: true },
        emergency: { colorPreset: 0, animationPreset: 4, soundPreset: 4, audioEnabled: true },
        presence: { colorPreset: 7, animationPreset: 1, soundPreset: 17, audioEnabled: true },
        type3: { colorPreset: 4, animationPreset: 7, soundPreset: 7, audioEnabled: true },
        type4: { colorPreset: 6, animationPreset: 10, soundPreset: 10, audioEnabled: true },
        type5: { colorPreset: 8, animationPreset: 13, soundPreset: 13, audioEnabled: true },
        type6: { colorPreset: 9, animationPreset: 16, soundPreset: 16, audioEnabled: true },
    };
    const dbProfile = store.getLampAlertProfile(state);
    if (!dbProfile) {
        console.warn(`[WARN] Perfil '${state}' no encontrado en BD para lampId=${lampId}, usando defaults de fallback`);
    }
    const presets = dbProfile ?? fallbackPresets[state] ?? fallbackPresets.normal;
    const frame = {
        msgType: "lamp_state",
        lampId,
        commandSeq: nextRemoteCommandSeq(),
        stateRevision: nextLampRevision(),
        associationRevision: Date.now() >>> 0,
        effectiveState: lampStateCode(state),
        normalToggleMs: 500,
        emergencyToggleMs: 200,
        colorPreset: presets.colorPreset,
        animationPreset: presets.animationPreset,
        soundPreset: presets.soundPreset,
        audioEnabled: Boolean(lamp?.audioEnabled && presets.audioEnabled),
        brightness: lamp?.brightness ?? 100,
        buzzerVolume: lamp?.buzzerVolume ?? 100,
    };
    gateway.sendLampState(frame);
    pendingLampStates.set(lampId, { frame, attempts: 1, lastSentAtMs: Date.now() });
    console.log(`[SYNC_LAMP] lampId=${lampId} state=${state} effectiveState=${frame.effectiveState} color=${frame.colorPreset} anim=${frame.animationPreset} sound=${frame.soundPreset} fromDB=${!!dbProfile}`);
}
/** Envía una prueba de perfil a una lámpara (ruta local y comando site_sync). */
function performLampTest(lampId, stateRaw, durationMsRaw) {
    const lamp = store.getLamp(lampId);
    if (!lamp)
        throw new Error("Lámpara no encontrada");
    if (!gateway.isAvailable())
        throw new Error("Gateway serial no conectado");
    const validStates = ["normal", "emergency", "presence", "type3", "type4", "type5", "type6"];
    const requestedState = validStates.includes(String(stateRaw ?? "")) ? String(stateRaw) : "normal";
    const fallbackPresets = {
        normal: { colorPreset: 10, animationPreset: 1, soundPreset: 1, audioEnabled: true },
        emergency: { colorPreset: 0, animationPreset: 4, soundPreset: 4, audioEnabled: true },
        presence: { colorPreset: 7, animationPreset: 1, soundPreset: 17, audioEnabled: true },
        type3: { colorPreset: 4, animationPreset: 7, soundPreset: 7, audioEnabled: true },
        type4: { colorPreset: 6, animationPreset: 10, soundPreset: 10, audioEnabled: true },
        type5: { colorPreset: 8, animationPreset: 13, soundPreset: 13, audioEnabled: true },
        type6: { colorPreset: 9, animationPreset: 16, soundPreset: 16, audioEnabled: true },
    };
    const dbProfile = store.getLampAlertProfile(requestedState);
    const presets = dbProfile ?? fallbackPresets[requestedState] ?? fallbackPresets.normal;
    const durationMs = Math.max(100, Math.min(30_000, Math.round(durationMsRaw ?? 3000)));
    gateway.sendLampTest({
        msgType: "lamp_test",
        lampId: lamp.lampId,
        commandSeq: nextRemoteCommandSeq(),
        testState: requestedState === "emergency" ? 2 : 1,
        durationMs,
        colorPreset: presets.colorPreset,
        animationPreset: presets.animationPreset,
        soundPreset: presets.soundPreset,
        audioEnabled: Boolean(lamp.audioEnabled && presets.audioEnabled),
        brightness: lamp.brightness,
        buzzerVolume: lamp.buzzerVolume,
    });
    console.log(`[TEST] lamp=${lamp.lampId} state=${requestedState} color=${presets.colorPreset} anim=${presets.animationPreset} sound=${presets.soundPreset} testState=${requestedState === "emergency" ? 2 : 1} fromDB=${!!dbProfile}`);
}
function retryPendingLampStates() {
    const now = Date.now();
    for (const [lampId, pending] of pendingLampStates) {
        if (!gateway.isAvailable())
            continue;
        const delay = pending.attempts >= 10 ? 30000 : lampRetryDelaysMs[Math.min(pending.attempts - 1, lampRetryDelaysMs.length - 1)];
        if (now - pending.lastSentAtMs < delay)
            continue;
        gateway.sendLampState(pending.frame);
        pending.attempts++;
        pending.lastSentAtMs = now;
    }
}
function sendPendingTransport(command) {
    gateway.sendConfig({
        msgType: "config_update",
        deviceId: command.lampId,
        config: { transport: command.transport },
    });
    command.attempts++;
    command.lastSentAtMs = Date.now();
}
function retryPendingTransportCommands() {
    const now = Date.now();
    for (const [lampId, command] of pendingTransportCommands) {
        const lamp = store.getLamp(lampId);
        if (!lamp?.pendingTransport || lamp.transport === command.transport) {
            pendingTransportCommands.delete(lampId);
            continue;
        }
        if (command.attempts >= 18) {
            app.log.warn({ lampId, transport: command.transport }, "Lamp transport switch was not confirmed");
            pendingTransportCommands.delete(lampId);
            continue;
        }
        if (now - command.lastSentAtMs >= 5000)
            sendPendingTransport(command);
    }
}
/** Si ya hay un comando en vuelo para la lampara, solo lo reenvia (sin nueva revision);
 * evita el bucle de realimentacion donde cada lamp_snapshot_request/heartbeat dispara una
 * revision nueva mientras el enlace serial ya esta saturado reintentando la anterior. */
function resyncLampIfNeeded(lampId) {
    const pending = pendingLampStates.get(lampId);
    if (pending) {
        gateway.sendLampState(pending.frame);
        // No resetear lastSentAtMs — dejar que la cola avance hacia el timeout
        return;
    }
    syncLampState(lampId);
}
function syncCallerLamps(deviceId) {
    for (const lampId of store.getLampIdsForCaller(deviceId))
        syncLampState(lampId);
}
function sendPendingEnd(command) {
    if (!store.getPendingCommands().some(c => c.deviceId === command.deviceId && c.kind === "end" && c.seq === command.commandSeq)) {
        store.savePendingCommand(command.deviceId, "end", command.commandSeq, { endCall: true, targetCallSeq: command.targetCallSeq });
    }
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
    store.markCommandSent(command.deviceId, "end");
}
function retryPendingEndCommands() {
    const now = Date.now();
    for (const [deviceId, command] of pendingEndCommands) {
        if (!store.getDevice(deviceId)) {
            pendingEndCommands.delete(deviceId);
            store.cancelPendingCommand(deviceId, "end");
            app.log.info({ deviceId }, "Dropped pending end for removed device");
            continue;
        }
        if (command.attempts >= MAX_PENDING_END_ATTEMPTS) {
            pendingEndCommands.delete(deviceId);
            store.cancelPendingCommand(deviceId, "end");
            app.log.info({ deviceId, attempts: command.attempts }, "Dropped unconfirmed end command");
            continue;
        }
        const interval = command.attempts < 3 ? 2000 : command.attempts < 10 ? 5000 : 30000;
        if (now - command.lastSentAtMs >= interval && gateway.isAvailable())
            sendPendingEnd(command);
    }
}
function ack(result, frame) {
    const payload = {
        msgType: "ack",
        deviceId: frame.deviceId,
        seq: frame.seq,
        result,
    };
    const state = store.getCallForDevice(frame.deviceId);
    if (state)
        Object.assign(payload, { callActive: state.active ? 1 : 0, callType: state.call_type,
            callStartedAtS: Math.floor(state.startedAtMs / 1000), callCons: state.cons, callStartSeq: state.startSeq });
    gateway.sendAck(payload);
}
async function syncToCloud(work) {
    try {
        await work();
    }
    catch (error) {
        app.log.warn({ error }, "Cloud sync failed; local state remains persisted");
    }
}
function presenceIntervalMs() {
    // Publicamos a ~2/3 de la ventana online: 90 s -> 60 s, 60 s -> 40 s.
    return Math.max(30_000, Math.min(300_000, Math.floor((store.getOnlineWindowMs() * 2) / 3)));
}
async function publishPresenceNow() {
    if (config.presenceMode === "legacy" || !firebase.isEnabled())
        return;
    const devices = store.getDevices()
        .filter(device => device.online)
        .map((device) => ({
        deviceId: device.deviceId,
        lastSeenMs: device.lastSeenMs,
        online: device.online,
    }));
    await firebase.publishPresence(devices, store.getSiteSettings().onlineWindowS);
    lastPresencePublishAt = Date.now();
}
function schedulePresencePublish(delayMs = 500, force = false) {
    if (presencePublishTimer)
        return;
    const minInterval = presenceIntervalMs();
    const elapsed = Date.now() - lastPresencePublishAt;
    const wait = force ? delayMs : Math.max(delayMs, minInterval - elapsed);
    presencePublishTimer = setTimeout(() => {
        presencePublishTimer = null;
        void publishPresenceNow();
    }, Math.max(0, wait));
    presencePublishTimer.unref?.();
}
function startSiteSettingsWatch() {
    stopSiteSettingsWatch();
    stopSiteSettingsWatch = firebase.subscribeSiteSettings((settings) => {
        const current = store.getSiteSettings();
        if (current.onlineWindowS === settings.onlineWindowS)
            return;
        store.updateSiteSettings(settings);
        schedulePresencePublish(0, true);
        scheduleSiteSection("settings");
        app.log.info({ onlineWindowS: settings.onlineWindowS }, "Site online window updated from cloud");
    });
}
function patientsReadOnly() {
    return config.patientsSource === "web" && firebase.isEnabled();
}
function startPatientsWatch() {
    stopPatientsWatch();
    if (!patientsReadOnly())
        return;
    stopPatientsWatch = firebase.subscribePatients((patient, patientId) => {
        if (!patient) {
            const removed = store.deleteCloudPatient(patientId);
            if (removed?.assignedDevice)
                syncPatient(removed.assignedDevice);
            hub.publishPatientList(store.getPatients());
            return;
        }
        const { patient: saved, previousDevice } = store.upsertCloudPatient(patient);
        if (previousDevice && previousDevice !== saved.assignedDevice)
            syncPatient(previousDevice);
        if (saved.assignedDevice)
            syncPatient(saved.assignedDevice);
        hub.publishPatientList(store.getPatients());
    }, (cloudIds) => {
        // Reconciliación inicial: retira del espejo local solo los patients source='cloud'.
        const removed = store.deleteCloudPatientsNotIn(cloudIds);
        for (const patient of removed) {
            if (patient.assignedDevice)
                syncPatient(patient.assignedDevice);
        }
        if (removed.length > 0) {
            hub.publishPatientList(store.getPatients());
            app.log.info({ removed: removed.length }, "Cloud patient mirror reconciled");
        }
    });
}
function buildSiteSection(section) {
    if (section === "devices") {
        return {
            items: store.getDevices().map(device => ({
                deviceId: device.deviceId,
                name: device.name ?? "",
                callerLocationType: device.callerLocationType,
                online: device.online,
                lastSeenMs: device.lastSeenMs,
                firmwareVersion: device.firmwareVersion ?? "",
                transport: device.transport ?? "",
            })),
        };
    }
    if (section === "lamps") {
        return {
            items: store.getLamps(),
            callers: store.getDevices().map(device => ({
                deviceId: device.deviceId,
                name: device.name ?? "",
                lampIds: store.getLampIdsForCaller(device.deviceId),
            })),
            alertProfiles: store.getLampAlertProfiles(),
            specialProfiles: Object.fromEntries(SPECIAL_CALL_TYPES.map(callType => [callType, store.getLampIdsForSpecialProfile(callType)])),
        };
    }
    if (section === "settings") {
        const integrationSettings = getIntegrationSettings();
        return {
            site: store.getSiteSettings(),
            location: store.getLocationSettings(),
            presence: store.getPresenceSettings(),
            integration: {
                locationId: integrationSettings.locationId,
                firebaseProjectId: integrationSettings.firebaseProjectId,
                localOnly: !firebase.isEnabled(),
                hasServiceAccount: integrationSettings.hasServiceAccount,
                lastError: firebase.getLastError(),
            },
            sounds: listSoundFiles(),
        };
    }
    if (section === "presence") {
        const sensors = store.getPresenceSensors();
        return { sensors, states: sensors.map(sensor => presenceSensorState(sensor)) };
    }
    return {};
}
async function publishSiteSectionNow(section) {
    if (!firebase.isEnabled())
        return;
    try {
        await firebase.publishSiteSection(section, buildSiteSection(section));
    }
    catch (error) {
        app.log.warn({ error, section }, "Could not publish site section");
    }
}
function scheduleSiteSection(section, delayMs = 800) {
    if (!firebase.isEnabled())
        return;
    dirtySiteSections.add(section);
    if (sectionPublishTimer)
        return;
    sectionPublishTimer = setTimeout(() => {
        sectionPublishTimer = null;
        const sections = Array.from(dirtySiteSections);
        dirtySiteSections.clear();
        for (const dirty of sections)
            void publishSiteSectionNow(dirty);
    }, delayMs);
    sectionPublishTimer.unref?.();
}
async function publishAllSiteSections() {
    for (const section of ["settings", "devices", "lamps", "presence"]) {
        await publishSiteSectionNow(section);
    }
}
function validateDeviceName(name) {
    if (typeof name !== "string")
        throw new Error("Nombre requerido");
    const value = name.trim();
    if (!value || Buffer.byteLength(value, "utf8") > 32 || /[,\r\n]/.test(value)) {
        throw new Error("Nombre requerido, máximo 32 bytes UTF-8 y sin comas ni saltos de línea");
    }
    return value;
}
async function handleSiteCommand(type, payload) {
    switch (type) {
        case "device.rename": {
            const deviceId = String(payload.deviceId ?? "");
            const name = validateDeviceName(payload.name);
            const device = store.updateDeviceName(deviceId, name);
            if (!device)
                throw new Error("Llamador no encontrado");
            hub.publishDeviceList(store.getDevices());
            queueDeviceName(deviceId, name);
            scheduleSiteSection("devices");
            scheduleSiteSection("presence");
            return "Llamador renombrado";
        }
        case "device.update": {
            const deviceId = String(payload.deviceId ?? "");
            if (!store.getDevice(deviceId))
                throw new Error("Llamador no encontrado");
            let device = store.getDevice(deviceId);
            if (payload.name !== undefined) {
                const name = validateDeviceName(payload.name);
                device = store.updateDeviceName(deviceId, name) ?? device;
                queueDeviceName(deviceId, name);
            }
            if (payload.callerLocationType !== undefined) {
                const value = String(payload.callerLocationType);
                if (!["cama", "sillon", "bano"].includes(value))
                    throw new Error("Tipo de ubicación inválido");
                device = store.updateDeviceLocationType(deviceId, value) ?? device;
            }
            hub.publishDeviceList(store.getDevices());
            scheduleSiteSection("devices");
            scheduleSiteSection("presence");
            return "Llamador actualizado";
        }
        case "device.setLocationType": {
            const deviceId = String(payload.deviceId ?? "");
            const value = String(payload.callerLocationType ?? "");
            if (!["cama", "sillon", "bano"].includes(value))
                throw new Error("Tipo de ubicación inválido");
            const device = store.updateDeviceLocationType(deviceId, value);
            if (!device)
                throw new Error("Llamador no encontrado");
            hub.publishDeviceList(store.getDevices());
            scheduleSiteSection("devices");
            return "Tipo de ubicación actualizado";
        }
        case "device.setLamps": {
            const deviceId = String(payload.deviceId ?? "");
            if (!store.getDevice(deviceId))
                throw new Error("Llamador no encontrado");
            const lampIds = Array.isArray(payload.lampIds) ? payload.lampIds.map(String) : [];
            const previous = store.getLampIdsForCaller(deviceId);
            const next = store.setLampAssignments(deviceId, lampIds);
            for (const lampId of new Set([...previous, ...next]))
                syncLampState(lampId);
            hub.publishLampAssignments(deviceId, next);
            scheduleSiteSection("lamps");
            return "Asignación de lámparas actualizada";
        }
        case "lamp.update": {
            const lampId = String(payload.lampId ?? "");
            const lamp = store.updateLamp(lampId, {
                ...(payload.name !== undefined ? { name: String(payload.name) } : {}),
                ...(payload.audioEnabled !== undefined ? { audioEnabled: Boolean(payload.audioEnabled) } : {}),
                ...(payload.brightness !== undefined ? { brightness: Number(payload.brightness) } : {}),
                ...(payload.buzzerVolume !== undefined ? { buzzerVolume: Number(payload.buzzerVolume) } : {}),
            });
            if (!lamp)
                throw new Error("Lámpara no encontrada");
            hub.publishLampList(store.getLamps());
            syncLampState(lamp.lampId);
            scheduleSiteSection("lamps");
            return "Lámpara actualizada";
        }
        case "lamp.setTransport": {
            const lampId = String(payload.lampId ?? "");
            const transport = payload.transport === "lora" ? "lora" : payload.transport === "espnow" ? "espnow" : null;
            if (!transport)
                throw new Error("Transporte inválido");
            const lamp = store.getLamp(lampId);
            if (!lamp)
                throw new Error("Lámpara no encontrada");
            if (!gateway.isAvailable())
                throw new Error("Gateway serial no conectado");
            if (transport === lamp.transport && !lamp.pendingTransport)
                return "Sin cambios";
            store.requestLampTransport(lampId, transport);
            const command = { lampId, transport, attempts: 0, lastSentAtMs: 0 };
            pendingTransportCommands.set(lampId, command);
            sendPendingTransport(command);
            hub.publishLampList(store.getLamps());
            scheduleSiteSection("lamps");
            return "Transporte solicitado";
        }
        case "lamp.test": {
            const lampId = String(payload.lampId ?? "");
            performLampTest(lampId, payload.state === undefined ? undefined : String(payload.state), payload.durationMs === undefined ? undefined : Number(payload.durationMs));
            return "Prueba enviada";
        }
        case "lamp.delete": {
            const lampId = String(payload.lampId ?? "");
            if (!store.deleteLamp(lampId))
                throw new Error("Lámpara no encontrada");
            hub.publishLampList(store.getLamps());
            scheduleSiteSection("lamps");
            return "Lámpara eliminada";
        }
        case "alertProfile.update": {
            const callType = String(payload.callType ?? "");
            const profile = store.updateLampAlertProfile(callType, {
                ...(payload.label !== undefined ? { label: String(payload.label) } : {}),
                ...(payload.enabled !== undefined ? { enabled: Boolean(payload.enabled) } : {}),
                ...(payload.colorPreset !== undefined ? { colorPreset: Number(payload.colorPreset) } : {}),
                ...(payload.animationPreset !== undefined ? { animationPreset: Number(payload.animationPreset) } : {}),
                ...(payload.soundPreset !== undefined ? { soundPreset: Number(payload.soundPreset) } : {}),
                ...(payload.audioEnabled !== undefined ? { audioEnabled: Boolean(payload.audioEnabled) } : {}),
                ...(payload.autoEndS !== undefined ? { autoEndS: Number(payload.autoEndS) } : {}),
            });
            if (!profile)
                throw new Error("Perfil no encontrado");
            for (const lamp of store.getLamps())
                syncLampState(lamp.lampId);
            scheduleSiteSection("lamps");
            return "Perfil actualizado";
        }
        case "specialProfile.setLamps": {
            const callType = String(payload.callType ?? "");
            if (!isSpecialCallType(callType))
                throw new Error("Tipo especial inválido");
            const lampIds = Array.isArray(payload.lampIds) ? payload.lampIds.map(String) : [];
            store.setLampAssignmentsForSpecialProfile(callType, lampIds);
            syncSpecialProfileLamps();
            scheduleSiteSection("lamps");
            return "Lámparas del perfil especial actualizadas";
        }
        case "locationSettings.update": {
            const body = { ...(payload ?? {}) };
            if (body.alertSound !== undefined && !isPlayableSound(body.alertSound)) {
                throw new Error("El sonido normal seleccionado no existe en la sede local");
            }
            if (body.emergencySound !== undefined && !isPlayableSound(body.emergencySound)) {
                throw new Error("El sonido de emergencia seleccionado no existe en la sede local");
            }
            const settings = store.updateLocationSettings(body);
            hub.publishLocationSettings(settings);
            scheduleSiteSection("settings");
            return "Pantalla de sala actualizada";
        }
        case "presenceSensor.set": {
            const deviceId = String(payload.deviceId ?? "");
            const device = store.getDevice(deviceId);
            if (!device)
                throw new Error("Llamador no encontrado");
            const requestedRole = String(payload.role ?? "").trim();
            if (!requestedRole) {
                if (presenceRuntime.get(deviceId)?.sessionId)
                    closePresenceRuntimeSession(deviceId, Date.now(), "sensor_removed");
                presenceRuntime.delete(deviceId);
                store.deletePresenceSensor(deviceId);
                scheduleSiteSection("presence");
                return "Presencia desactivada";
            }
            const role = requestedRole === "sillon" ? "sillon"
                : (requestedRole === "cama" || requestedRole === "bed") ? "cama"
                    : (requestedRole === "bathroom" || requestedRole === "bano") ? "bathroom"
                        : null;
            if (!role)
                throw new Error("Rol de presencia inválido");
            store.upsertPresenceSensor(deviceId, role, device.name || deviceId, payload.enabled !== false);
            publishPresenceState(deviceId);
            scheduleSiteSection("presence");
            return "Presencia actualizada";
        }
        case "presenceSettings.update": {
            const body = { ...(payload ?? {}) };
            if (body.detectionSound !== undefined && !isPlayableSound(body.detectionSound)) {
                throw new Error("El sonido de detección seleccionado no existe en la sede local");
            }
            const settings = store.updatePresenceSettings(body);
            if (!settings.enabled) {
                for (const [deviceId, runtime] of presenceRuntime) {
                    if (runtime.sessionId)
                        closePresenceRuntimeSession(deviceId, Date.now(), "disabled");
                }
            }
            hub.publishPresenceSettings(settings);
            scheduleSiteSection("settings");
            scheduleSiteSection("presence");
            return "Presencia actualizada";
        }
        case "siteSettings.update": {
            const onlineWindowS = Number(payload.onlineWindowS);
            if (!Number.isFinite(onlineWindowS) || onlineWindowS < 60 || onlineWindowS > 600) {
                throw new Error("onlineWindowS debe estar entre 60 y 600 segundos");
            }
            store.updateSiteSettings({ onlineWindowS });
            schedulePresencePublish(0, true);
            scheduleSiteSection("settings");
            return "Ventana online actualizada";
        }
        case "call.end": {
            const deviceId = String(payload.deviceId ?? "");
            const requestedType = payload.callType === undefined ? undefined : String(payload.callType);
            const callType = requestedType === "normal" || requestedType === "emergency" || (requestedType && isSpecialCallType(requestedType))
                ? requestedType
                : undefined;
            if (!deviceId)
                throw new Error("Llamador requerido");
            if (!finalizeActiveCall(deviceId, callType))
                throw new Error("No hay llamado activo para finalizar");
            return "Llamado finalizado";
        }
        default:
            throw new Error(`Comando no soportado: ${type}`);
    }
}
async function applySiteCommand(commandId, type, payload) {
    try {
        const result = await handleSiteCommand(type, payload);
        await firebase.markSiteCommand(commandId, "applied", result);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.log.warn({ commandId, type, error: message }, "Site command rejected");
        await firebase.markSiteCommand(commandId, "rejected", message);
    }
}
function startSiteCommandsWatch() {
    stopSiteCommandsWatch();
    stopSiteCommandsWatch = firebase.subscribeSiteCommands((commandId, type, payload) => {
        void applySiteCommand(commandId, type, payload);
    });
}
async function saveHistoryToCloud(record) {
    if (config.historyWriter !== "local" || !firebase.isEnabled())
        return;
    // Los especiales no se mezclan con care_history: tendrán su propio historial.
    if (isSpecialCallType(record.call_type))
        return;
    const device = store.getDevice(record.deviceId);
    const settings = store.getLocationSettings();
    await firebase.saveCallHistory(record, {
        deviceName: device?.name,
        locationName: settings.name,
        attentionTimeMin: settings.attentionTimeMin,
    });
}
async function flushCloudOutbox() {
    if (!config.outboxEnabled || !firebase.isEnabled() || outboxFlushInFlight)
        return;
    outboxFlushInFlight = true;
    try {
        const items = store.getDueCloudWrites(25);
        for (const item of items) {
            try {
                await firebase.writeQueued(item.kind, item.docId, item.payload, item.deleteFields);
                store.markCloudWriteDone(item.id);
            }
            catch {
                store.markCloudWriteFailed(item.id, item.attempts + 1);
            }
        }
    }
    finally {
        outboxFlushInFlight = false;
    }
}
// Device IDs de llamadores son 12 hex chars del MAC efuse. Un ID corto
// (p.ej. C81A32D18) es un fantasma: el mismo MAC con los primeros bytes
// perdidos. Normalizar contra devices conocidos por MAC o por sufijo.
const DEVICE_ID_HEX = /^[0-9A-F]{12}$/i;
const MAC_HEX = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;
function normalizeCallerDeviceId(frame) {
    const raw = frame.deviceId;
    if (!raw || DEVICE_ID_HEX.test(raw))
        return raw || null;
    // Si srcMac coincide con un device conocido, usar su ID completo.
    if (frame.srcMac && MAC_HEX.test(frame.srcMac)) {
        const mac = frame.srcMac.toUpperCase();
        const byMac = store.getDevices().find((d) => (d.mac ?? "").toUpperCase() === mac && DEVICE_ID_HEX.test(d.deviceId));
        if (byMac)
            return byMac.deviceId;
    }
    // Si el ID corto es sufijo de un device conocido, usar el completo.
    const bySuffix = store.getDevices().find((d) => DEVICE_ID_HEX.test(d.deviceId) && d.deviceId.toUpperCase().endsWith(raw.toUpperCase()));
    if (bySuffix)
        return bySuffix.deviceId;
    // Sin coincidencia: rechazar para no crear fantasmas.
    return null;
}
async function handleFrame(frame) {
    const incomingSeq = frame?.seq ?? frame?.commandSeq;
    if (!frame || typeof frame.msgType !== "string" || !/^[0-9A-Za-z-]{1,64}$/.test(frame.lampId || frame.deviceId || "") || !Number.isInteger(incomingSeq) || incomingSeq < 0 || incomingSeq > 0xFFFFFFFF) {
        store.incrementReliability("malformed");
        return;
    }
    // Normalizar deviceId de llamadores antes de tocar el store.
    if (!frame.msgType.startsWith("lamp_") && frame.deviceId && !DEVICE_ID_HEX.test(frame.deviceId)) {
        const canonical = normalizeCallerDeviceId(frame);
        if (!canonical) {
            app.log.warn({ deviceId: frame.deviceId, msgType: frame.msgType, srcMac: frame.srcMac }, "Rejected malformed caller deviceId (ghost)");
            if (frame.msgType !== "heartbeat")
                ack("invalid", frame);
            return;
        }
        if (canonical !== frame.deviceId) {
            app.log.info({ from: frame.deviceId, to: canonical, msgType: frame.msgType }, "Normalized truncated deviceId to canonical");
            frame.deviceId = canonical;
        }
    }
    if (frame.msgType === "config_ack" && frame.configResult === 1)
        store.confirmPendingCommand(frame.deviceId, frame.seq);
    // La lampara transmite un heartbeat de presencia generico (msgType=4) para que otros
    // nodos la detecten como relay; si el deviceId ya es una lampara conocida, ignorarlo aqui
    // para no registrarla tambien como llamador fantasma en la tabla de dispositivos.
    if (!frame.msgType.startsWith("lamp_") && frame.deviceId && store.getLamp(frame.deviceId)) {
        if (frame.msgType === "heartbeat" && (frame.source === "lora" || frame.source === "espnow")) {
            const previousLamp = store.getLamp(frame.deviceId);
            const touchedLamp = store.touchLamp(frame.deviceId, frame.srcMac, undefined, undefined, frame.source);
            if (!touchedLamp.pendingTransport)
                pendingTransportCommands.delete(frame.deviceId);
            if (previousLamp && previousLamp.online !== touchedLamp.online)
                scheduleSiteSection("lamps");
            hub.publishLampList(store.getLamps());
        }
        return;
    }
    if (frame.msgType.startsWith("lamp_")) {
        const lampId = frame.lampId ?? "";
        if (!lampId)
            return;
        const stateByCode = ["off", "normal", "emergency"];
        if (frame.msgType === "lamp_register") {
            const existingLamp = store.getLamp(lampId);
            const registeredLamp = store.registerLamp(lampId, frame.srcMac ?? "", frame.relayCapable ?? true, frame.protocolVersion ?? 1, frame.initialName?.trim() || undefined, (frame.source === "lora" ? "lora" : "espnow"));
            if (!registeredLamp.pendingTransport)
                pendingTransportCommands.delete(lampId);
            gateway.sendLampSessionAck({
                msgType: "lamp_session_ack",
                lampId,
                seq: frame.seq,
                result: existingLamp ? "duplicate" : "ok",
            });
            syncLampState(lampId);
            scheduleSiteSection("lamps");
        }
        else if (frame.msgType === "lamp_heartbeat" || frame.msgType === "lamp_state_ack" || frame.msgType === "lamp_test_ack") {
            const existingLamp = store.getLamp(lampId);
            if (!existingLamp) {
                if (frame.msgType === "lamp_heartbeat") {
                    gateway.sendLampSessionAck({ msgType: "lamp_session_ack", lampId, seq: frame.seq, result: "invalid" });
                }
                return;
            }
            const appliedState = stateByCode[frame.appliedState ?? 0] ?? "off";
            const observedTransport = frame.source === "lora" || frame.source === "espnow" ? frame.source : undefined;
            const touchedLamp = store.touchLamp(lampId, frame.srcMac, frame.appliedRevision ?? frame.stateRevision, appliedState, observedTransport);
            if (!touchedLamp.pendingTransport)
                pendingTransportCommands.delete(lampId);
            if (existingLamp.online !== touchedLamp.online)
                scheduleSiteSection("lamps");
            if (frame.msgType === "lamp_heartbeat") {
                gateway.sendLampSessionAck({ msgType: "lamp_session_ack", lampId, seq: frame.seq, result: "ok" });
            }
            const pending = pendingLampStates.get(lampId);
            if (frame.msgType === "lamp_state_ack" && pending && frame.stateRevision === pending.frame.stateRevision &&
                (frame.result === 1 || frame.result === 2)) {
                pendingLampStates.delete(lampId);
            }
            // Aceptar lamp_heartbeat como confirmación si muestra el estado correcto
            if (pending && frame.msgType === "lamp_heartbeat" &&
                (frame.appliedState ?? 0) === pending.frame.effectiveState &&
                (frame.appliedRevision ?? 0) >= pending.frame.stateRevision) {
                pendingLampStates.delete(lampId);
            }
            if (frame.msgType === "lamp_heartbeat" && frame.appliedState !== lampStateCode(store.getEffectiveLampState(lampId))) {
                resyncLampIfNeeded(lampId);
            }
        }
        else if (frame.msgType === "lamp_snapshot_request") {
            if (!store.getLamp(lampId)) {
                gateway.sendLampSessionAck({ msgType: "lamp_session_ack", lampId, seq: frame.seq, result: "invalid" });
                return;
            }
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
    // REGISTER es idempotente: crea el dispositivo una sola vez y, para clientes
    // antiguos que lo reenvien, solo actualiza su presencia y ruta.
    if (frame.msgType === "register") {
        const existingDevice = store.getDevice(frame.deviceId);
        const existingCall = store.getActiveCallForDevice(frame.deviceId);
        const transport = frame.source === "lora" || frame.source === "espnow" ? frame.source : undefined;
        const reportedName = frame.initialName?.trim() || undefined;
        let device = store.registerDevice(frame.deviceId, frame.srcMac ?? "", reportedName, transport, frame.firmwareVersion);
        // Nombre reportado por el dispositivo (provisionado desde Admin-llamadores):
        // si difiere del guardado y NO hay renombrado pendiente hacia el device,
        // el nombre del dispositivo gana. Asi el locationName de Admin queda fijo.
        const pendingRenames = store.getPendingCommands()
            .filter((c) => c.deviceId === frame.deviceId && c.kind === "name");
        if (reportedName && device.name && device.name !== reportedName && pendingRenames.length === 0) {
            const renamed = store.updateDeviceName(frame.deviceId, reportedName);
            if (renamed) {
                device = renamed;
                hub.publishDeviceList(store.getDevices());
                void syncToCloud(async () => { await firebase.upsertDevice(renamed); });
                schedulePresencePublish();
            }
        }
        else if (device.name && device.name !== reportedName) {
            queueDeviceName(device.deviceId, device.name);
        }
        if (existingCall) {
            // Terminal se reinicio con llamado activo: conservar el llamado y pedirle que retome
            hub.publishActiveCalls(store.getActiveCalls());
            hub.publishDeviceList(store.getDevices());
            const resumeAck = {
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
            });
            schedulePresencePublish(0, true);
        }
        else {
            ack("ok", frame);
            void syncToCloud(async () => {
                await firebase.upsertDevice(device);
            });
            schedulePresencePublish(0, true);
            hub.publishDeviceList(store.getDevices());
        }
        if (!existingDevice)
            hub.publishDeviceRegistered(device);
        if (store.getPatientByDevice(frame.deviceId) || isTactileFirmware(device.firmwareVersion))
            syncPatient(frame.deviceId);
        scheduleSiteSection("devices");
        return;
    }
    if (frame.msgType === "config_ack") {
        if (frame.configResult === 1)
            store.confirmPendingCommand(frame.deviceId, frame.seq);
        if (frame.configResult === 1 && pendingPatients.get(frame.deviceId)?.seq === frame.seq)
            pendingPatients.delete(frame.deviceId);
        const pending = pendingEndCommands.get(frame.deviceId);
        if (pending && pending.commandSeq === frame.seq && frame.configResult === 1) {
            pendingEndCommands.delete(frame.deviceId);
            confirmedEndCalls.set(frame.deviceId, pending.targetCallSeq);
            app.log.info({ deviceId: frame.deviceId, commandSeq: frame.seq }, "Remote end confirmed by device");
        }
        return;
    }
    if (frame.msgType === "presence") {
        const presenceDetected = (frame.presenceState ?? 0) > 0;
        devicePresence.set(frame.deviceId, presenceDetected);
        const callerLamps = store.getLampIdsForCaller(frame.deviceId);
        console.log(`[PRESENCE] deviceId=${frame.deviceId} state=${presenceDetected ? "DETECTED" : "NONE"} lamps=${JSON.stringify(callerLamps)} devicePresenceMap=${JSON.stringify(Object.fromEntries(devicePresence))}`);
        syncCallerLamps(frame.deviceId);
        handlePresenceMonitor(frame.deviceId, presenceDetected, Date.now());
        return;
    }
    // Un heartbeat valida una sesion existente, pero nunca crea el alta. El
    // resultado invalid indica al firmware que debe ejecutar REGISTER una vez.
    if (frame.msgType === "heartbeat" && !store.getDevice(frame.deviceId)) {
        ack("invalid", frame);
        return;
    }
    switch (frame.msgType) {
        case "call_start":
        case "call_insist": {
            const cons = Number(frame.cons ?? 1);
            if (!Number.isInteger(cons) || cons < 1 || cons > 65535 || (frame.callId !== undefined && (!Number.isInteger(frame.callId) || frame.callId < 0 || frame.callId > 0xFFFFFFFF))) {
                ack("invalid", frame);
                return;
            }
            const incoming = frame.call_type ?? "normal";
            const callType = (incoming === "emergency" || isSpecialCallType(incoming)) ? incoming : "normal";
            const received = store.receiveCallEvent(frame, () => {
                const next = store.applyCallStart(frame.deviceId, frame.seq, cons, callType);
                if (!isSpecialCallType(callType))
                    store.cancelPendingCommand(frame.deviceId, "end");
                return next;
            });
            if (received.result !== "ok") {
                ack(received.result, frame);
                return;
            }
            const next = received.value;
            if (!isSpecialCallType(callType)) {
                pendingEndCommands.delete(frame.deviceId);
                confirmedEndCalls.delete(frame.deviceId);
            }
            const device = store.touchDevice(frame.deviceId, frame.srcMac);
            publishDevicePresence(device);
            hub.publishCallState(store.withPatientName(next));
            hub.publishActiveCalls(store.getActiveCalls());
            ack("ok", frame);
            syncCallerLamps(frame.deviceId);
            // Especiales independientes por (dispositivo, tipo): nada se pisa, pero las
            // lámparas de los perfiles con especial activo deben refrescarse (la nueva
            // puede ser la primera de su tipo).
            syncSpecialProfileLamps();
            void syncToCloud(async () => {
                await firebase.upsertCalled(next);
                await firebase.updateDeviceIfChanged(device, { lastCallAtMs: next.startedAtMs });
            });
            schedulePresencePublish();
            return;
        }
        case "call_end": {
            // El capacitivo no trackea especiales: por defecto CALL_END cierra solo
            // la llamada normal/emergencia del dispositivo. Si un frame viniera con un
            // tipo especial explícito, además se cierra ese especial puntual.
            const explicitSpecial = frame.call_type && isSpecialCallType(frame.call_type) ? frame.call_type : undefined;
            const received = store.receiveCallEvent(frame, () => {
                const ended = store.applyCallEnd(frame.deviceId, frame.seq);
                store.cancelPendingCommand(frame.deviceId, "end");
                return ended;
            });
            if (received.result !== "ok") {
                ack(received.result, frame);
                return;
            }
            const { state: next, historyRecord } = received.value;
            pendingEndCommands.delete(frame.deviceId);
            confirmedEndCalls.set(frame.deviceId, next.startSeq);
            const device = store.touchDevice(frame.deviceId, frame.srcMac);
            publishDevicePresence(device);
            hub.publishCallState(store.withPatientName(next));
            hub.publishActiveCalls(store.getActiveCalls());
            if (historyRecord)
                hub.publishCallHistory(store.getCallHistory());
            ack("ok", frame);
            syncCallerLamps(frame.deviceId);
            if (explicitSpecial) {
                const special = store.applySpecialCallEnd(frame.deviceId, explicitSpecial, frame.seq);
                if (special) {
                    hub.publishActiveCalls(store.getActiveCalls());
                    if (special.historyRecord)
                        hub.publishCallHistory(store.getCallHistory());
                    syncSpecialProfileLamps([explicitSpecial]);
                    void syncToCloud(async () => {
                        await firebase.upsertCalled(special.state);
                        if (special.historyRecord)
                            await saveHistoryToCloud(special.historyRecord);
                    });
                }
            }
            void syncToCloud(async () => {
                await firebase.upsertCalled(next);
                await firebase.updateDeviceIfChanged(device);
                if (historyRecord)
                    await saveHistoryToCloud(historyRecord);
            });
            schedulePresencePublish();
            return;
        }
        case "heartbeat": {
            // Heartbeats comparten el contador de radio, pero no representan eventos
            // de llamada. No avanzar seq_tracker: un heartbeat posterior no debe
            // convertir en "antigua" una llamada pendiente que se esta reintentando.
            const device = store.touchDevice(frame.deviceId, frame.srcMac);
            publishDevicePresence(device);
            const callState = store.getCallForDevice(frame.deviceId);
            if (callState && !callState.active && callState.startSeq > 0 &&
                confirmedEndCalls.get(frame.deviceId) !== callState.startSeq &&
                !pendingEndCommands.has(frame.deviceId)) {
                const command = {
                    deviceId: frame.deviceId,
                    commandSeq: nextRemoteCommandSeq(),
                    targetCallSeq: callState.startSeq,
                    attempts: 0,
                    lastSentAtMs: 0,
                };
                pendingEndCommands.set(frame.deviceId, command);
                sendPendingEnd(command);
            }
            const heartbeatAck = {
                msgType: "ack",
                deviceId: frame.deviceId,
                seq: frame.seq,
                result: "ok",
                callActive: callState?.active ? 1 : 0,
                callType: callState?.call_type ?? "normal",
                callStartedAtS: callState?.active ? Math.floor(callState.startedAtMs / 1000) : 0,
                callCons: callState?.active ? callState.cons : 0,
                callStartSeq: callState?.active ? callState.startSeq : 0,
            };
            gateway.sendAck(heartbeatAck);
            // Los heartbeats actualizan lastSeen en SQLite, pero ya no escriben en
            // Firestore: la presencia agregada por sede se publica periódicamente.
            void syncToCloud(async () => {
                await firebase.updateDeviceIfChanged(device);
            });
            return;
        }
        default:
            ack("invalid", frame);
    }
}
const startedAtMs = Date.now();
function loadSystemVersion() {
    const base = dirname(fileURLToPath(import.meta.url));
    const fallback = {
        name: "clinum-web-local-server",
        version: "unknown",
        commit: "unknown",
        branch: "unknown",
        dirty: false,
        builtAt: "unknown",
        node: process.version,
    };
    try {
        const fromBuild = JSON.parse(readFileSync(join(base, "version.json"), "utf8"));
        return { ...fallback, ...fromBuild };
    }
    catch {
        // dist/version.json no existe (build sin prebuild): seguimos con package.json
    }
    try {
        const pkg = JSON.parse(readFileSync(join(base, "..", "package.json"), "utf8"));
        return { ...fallback, name: pkg.name ?? fallback.name, version: pkg.version ?? fallback.version };
    }
    catch {
        return fallback;
    }
}
const systemVersion = loadSystemVersion();
function uptimeSeconds() {
    return Math.round((Date.now() - startedAtMs) / 1000);
}
app.get("/api/version", async () => ({
    ...systemVersion,
    startedAt: startedAtMs,
    uptimeSeconds: uptimeSeconds(),
}));
app.get("/health", async () => ({
    ok: true,
    ts: Date.now(),
    firebaseEnabled: firebase.isEnabled(),
    firebaseCounters: firebase.getCounters(),
    outbox: store.getCloudOutboxStats(),
    presenceMode: config.presenceMode,
    historyWriter: config.historyWriter,
    outboxEnabled: config.outboxEnabled,
    patientsSource: config.patientsSource,
    patientsReadOnly: patientsReadOnly(),
    onlineWindowS: store.getSiteSettings().onlineWindowS,
    tls: tlsActive,
    serialPort: config.serialPort,
    version: systemVersion.version,
    commit: systemVersion.commit,
    uptimeSeconds: uptimeSeconds(),
}));
app.get("/network/diagnostics", async () => ({ counters: store.getReliabilityCounters(),
    pendingCommands: store.getPendingCommands(), pendingPatients: pendingPatients.size, serialAvailable: gateway.isAvailable(), gateway: gatewayControlState,
    outbox: store.getCloudOutboxStats(), firebaseCounters: firebase.getCounters() }));
app.delete("/network/pending-commands", async () => {
    const cleared = store.clearPendingCommands();
    pendingEndCommands.clear();
    return { ok: true, cleared };
});
app.delete("/network/outbox", async () => {
    const cleared = store.clearCloudOutbox();
    return { ok: true, cleared };
});
app.get("/gateway/status", async () => gatewayControlState);
app.put("/gateway/config", async (req, reply) => {
    const requested = req.body;
    const validIdentifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(value);
    const nowEnabled = requested?.espnow?.enabled === true;
    const loraEnabled = requested?.lora?.enabled === true;
    const valid = validIdentifier(requested?.siteId) && validIdentifier(requested?.gatewayId) &&
        (requested?.opMode === undefined || requested?.opMode === "local" || requested?.opMode === "test") &&
        (nowEnabled || loraEnabled) &&
        (!nowEnabled || Number.isInteger(requested.espnow.channel) && requested.espnow.channel >= 1 && requested.espnow.channel <= 13) &&
        (!loraEnabled || Number.isInteger(requested.lora.address) && requested.lora.address >= 1 && requested.lora.address < 0xffff) &&
        (!loraEnabled || Number.isInteger(requested.lora.networkId) && requested.lora.networkId >= 3 && requested.lora.networkId <= 15) &&
        (!loraEnabled || Number.isInteger(requested.lora.frequency) && requested.lora.frequency >= 902000000 && requested.lora.frequency <= 928000000) &&
        (!loraEnabled || Number.isInteger(requested.lora.spreadingFactor) && requested.lora.spreadingFactor >= 7 && requested.lora.spreadingFactor <= 12) &&
        (!loraEnabled || Number.isInteger(requested.lora.bandwidth) && requested.lora.bandwidth >= 7 && requested.lora.bandwidth <= 9) &&
        (!loraEnabled || Number.isInteger(requested.lora.codingRate) && requested.lora.codingRate >= 1 && requested.lora.codingRate <= 4) &&
        (!loraEnabled || Number.isInteger(requested.lora.preamble) && requested.lora.preamble >= 4 && requested.lora.preamble <= 24) &&
        (!loraEnabled || Number.isInteger(requested.lora.txPowerDbm) && requested.lora.txPowerDbm >= 0 && requested.lora.txPowerDbm <= 22);
    if (!valid)
        return reply.status(400).send({ error: "Invalid gateway site configuration" });
    if (!gateway.sendGatewayConfig(requested)) {
        return reply.status(503).send({ error: "Gateway serial connection is not available" });
    }
    return reply.status(202).send({ accepted: true, state: "restarting" });
});
app.get("/devices", async () => ({ items: store.getDevices() }));
app.get("/lamps", async () => ({ items: store.getLamps() }));
app.get("/lamp-alert-profiles", async () => ({ items: store.getLampAlertProfiles() }));
app.get("/location-settings", async () => store.getLocationSettings());
app.get("/site-settings", async () => store.getSiteSettings());
app.patch("/site-settings", async (req, reply) => {
    const requested = Number(req.body?.onlineWindowS);
    if (!Number.isFinite(requested) || requested < 60 || requested > 600) {
        return reply.status(400).send({ error: "onlineWindowS debe estar entre 60 y 600 segundos" });
    }
    const settings = store.updateSiteSettings({ onlineWindowS: requested });
    schedulePresencePublish(0, true);
    scheduleSiteSection("settings");
    return settings;
});
app.patch("/location-settings", async (req) => {
    const body = { ...(req.body ?? {}) };
    if (body.alertSound !== undefined && !isPlayableSound(body.alertSound))
        delete body.alertSound;
    if (body.emergencySound !== undefined && !isPlayableSound(body.emergencySound))
        delete body.emergencySound;
    const settings = store.updateLocationSettings(body);
    hub.publishLocationSettings(settings);
    scheduleSiteSection("settings");
    return settings;
});
app.get("/integration-settings", async () => ({ ...getIntegrationSettings(), localOnly: !firebase.isEnabled(), lastError: firebase.getLastError() }));
app.patch("/integration-settings", async (req, reply) => {
    try {
        const body = req.body ?? {};
        const current = getIntegrationSettings();
        const requestedLocationId = body.locationId;
        const nextLocationId = String(requestedLocationId !== undefined ? requestedLocationId : current.locationId ?? "").trim();
        const nextLocalOnly = body.localOnly !== undefined ? body.localOnly : current.localOnly;
        if (!nextLocalOnly && !nextLocationId) {
            return reply.status(400).send({ error: "Asigna el ID de la sede antes de activar el sync." });
        }
        const settings = updateIntegrationSettings(body);
        // Aplica en caliente: activar/desactivar sync y cambiar de sede no requieren reiniciar.
        // Cambiar de proyecto Firebase sí (el SDK de Admin ya quedó atado al proyecto inicial).
        firebase.setLocationId(settings.locationId);
        firebase.setEnabled(!settings.localOnly);
        // Reinicia la escucha de site_settings y publica presencia con la nueva sede.
        startSiteSettingsWatch();
        startPatientsWatch();
        startSiteCommandsWatch();
        schedulePresencePublish(0, true);
        void publishAllSiteSections();
        const projectChanged = settings.firebaseProjectId !== config.firebaseProjectId;
        return { ...settings, localOnly: !firebase.isEnabled(), restartRequired: projectChanged, lastError: firebase.getLastError() };
    }
    catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : "No se pudo guardar la configuración" });
    }
});
app.patch("/lamp-alert-profiles/:callType", async (req, reply) => {
    const profile = store.updateLampAlertProfile(req.params.callType, req.body ?? {});
    if (!profile)
        return reply.status(404).send({ error: "Alert profile not found" });
    for (const lamp of store.getLamps())
        syncLampState(lamp.lampId);
    scheduleSiteSection("lamps");
    return profile;
});
// ── Lámparas designadas por perfil de llamado especial ──────────────────────
app.get("/lamp-alert-profiles/:callType/lamps", async (req, reply) => {
    if (!isSpecialCallType(req.params.callType))
        return reply.status(400).send({ error: "Not a special call type" });
    return { items: store.getLampIdsForSpecialProfile(req.params.callType) };
});
app.put("/lamp-alert-profiles/:callType/lamps", async (req, reply) => {
    if (!isSpecialCallType(req.params.callType))
        return reply.status(400).send({ error: "Not a special call type" });
    const lampIds = Array.isArray(req.body?.lampIds) ? req.body.lampIds : [];
    store.setLampAssignmentsForSpecialProfile(req.params.callType, lampIds);
    syncSpecialProfileLamps();
    scheduleSiteSection("lamps");
    return { ok: true, items: store.getLampIdsForSpecialProfile(req.params.callType) };
});
app.patch("/lamps/:id", async (req, reply) => {
    const lamp = store.updateLamp(req.params.id, req.body ?? {});
    if (!lamp)
        return reply.status(404).send({ error: "Lamp not found" });
    hub.publishLampList(store.getLamps());
    syncLampState(lamp.lampId);
    scheduleSiteSection("lamps");
    return lamp;
});
app.patch("/lamps/:id/transport", async (req, reply) => {
    const lamp = store.getLamp(req.params.id);
    if (!lamp)
        return reply.status(404).send({ error: "Lamp not found" });
    const { transport } = req.body ?? {};
    if (transport !== "lora" && transport !== "espnow") {
        return reply.status(400).send({ error: "transport must be 'lora' or 'espnow'" });
    }
    if (transport === lamp.transport && !lamp.pendingTransport)
        return { ok: true, lamp };
    if (!gateway.isAvailable()) {
        return reply.status(503).send({ error: "Gateway serial is not connected; transport was not changed" });
    }
    const updated = store.requestLampTransport(lamp.lampId, transport);
    const command = { lampId: lamp.lampId, transport, attempts: 0, lastSentAtMs: 0 };
    pendingTransportCommands.set(lamp.lampId, command);
    sendPendingTransport(command);
    hub.publishLampList(store.getLamps());
    scheduleSiteSection("lamps");
    console.log(`[TRANSPORT] lamp=${lamp.lampId} requested=${transport} active=${lamp.transport}`);
    return reply.status(202).send({ ok: true, lamp: updated, message: "Waiting for lamp registration on selected transport" });
});
app.delete("/lamps/:id", async (req, reply) => {
    if (!store.deleteLamp(req.params.id))
        return reply.status(404).send({ error: "Lamp not found" });
    hub.publishLampList(store.getLamps());
    scheduleSiteSection("lamps");
    return { ok: true };
});
app.post("/lamps/:id/test", async (req, reply) => {
    try {
        performLampTest(req.params.id, req.body?.state, req.body?.durationMs);
        return { ok: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "No se pudo probar la lámpara";
        const status = message.includes("no encontrada") ? 404 : 503;
        return reply.status(status).send({ error: message });
    }
});
app.get("/devices/:id/lamps", async (req) => ({
    lampIds: store.getLampIdsForCaller(req.params.id),
}));
app.put("/devices/:id/lamps", async (req, reply) => {
    if (!store.getDevice(req.params.id))
        return reply.status(404).send({ error: "Device not found" });
    try {
        const previousLampIds = store.getLampIdsForCaller(req.params.id);
        const lampIds = store.setLampAssignments(req.params.id, req.body?.lampIds ?? []);
        for (const lampId of new Set([...previousLampIds, ...lampIds]))
            syncLampState(lampId);
        hub.publishLampAssignments(req.params.id, lampIds);
        scheduleSiteSection("lamps");
        return { callerDeviceId: req.params.id, lampIds };
    }
    catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : "Invalid assignment" });
    }
});
app.get("/devices/:id", async (req, reply) => {
    const device = store.getDevice(req.params.id);
    if (!device)
        return reply.status(404).send({ error: "Device not found" });
    return device;
});
app.delete("/devices/:id", async (req, reply) => {
    const { id } = req.params;
    const deleted = store.deleteDevice(id);
    if (!deleted)
        return reply.status(404).send({ error: "Device not found" });
    if (presenceRuntime.get(id)?.sessionId)
        closePresenceRuntimeSession(id, Date.now(), "device_deleted");
    presenceRuntime.delete(id);
    pendingEndCommands.delete(id);
    pendingTransportCommands.delete(id);
    confirmedEndCalls.delete(id);
    devicePresenceSentAt.delete(id);
    syncPatient(id);
    pendingPatients.delete(id);
    hub.publishDeviceList(store.getDevices());
    hub.publishActiveCalls(store.getActiveCalls());
    hub.publishPatientList(store.getPatients());
    scheduleSiteSection("devices");
    scheduleSiteSection("lamps");
    return { ok: true };
});
app.patch("/devices/:id", async (req, reply) => {
    const { id } = req.params;
    const { name, callerLocationType } = req.body ?? {};
    if (name !== undefined && (typeof name !== "string" || !name.trim() || Buffer.byteLength(name.trim(), "utf8") > 32 || /[,\r\n]/.test(name))) {
        return reply.status(400).send({ error: "Nombre requerido, máximo 32 bytes UTF-8 y sin comas ni saltos de línea" });
    }
    let device = store.getDevice(id);
    if (!device)
        return reply.status(404).send({ error: "Device not found" });
    if (name !== undefined)
        device = store.updateDeviceName(id, name.trim());
    if (callerLocationType !== undefined)
        device = store.updateDeviceLocationType(id, callerLocationType);
    if (!device)
        return reply.status(404).send({ error: "Device not found" });
    hub.publishDeviceList(store.getDevices());
    // Envía el nombre al dispositivo vía gateway ESP-NOW
    if (name) {
        queueDeviceName(id, name.trim());
    }
    scheduleSiteSection("devices");
    return device;
});
app.get("/patients", async () => ({ items: store.getPatients() }));
const PATIENTS_WEB_ONLY_ERROR = "Los pacientes se gestionan en el web. El servidor local solo los sincroniza.";
app.post("/patients", async (req, reply) => {
    if (patientsReadOnly())
        return reply.status(409).send({ error: PATIENTS_WEB_ONLY_ERROR });
    try {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
            throw new Error("Datos de paciente inválidos");
        const patient = store.createPatient(req.body);
        const sent = publishPatients([patient.assignedDevice]);
        return reply.status(201).send({ ...patient, deliveryPending: !sent });
    }
    catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : "Paciente inválido" });
    }
});
app.get("/patients/:id", async (req, reply) => {
    const patient = store.getPatient(req.params.id);
    return patient ?? reply.status(404).send({ error: "Paciente no encontrado" });
});
app.patch("/patients/:id", async (req, reply) => {
    if (patientsReadOnly())
        return reply.status(409).send({ error: PATIENTS_WEB_ONLY_ERROR });
    const previous = store.getPatient(req.params.id);
    if (!previous)
        return reply.status(404).send({ error: "Paciente no encontrado" });
    try {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
            throw new Error("Datos de paciente inválidos");
        const patient = store.updatePatient(req.params.id, req.body);
        const sent = publishPatients([previous.assignedDevice, patient.assignedDevice]);
        return { ...patient, deliveryPending: !sent };
    }
    catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : "Paciente inválido" });
    }
});
app.delete("/patients/:id", async (req, reply) => {
    if (patientsReadOnly())
        return reply.status(409).send({ error: PATIENTS_WEB_ONLY_ERROR });
    const patient = store.getPatient(req.params.id);
    if (!patient)
        return reply.status(404).send({ error: "Paciente no encontrado" });
    store.deletePatient(patient.patientId);
    const sent = publishPatients([patient.assignedDevice]);
    return { ok: true, deliveryPending: !sent };
});
app.post("/patients/:id/sync", async (req, reply) => {
    const patient = store.getPatient(req.params.id);
    if (!patient)
        return reply.status(404).send({ error: "Paciente no encontrado" });
    if (!patient.assignedDevice)
        return reply.status(400).send({ error: "Paciente sin llamador asignado" });
    return { ok: true, deliveryPending: !syncPatient(patient.assignedDevice) };
});
app.get("/calls/active", async () => ({ items: store.getActiveCalls() }));
app.get("/calls/all", async () => ({ items: store.getAllCalls() }));
app.get("/calls/history", async (req) => {
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 500));
    return { items: store.getCallHistory(req.query.deviceId, limit) };
});
/**
 * Finaliza un llamado activo: apaga sus lámparas, publica el estado y guarda el
 * historial. Para normal/emergencia también le ordena al llamador detener el
 * llamado (botón manual y auto-finalizado).
 * @param callType Si se indica un especial, se cierra SOLO ese especial del
 *   dispositivo (los demás especiales siguen activos) y no se envía endCall al
 *   llamador: el capacitivo no trackea especiales y targetCallSeq sin validar
 *   cortaría una llamada normal concurrente.
 */
function finalizeActiveCall(deviceId, callType) {
    const specialType = callType && isSpecialCallType(callType) ? callType : undefined;
    if (specialType) {
        const special = store.applySpecialCallEnd(deviceId, specialType);
        if (!special)
            return false;
        syncSpecialProfileLamps([specialType]);
        hub.publishCallState(store.withPatientName(special.state));
        hub.publishActiveCalls(store.getActiveCalls());
        if (special.historyRecord)
            hub.publishCallHistory(store.getCallHistory());
        void syncToCloud(async () => {
            await firebase.upsertCalled(special.state);
            if (special.historyRecord)
                await saveHistoryToCloud(special.historyRecord);
        });
        return true;
    }
    const active = store.getActiveCalls()
        .find(c => c.deviceId === deviceId && !isSpecialCallType(c.call_type));
    if (!active)
        return false;
    const commandSeq = nextRemoteCommandSeq();
    const { state, historyRecord } = store.transaction(() => {
        const ended = store.forceEndCall(deviceId);
        store.savePendingCommand(deviceId, "end", commandSeq, { endCall: true, targetCallSeq: active.startSeq });
        return ended;
    });
    syncCallerLamps(deviceId);
    hub.publishCallState(store.withPatientName(state));
    hub.publishActiveCalls(store.getActiveCalls());
    void syncToCloud(async () => {
        await firebase.upsertCalled(state);
        if (historyRecord)
            await saveHistoryToCloud(historyRecord);
    });
    if (historyRecord)
        hub.publishCallHistory(store.getCallHistory());
    const command = {
        deviceId,
        commandSeq,
        targetCallSeq: active.startSeq,
        attempts: 0,
        lastSentAtMs: 0,
    };
    pendingEndCommands.set(deviceId, command);
    confirmedEndCalls.delete(deviceId);
    sendPendingEnd(command);
    return true;
}
app.post("/calls/:id/end", async (req, reply) => {
    const callType = req.query.callType;
    if (callType !== undefined && !isSpecialCallType(callType) && callType !== "normal" && callType !== "emergency") {
        return reply.status(400).send({ error: "Invalid callType" });
    }
    if (!finalizeActiveCall(req.params.id, callType)) {
        return reply.status(404).send({ error: "No active call for this device" });
    }
    const isSpecial = callType !== undefined && isSpecialCallType(callType);
    return { ok: true, delivery: isSpecial ? "local" : "pending" };
});
// ── Presence monitor API ─────────────────────────────────────────────────────
function presenceStatusPayload() {
    const settings = store.getPresenceSettings();
    const sensors = store.getPresenceSensors();
    return { settings, sensors, states: sensors.map(sensor => presenceSensorState(sensor)) };
}
function presenceSessionsFromQuery(query) {
    const fromMs = query.from ? Date.parse(query.from) : NaN;
    const toMs = query.to ? Date.parse(query.to) : NaN;
    return store.getPresenceSessions({
        fromMs: Number.isFinite(fromMs) ? fromMs : undefined,
        toMs: Number.isFinite(toMs) ? toMs : undefined,
        deviceId: query.deviceId || undefined,
        openOnly: query.open === "1" || query.open === "true",
        limit: query.limit ? Number(query.limit) : undefined,
    });
}
function csvCell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
app.get("/presence/status", async () => presenceStatusPayload());
app.get("/presence/settings", async () => store.getPresenceSettings());
app.patch("/presence/settings", async (req) => {
    const body = { ...(req.body ?? {}) };
    if (body.detectionSound !== undefined && !isPlayableSound(body.detectionSound))
        delete body.detectionSound;
    const settings = store.updatePresenceSettings(body);
    if (!settings.enabled) {
        for (const [deviceId, runtime] of presenceRuntime) {
            if (runtime.sessionId)
                closePresenceRuntimeSession(deviceId, Date.now(), "disabled");
        }
    }
    hub.publishPresenceSettings(settings);
    scheduleSiteSection("settings");
    scheduleSiteSection("presence");
    return settings;
});
app.put("/presence/sensors/:deviceId", async (req, reply) => {
    const { deviceId } = req.params;
    if (!store.getDevice(deviceId))
        return reply.status(404).send({ error: "Device not found" });
    const requestedRole = req.body?.role;
    const role = requestedRole === "sillon" ? "sillon"
        : (requestedRole === "cama" || requestedRole === "bed") ? "cama" : "bathroom";
    const areaName = String(req.body?.areaName ?? "").trim();
    const sensor = store.upsertPresenceSensor(deviceId, role, areaName, req.body?.enabled !== false);
    publishPresenceState(deviceId);
    scheduleSiteSection("presence");
    return sensor;
});
app.delete("/presence/sensors/:deviceId", async (req) => {
    const { deviceId } = req.params;
    if (presenceRuntime.get(deviceId)?.sessionId)
        closePresenceRuntimeSession(deviceId, Date.now(), "sensor_removed");
    presenceRuntime.delete(deviceId);
    const deleted = store.deletePresenceSensor(deviceId);
    scheduleSiteSection("presence");
    return { ok: true, deleted };
});
app.get("/presence/sessions", async (req) => ({ items: presenceSessionsFromQuery(req.query) }));
app.get("/presence/sessions.csv", async (req, reply) => {
    const items = presenceSessionsFromQuery(req.query);
    const header = ["id", "dispositivo", "area", "rol", "entrada", "salida", "duracion_s", "motivo", "alerta"].join(",");
    const lines = items.map(session => [
        session.id,
        session.deviceId,
        session.areaName,
        session.role,
        new Date(session.enteredAtMs).toISOString(),
        session.exitedAtMs ? new Date(session.exitedAtMs).toISOString() : "",
        session.durationMs !== undefined ? Math.round(session.durationMs / 1000) : "",
        session.closeReason,
        session.alertSentAtMs > 0 ? "si" : "no",
    ].map(csvCell).join(","));
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="presencia-${new Date().toISOString().slice(0, 10)}.csv"`);
    return [header, ...lines].join("\n");
});
// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
    store.markAllOffline();
    // Las sesiones de presencia no sobreviven a un reinicio: se cierran para no
    // dejar baños "ocupados" fantasma. El historial se conserva.
    store.closeAllOpenPresenceSessions("server_restart", Date.now());
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const publicDir = join(__dirname, "..", "public");
    await app.register(fastifyStatic, {
        root: publicDir,
        prefix: "/",
        wildcard: false,
        serve: true,
        decorateReply: false,
        // La pantalla de sala puede estar abierta días: sin no-cache el navegador
        // sirve HTML/JS viejo por caché heurística y no aplica los últimos cambios.
        setHeaders: (res, filePath) => {
            const immutableSound = /[/\\]sounds[/\\]/.test(filePath);
            res.setHeader("Cache-Control", immutableSound ? "public, max-age=31536000, immutable" : "no-cache");
        },
    });
    const stopConfigWatch = config.legacyDevicesConfig
        ? firebase.subscribeConfig((deviceId, cfg) => {
            const frame = {
                msgType: "config_update",
                deviceId,
                config: cfg,
            };
            gateway.sendConfig(frame);
        })
        : () => undefined;
    startSiteSettingsWatch();
    await app.ready();
    await gateway.open();
    gateway.requestGatewayStatus();
    startPatientsWatch();
    startSiteCommandsWatch();
    for (const saved of store.getPendingCommands()) {
        if (!store.getDevice(saved.deviceId)) {
            store.cancelPendingCommand(saved.deviceId, saved.kind);
            app.log.info({ deviceId: saved.deviceId, kind: saved.kind }, "Dropped pending command for removed device");
            continue;
        }
        if (saved.kind === "end") {
            if (saved.attempts >= MAX_PENDING_END_ATTEMPTS) {
                store.cancelPendingCommand(saved.deviceId, "end");
                app.log.info({ deviceId: saved.deviceId, attempts: saved.attempts }, "Dropped unconfirmed end command");
                continue;
            }
            pendingEndCommands.set(saved.deviceId, { deviceId: saved.deviceId,
                commandSeq: saved.seq, targetCallSeq: Number(saved.payload.targetCallSeq), attempts: 0, lastSentAtMs: 0 });
        }
        else if (saved.kind === "name" && saved.attempts >= MAX_PENDING_NAME_ATTEMPTS) {
            store.cancelPendingCommand(saved.deviceId, "name");
            app.log.info({ deviceId: saved.deviceId, attempts: saved.attempts }, "Dropped unconfirmed name command");
        }
    }
    for (const device of store.getDevices()) {
        if (store.getPatientByDevice(device.deviceId) || isTactileFirmware(device.firmwareVersion))
            syncPatient(device.deviceId);
    }
    for (const lamp of store.getLamps()) {
        if (!lamp.pendingTransport)
            continue;
        const command = {
            lampId: lamp.lampId,
            transport: lamp.pendingTransport,
            attempts: 0,
            lastSentAtMs: 0,
        };
        pendingTransportCommands.set(lamp.lampId, command);
        sendPendingTransport(command);
    }
    // Sincronizar hora al gateway inmediatamente y cada 60 s
    gateway.sendTimeSync();
    setInterval(() => gateway.sendTimeSync(), 60_000);
    setInterval(retryPendingEndCommands, 250);
    setInterval(retryPendingLampStates, 50);
    setInterval(retryPendingTransportCommands, 1000);
    setInterval(retryPatients, 1000);
    setInterval(retryDeviceNames, 1000);
    setInterval(() => gateway.requestGatewayStatus(), 2000);
    setInterval(() => sweepPresenceMonitor(), 5000);
    setInterval(() => { void flushCloudOutbox(); }, 1000);
    // Re-publica el estado de la sede cada 60 min como red de seguridad.
    // Los cambios reales ya se publican al instante en sus endpoints/comandos.
    setInterval(() => {
        if (firebase.isEnabled())
            void publishAllSiteSections();
    }, 60 * 60_000);
    // Presencia: la UI local usa la ventana configurable por sede. El barrido
    // mantiene online coherente en SQLite y notifica a los navegadores.
    setInterval(() => {
        const offlineDevices = store.sweepOfflineDevices(store.getOnlineWindowMs());
        if (offlineDevices.length > 0) {
            for (const deviceId of offlineDevices)
                devicePresenceSentAt.delete(deviceId);
            hub.publishDeviceList(store.getDevices());
            schedulePresencePublish(0, true);
            scheduleSiteSection("devices");
        }
        const offlineLamps = store.sweepOfflineLamps(90_000);
        if (offlineLamps.length > 0) {
            hub.publishLampList(store.getLamps());
            scheduleSiteSection("lamps");
        }
    }, 5000);
    // Presencia agregada en Firestore: un solo documento por sede cada ~ventana/2.
    setInterval(() => {
        if (Date.now() - lastPresencePublishAt >= presenceIntervalMs())
            void publishPresenceNow();
    }, 5000);
    // Auto-finaliza llamados especiales cuyo perfil tiene cronómetro (autoEndS > 0).
    // Cada (dispositivo, tipo) tiene su propio cronómetro e independiente.
    setInterval(() => {
        const now = Date.now();
        for (const call of store.getActiveCalls()) {
            if (!call.active || !isSpecialCallType(call.call_type))
                continue;
            const autoEndS = store.getLampAlertProfile(call.call_type)?.autoEndS ?? 0;
            if (autoEndS <= 0 || now - call.startedAtMs < autoEndS * 1000)
                continue;
            if (finalizeActiveCall(call.deviceId, call.call_type)) {
                app.log.info({ deviceId: call.deviceId, callType: call.call_type, autoEndS }, "Special call auto-finalized");
            }
        }
    }, 1000);
    await app.listen({ port: config.localHttpPort, host: "0.0.0.0" });
    // Plain-HTTP helper that redirects browsers to HTTPS (same port logic as before).
    if (tlsActive && Number.isInteger(config.tls.redirectPort) && config.tls.redirectPort > 0 &&
        config.tls.redirectPort !== config.localHttpPort) {
        const redirectPort = config.tls.redirectPort;
        const httpsPort = config.localHttpPort;
        const redirect = createServer((req, res) => {
            const host = (req.headers.host ?? "localhost").split(":")[0];
            res.writeHead(301, { Location: `https://${host}:${httpsPort}${req.url ?? "/"}` });
            res.end();
        });
        redirect.on("error", (err) => app.log.warn({ err }, "HTTP->HTTPS redirect failed; HTTPS still works"));
        redirect.listen(redirectPort, "0.0.0.0");
    }
    app.log.info({
        firebaseEnabled: firebase.isEnabled(),
        tls: tlsActive,
        serialPort: config.serialPort,
        localDbFile: config.localDbFile,
        presenceMode: config.presenceMode,
        historyWriter: config.historyWriter,
        outboxEnabled: config.outboxEnabled,
        onlineWindowS: store.getSiteSettings().onlineWindowS,
    }, `Local bridge running on :${config.localHttpPort}`);
    void publishPresenceNow();
    void publishAllSiteSections();
    process.on("SIGINT", () => {
        stopConfigWatch();
        stopSiteSettingsWatch();
        stopPatientsWatch();
        stopSiteCommandsWatch();
        store.close();
        process.exit(0);
    });
}
bootstrap().catch((err) => {
    app.log.error(err, "Bootstrap failed");
    process.exit(1);
});

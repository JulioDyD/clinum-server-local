import { Server as SocketIOServer } from "socket.io";
import type { Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import type { ActiveCallState, CallHistoryRecord, DeviceRecord, LampRecord, LocationSettings } from "../types.js";
import { config } from "../config.js";

function parseOrigins(value: string): string | string[] {
  if (value.trim() === "*") return "*";
  const list = value.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean);
  return list.length > 0 ? list : "*";
}

export class RealtimeHub {
  private readonly io: SocketIOServer;

  constructor(server: HttpServer, onConnection?: (socket: Socket) => void) {
    this.io = new SocketIOServer(server, {
      cors: {
        origin: parseOrigins(config.corsOrigin),
        methods: ["GET", "POST"],
      },
    });

    this.io.on("connection", (socket) => {
      socket.emit("hello", { ok: true, ts: Date.now() });
      if (onConnection) onConnection(socket);
    });
  }

  public publishCallState(state: ActiveCallState): void {
    this.io.emit("call_state", state);
  }

  public publishActiveCalls(states: ActiveCallState[]): void {
    this.io.emit("active_calls", states);
  }

  public publishDeviceRegistered(device: DeviceRecord): void {
    this.io.emit("device_registered", device);
  }

  public publishDeviceList(devices: DeviceRecord[]): void {
    this.io.emit("device_list", devices);
  }

  public publishCallHistory(records: CallHistoryRecord[]): void {
    this.io.emit("call_history", records);
  }

  public publishLampList(lamps: LampRecord[]): void {
    this.io.emit("lamp_list", lamps);
  }

  public publishLampAssignments(callerDeviceId: string, lampIds: string[]): void {
    this.io.emit("lamp_assignments", { callerDeviceId, lampIds });
  }

  public publishLocationSettings(settings: LocationSettings): void {
    this.io.emit("location_settings", settings);
  }
}

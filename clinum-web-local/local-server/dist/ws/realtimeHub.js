import { Server as SocketIOServer } from "socket.io";
import { config } from "../config.js";
function parseOrigins(value) {
    if (value.trim() === "*")
        return "*";
    const list = value.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean);
    return list.length > 0 ? list : "*";
}
export class RealtimeHub {
    io;
    constructor(server, onConnection) {
        this.io = new SocketIOServer(server, {
            cors: {
                origin: parseOrigins(config.corsOrigin),
                methods: ["GET", "POST"],
            },
        });
        this.io.on("connection", (socket) => {
            socket.emit("hello", { ok: true, ts: Date.now() });
            if (onConnection)
                onConnection(socket);
        });
    }
    publishCallState(state) {
        this.io.emit("call_state", state);
    }
    publishActiveCalls(states) {
        this.io.emit("active_calls", states);
    }
    publishDeviceRegistered(device) {
        this.io.emit("device_registered", device);
    }
    publishDeviceList(devices) {
        this.io.emit("device_list", devices);
    }
    publishCallHistory(records) {
        this.io.emit("call_history", records);
    }
    publishLampList(lamps) {
        this.io.emit("lamp_list", lamps);
    }
    publishLampAssignments(callerDeviceId, lampIds) {
        this.io.emit("lamp_assignments", { callerDeviceId, lampIds });
    }
    publishLocationSettings(settings) {
        this.io.emit("location_settings", settings);
    }
    publishPatientList(patients) {
        this.io.emit("patient_list", patients);
    }
}

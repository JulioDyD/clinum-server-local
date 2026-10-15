import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
export class SerialGateway {
    callbacks;
    port;
    parser;
    disabled;
    reconnecting = false;
    listening = false;
    constructor(path, baudRate, callbacks) {
        this.callbacks = callbacks;
        this.disabled = path.trim().length === 0 || path.toLowerCase() === "none";
        this.port = new SerialPort({ path, baudRate, autoOpen: false });
        this.parser = this.port.pipe(new ReadlineParser({ delimiter: "\n" }));
        this.port.on("error", (error) => console.error("[SERIAL]", error.message));
        this.port.on("close", () => this.scheduleReconnect());
    }
    open() {
        if (this.disabled) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.port.open((err) => {
                if (err) {
                    console.error("[SERIAL] Initial connection unavailable:", err.message);
                    this.scheduleReconnect();
                    resolve();
                    return;
                }
                if (!this.listening)
                    this.parser.on("data", (line) => {
                        const raw = String(line).trim();
                        if (!raw)
                            return;
                        // Extraer JSON de líneas con prefijo debug del gateway: "DEBUG uplink: {...}"
                        let jsonStr = raw;
                        const uplinkMatch = raw.match(/^DEBUG uplink:\s*(\{.+\})\s*$/);
                        if (uplinkMatch) {
                            jsonStr = uplinkMatch[1];
                        }
                        else if (raw.startsWith("DEBUG status")) {
                            // Telemetria periodica del gateway (uptime, heap, rutas):
                            // solo se muestra si reporta perdidas/errores. El ultimo
                            // estado sigue disponible en GET /gateway/status.
                            if (/(drops\w+|errors|timeouts|overflow)=[1-9]/.test(raw)) {
                                console.log(`[GATEWAY] ${raw}`);
                            }
                            return;
                        }
                        else if (raw.startsWith("DEBUG")) {
                            console.log(`[GATEWAY] ${raw}`);
                            return;
                        }
                        else if (/^\[[A-Z]+\]/.test(raw)) {
                            // Firmware console noise (ej: "[THERMAL] CPU=... Temp=..."):
                            // no es un frame del protocolo, se ignora en silencio.
                            return;
                        }
                        try {
                            const frame = JSON.parse(jsonStr);
                            if (frame.msgType.startsWith("gateway_")) {
                                // gateway_status llega cada ~2s: sin log por frame,
                                // handleGatewayControl solo reporta cambios de estado.
                                this.callbacks.onGatewayControl(frame);
                            }
                            else {
                                console.log(`[SERIAL RX] ${jsonStr}`);
                                this.callbacks.onFrame(frame);
                            }
                        }
                        catch {
                            this.callbacks.onInvalidFrame(raw);
                        }
                    });
                this.listening = true;
                resolve();
            });
        });
    }
    isAvailable() {
        return !this.disabled && this.port.isOpen;
    }
    writeFrame(frame) {
        this.port.write(`${JSON.stringify({ server: "local", ...frame })}\n`);
    }
    sendAck(ack) {
        if (!this.isAvailable())
            return;
        console.log(`[SERIAL TX] ${JSON.stringify(ack)}`);
        this.writeFrame({ ...ack });
    }
    sendLampSessionAck(ack) {
        if (!this.isAvailable())
            return;
        console.log(`[SERIAL TX] ${JSON.stringify(ack)}`);
        this.writeFrame({ ...ack });
    }
    sendConfig(frame) {
        if (!this.isAvailable())
            return;
        console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
        this.writeFrame({ ...frame });
    }
    scheduleReconnect() {
        if (this.disabled || this.reconnecting)
            return;
        this.reconnecting = true;
        setTimeout(() => {
            this.reconnecting = false;
            if (this.port.isOpen)
                return;
            void this.open().then(() => {
                if (this.isAvailable()) {
                    this.requestGatewayStatus();
                    this.sendTimeSync();
                }
            });
        }, 2000).unref();
    }
    sendPatient(frame) {
        if (!this.isAvailable())
            return false;
        this.writeFrame({ ...frame });
        return true;
    }
    sendTimeSync() {
        if (!this.isAvailable())
            return;
        const frame = { msgType: "time_sync", epochS: Math.floor(Date.now() / 1000) };
        this.writeFrame({ ...frame });
    }
    sendLampState(frame) {
        if (!this.isAvailable())
            return;
        console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
        this.writeFrame({ ...frame });
    }
    sendLampTest(frame) {
        if (!this.isAvailable())
            return;
        console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
        this.writeFrame({ ...frame });
    }
    sendGatewayConfig(config) {
        if (!this.isAvailable())
            return false;
        const frame = { msgType: "gateway_config", config };
        console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
        this.writeFrame({ ...frame });
        return true;
    }
    requestGatewayStatus() {
        if (!this.isAvailable())
            return false;
        this.writeFrame({ msgType: "gateway_status_request" });
        return true;
    }
}

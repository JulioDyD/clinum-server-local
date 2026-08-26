import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
export class SerialGateway {
    callbacks;
    port;
    parser;
    disabled;
    constructor(path, baudRate, callbacks) {
        this.callbacks = callbacks;
        this.disabled = path.trim().length === 0 || path.toLowerCase() === "none";
        this.port = new SerialPort({ path, baudRate, autoOpen: false });
        this.parser = this.port.pipe(new ReadlineParser({ delimiter: "\n" }));
    }
    open() {
        if (this.disabled) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            this.port.open((err) => {
                if (err) {
                    reject(err);
                    return;
                }
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
                    else if (raw.startsWith("DEBUG")) {
                        console.log(`[GATEWAY] ${raw}`);
                        return;
                    }
                    try {
                        const frame = JSON.parse(jsonStr);
                        console.log(`[SERIAL RX] ${jsonStr}`);
                        this.callbacks.onFrame(frame);
                    }
                    catch {
                        this.callbacks.onInvalidFrame(raw);
                    }
                });
                resolve();
            });
        });
    }
    sendAck(ack) {
        if (this.disabled)
            return;
        console.log(`[SERIAL TX] ${JSON.stringify(ack)}`);
        this.port.write(`${JSON.stringify(ack)}\n`);
    }
    sendConfig(frame) {
        if (this.disabled)
            return;
        console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
        this.port.write(`${JSON.stringify(frame)}\n`);
    }
    sendTimeSync() {
        if (this.disabled)
            return;
        const frame = { msgType: "time_sync", epochS: Math.floor(Date.now() / 1000) };
        this.port.write(`${JSON.stringify(frame)}\n`);
    }
    sendLampState(frame) {
        if (this.disabled)
            return;
        console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
        this.port.write(`${JSON.stringify(frame)}\n`);
    }
    sendLampTest(frame) {
        if (this.disabled)
            return;
        console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
        this.port.write(`${JSON.stringify(frame)}\n`);
    }
}

import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import type { AckFrame, ConfigUpdateFrame, IncomingFrame, LampStateFrame, LampTestFrame, TimeSyncFrame } from "../types.js";

type Callbacks = {
  onFrame: (frame: IncomingFrame) => void;
  onInvalidFrame: (raw: string) => void;
};

export class SerialGateway {
  private readonly port: SerialPort;
  private readonly parser: ReadlineParser;
  private readonly disabled: boolean;

  public constructor(path: string, baudRate: number, private readonly callbacks: Callbacks) {
    this.disabled = path.trim().length === 0 || path.toLowerCase() === "none";
    this.port = new SerialPort({ path, baudRate, autoOpen: false });
    this.parser = this.port.pipe(new ReadlineParser({ delimiter: "\n" }));
  }

  public open(): Promise<void> {
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
          if (!raw) return;

          // Extraer JSON de líneas con prefijo debug del gateway: "DEBUG uplink: {...}"
          let jsonStr = raw;
          const uplinkMatch = raw.match(/^DEBUG uplink:\s*(\{.+\})\s*$/);
          if (uplinkMatch) {
            jsonStr = uplinkMatch[1];
          } else if (raw.startsWith("DEBUG")) {
            console.log(`[GATEWAY] ${raw}`);
            return;
          }

          try {
            const frame = JSON.parse(jsonStr) as IncomingFrame;
            console.log(`[SERIAL RX] ${jsonStr}`);
            this.callbacks.onFrame(frame);
          } catch {
            this.callbacks.onInvalidFrame(raw);
          }
        });

        resolve();
      });
    });
  }

  public sendAck(ack: AckFrame): void {
    if (this.disabled) return;
    console.log(`[SERIAL TX] ${JSON.stringify(ack)}`);
    this.port.write(`${JSON.stringify(ack)}\n`);
  }

  public sendConfig(frame: ConfigUpdateFrame): void {
    if (this.disabled) return;
    console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
    this.port.write(`${JSON.stringify(frame)}\n`);
  }

  public sendTimeSync(): void {
    if (this.disabled) return;
    const frame: TimeSyncFrame = { msgType: "time_sync", epochS: Math.floor(Date.now() / 1000) };
    this.port.write(`${JSON.stringify(frame)}\n`);
  }

  public sendLampState(frame: LampStateFrame): void {
    if (this.disabled) return;
    console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
    this.port.write(`${JSON.stringify(frame)}\n`);
  }

  public sendLampTest(frame: LampTestFrame): void {
    if (this.disabled) return;
    console.log(`[SERIAL TX] ${JSON.stringify(frame)}`);
    this.port.write(`${JSON.stringify(frame)}\n`);
  }
}

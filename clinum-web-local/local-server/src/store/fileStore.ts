import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryStoreSnapshot } from "./memoryStore.js";

const EMPTY_SNAPSHOT: MemoryStoreSnapshot = {
  calls: [],
  lastSeq: [],
  devices: [],
  callHistory: [],
};

export class FileStore {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<MemoryStoreSnapshot> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MemoryStoreSnapshot>;
      return {
        calls: Array.isArray(parsed.calls) ? parsed.calls : [],
        lastSeq: Array.isArray(parsed.lastSeq) ? parsed.lastSeq : [],
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        callHistory: Array.isArray(parsed.callHistory) ? parsed.callHistory : [],
      };
    } catch {
      return EMPTY_SNAPSHOT;
    }
  }

  public async save(snapshot: MemoryStoreSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(snapshot), "utf8");
  }
}

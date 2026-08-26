import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const EMPTY_SNAPSHOT = {
    calls: [],
    lastSeq: [],
    devices: [],
    callHistory: [],
};
export class FileStore {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    async load() {
        try {
            const raw = await readFile(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            return {
                calls: Array.isArray(parsed.calls) ? parsed.calls : [],
                lastSeq: Array.isArray(parsed.lastSeq) ? parsed.lastSeq : [],
                devices: Array.isArray(parsed.devices) ? parsed.devices : [],
                callHistory: Array.isArray(parsed.callHistory) ? parsed.callHistory : [],
            };
        }
        catch {
            return EMPTY_SNAPSHOT;
        }
    }
    async save(snapshot) {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, JSON.stringify(snapshot), "utf8");
    }
}

const MAX_HISTORY = 500;
export class MemoryStore {
    calls = new Map();
    lastSeq = new Map();
    devices = new Map();
    callHistory = [];
    hydrate(snapshot) {
        this.calls.clear();
        this.lastSeq.clear();
        this.devices.clear();
        this.callHistory.length = 0;
        snapshot.calls.forEach((c) => this.calls.set(c.deviceId, c));
        snapshot.lastSeq.forEach((item) => this.lastSeq.set(item.deviceId, item.seq));
        (snapshot.devices ?? []).forEach((d) => this.devices.set(d.deviceId, d));
        (snapshot.callHistory ?? []).forEach((h) => this.callHistory.push(h));
    }
    isDuplicateOrOld(deviceId, seq) {
        const known = this.lastSeq.get(deviceId);
        return known !== undefined && seq <= known;
    }
    markSeq(deviceId, seq) {
        this.lastSeq.set(deviceId, seq);
    }
    // ── Devices ──────────────────────────────────────────────────────────────
    registerDevice(deviceId, mac) {
        const now = Date.now();
        const existing = this.devices.get(deviceId);
        const record = {
            deviceId,
            mac: mac || existing?.mac || "",
            online: true,
            lastSeenMs: now,
            registeredAtMs: existing?.registeredAtMs ?? now,
            callerLocationType: existing?.callerLocationType ?? "cama",
        };
        this.devices.set(deviceId, record);
        return record;
    }
    touchDevice(deviceId, mac) {
        const existing = this.devices.get(deviceId);
        const now = Date.now();
        const record = {
            deviceId,
            mac: mac || existing?.mac || "",
            online: true,
            lastSeenMs: now,
            registeredAtMs: existing?.registeredAtMs ?? now,
            callerLocationType: existing?.callerLocationType ?? "cama",
        };
        this.devices.set(deviceId, record);
        return record;
    }
    getDevice(deviceId) {
        return this.devices.get(deviceId);
    }
    getDevices() {
        return [...this.devices.values()];
    }
    updateDeviceName(deviceId, name) {
        const existing = this.devices.get(deviceId);
        if (!existing)
            return undefined;
        const updated = { ...existing, name };
        this.devices.set(deviceId, updated);
        return updated;
    }
    // ── Calls ─────────────────────────────────────────────────────────────────
    applyCallStart(deviceId, seq, cons, callType) {
        const prev = this.calls.get(deviceId);
        const now = Date.now();
        const next = {
            deviceId,
            active: true,
            cons,
            call_type: callType,
            // Preserve startedAtMs if already in an active call (insistence)
            startedAtMs: prev?.active ? (prev.startedAtMs ?? now) : now,
            updatedAtMs: now,
            startSeq: prev?.active ? (prev.startSeq || seq) : seq,
            lastSeq: seq,
        };
        this.calls.set(deviceId, next);
        this.markSeq(deviceId, seq);
        return next;
    }
    applyCallEnd(deviceId, seq) {
        const prev = this.calls.get(deviceId);
        const now = Date.now();
        const ended = {
            deviceId,
            active: false,
            cons: 0,
            call_type: prev?.call_type ?? "normal",
            startedAtMs: prev?.startedAtMs ?? now,
            updatedAtMs: now,
            startSeq: prev?.startSeq ?? 0,
            lastSeq: seq,
        };
        this.calls.set(deviceId, ended);
        this.markSeq(deviceId, seq);
        let historyRecord;
        if (prev?.active) {
            const startedAt = prev.startedAtMs ?? now;
            historyRecord = {
                id: `${deviceId}_${now}`,
                deviceId,
                call_type: prev.call_type,
                cons: prev.cons,
                startedAtMs: startedAt,
                endedAtMs: now,
                durationMs: now - startedAt,
            };
            this.callHistory.push(historyRecord);
            if (this.callHistory.length > MAX_HISTORY) {
                this.callHistory.splice(0, this.callHistory.length - MAX_HISTORY);
            }
        }
        return { state: ended, historyRecord };
    }
    getActiveCalls() {
        return [...this.calls.values()].filter((c) => c.active);
    }
    getAllCalls() {
        return [...this.calls.values()];
    }
    getCallHistory(deviceId) {
        if (deviceId)
            return this.callHistory.filter((h) => h.deviceId === deviceId);
        return [...this.callHistory];
    }
    snapshot() {
        return {
            calls: this.getAllCalls(),
            lastSeq: [...this.lastSeq.entries()].map(([deviceId, seq]) => ({ deviceId, seq })),
            devices: this.getDevices(),
            callHistory: this.getCallHistory(),
        };
    }
}

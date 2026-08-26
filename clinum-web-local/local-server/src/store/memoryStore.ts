import type { ActiveCallState, CallHistoryRecord, CallType, DeviceRecord } from "../types.js";

export type MemoryStoreSnapshot = {
  calls: ActiveCallState[];
  lastSeq: Array<{ deviceId: string; seq: number }>;
  devices: DeviceRecord[];
  callHistory: CallHistoryRecord[];
};

const MAX_HISTORY = 500;

export class MemoryStore {
  private readonly calls = new Map<string, ActiveCallState>();
  private readonly lastSeq = new Map<string, number>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly callHistory: CallHistoryRecord[] = [];

  public hydrate(snapshot: MemoryStoreSnapshot): void {
    this.calls.clear();
    this.lastSeq.clear();
    this.devices.clear();
    this.callHistory.length = 0;

    snapshot.calls.forEach((c) => this.calls.set(c.deviceId, c));
    snapshot.lastSeq.forEach((item) => this.lastSeq.set(item.deviceId, item.seq));
    (snapshot.devices ?? []).forEach((d) => this.devices.set(d.deviceId, d));
    (snapshot.callHistory ?? []).forEach((h) => this.callHistory.push(h));
  }

  public isDuplicateOrOld(deviceId: string, seq: number): boolean {
    const known = this.lastSeq.get(deviceId);
    return known !== undefined && seq <= known;
  }

  public markSeq(deviceId: string, seq: number): void {
    this.lastSeq.set(deviceId, seq);
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  public registerDevice(deviceId: string, mac: string): DeviceRecord {
    const now = Date.now();
    const existing = this.devices.get(deviceId);
    const record: DeviceRecord = {
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

  public touchDevice(deviceId: string, mac?: string): DeviceRecord {
    const existing = this.devices.get(deviceId);
    const now = Date.now();
    const record: DeviceRecord = {
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

  public getDevice(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  public getDevices(): DeviceRecord[] {
    return [...this.devices.values()];
  }

  public updateDeviceName(deviceId: string, name: string): DeviceRecord | undefined {
    const existing = this.devices.get(deviceId);
    if (!existing) return undefined;
    const updated = { ...existing, name };
    this.devices.set(deviceId, updated);
    return updated;
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  public applyCallStart(deviceId: string, seq: number, cons: number, callType: CallType): ActiveCallState {
    const prev = this.calls.get(deviceId);
    const now = Date.now();
    const next: ActiveCallState = {
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

  public applyCallEnd(deviceId: string, seq: number): { state: ActiveCallState; historyRecord: CallHistoryRecord | undefined } {
    const prev = this.calls.get(deviceId);
    const now = Date.now();
    const ended: ActiveCallState = {
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

    let historyRecord: CallHistoryRecord | undefined;
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

  public getActiveCalls(): ActiveCallState[] {
    return [...this.calls.values()].filter((c) => c.active);
  }

  public getAllCalls(): ActiveCallState[] {
    return [...this.calls.values()];
  }

  public getCallHistory(deviceId?: string): CallHistoryRecord[] {
    if (deviceId) return this.callHistory.filter((h) => h.deviceId === deviceId);
    return [...this.callHistory];
  }

  public snapshot(): MemoryStoreSnapshot {
    return {
      calls: this.getAllCalls(),
      lastSeq: [...this.lastSeq.entries()].map(([deviceId, seq]) => ({ deviceId, seq })),
      devices: this.getDevices(),
      callHistory: this.getCallHistory(),
    };
  }
}

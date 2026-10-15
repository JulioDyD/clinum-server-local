import admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { isSpecialCallType } from "../types.js";
import type { ActiveCallState, CallHistoryRecord, DeviceRecord } from "../types.js";

export class FirebaseBridge {
  private db: ReturnType<typeof getFirestore> | null = null;
  private readonly enabled: boolean;

  public constructor(private readonly projectId: string, enabled: boolean) {
    this.enabled = enabled;
  }

  public static initAdmin(projectId: string, enabled: boolean): boolean {
    if (!enabled) return false;
    if (admin.apps.length > 0) return true;
    admin.initializeApp({ projectId });
    return true;
  }

  private get firestore() {
    if (!this.db) {
      this.db = getFirestore();
    }

    return this.db;
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  /** Actualiza el documento devices/{deviceId} en Firestore (merge: no sobreescribe nombre/ubicación) */
  public async upsertDevice(record: DeviceRecord): Promise<void> {
    if (!this.enabled) return;
    await this.firestore.collection("devices").doc(record.deviceId).set(
      {
        isOnline: record.online,
        lastSeen: FieldValue.serverTimestamp(),
        mac: record.mac,
        source: "espnow-local-bridge",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  // ── Called (estado activo) ────────────────────────────────────────────────

  public async upsertCalled(state: ActiveCallState): Promise<void> {
    if (!this.enabled) return;
    const data: Record<string, unknown> = {
      deviceId: state.deviceId,
      active: state.active,
      cons: state.cons,
      call_type: state.call_type,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (state.active) data.startedAt = FieldValue.serverTimestamp();
    else data.endedAt = FieldValue.serverTimestamp();
    // Un llamador puede tener varios especiales concurrentes: cada tipo vive en
    // su propio documento para no pisarse. Normal/emergencia siguen en el doc
    // del dispositivo (uno solo a la vez).
    const docId = isSpecialCallType(state.call_type)
      ? `${state.deviceId}_${state.call_type}`
      : state.deviceId;
    await this.firestore.collection("called").doc(docId).set(data, { merge: true });
  }

  // ── Historial de llamados ─────────────────────────────────────────────────

  /** Guarda el llamado finalizado en care_history/{id} */
  public async saveCallHistory(record: CallHistoryRecord): Promise<void> {
    if (!this.enabled) return;
    await this.firestore.collection("care_history").doc(record.id).set({
      deviceId: record.deviceId,
      call_type: record.call_type,
      cons: record.cons,
      startedAtMs: record.startedAtMs,
      endedAtMs: record.endedAtMs,
      durationMs: record.durationMs,
      ...(record.patientName ? { patientName: record.patientName } : {}),
      ...(record.finishOrigin ? { finishOrigin: record.finishOrigin } : {}),
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  public subscribeConfig(onConfig: (deviceId: string, cfg: Record<string, unknown>) => void): () => void {
    if (!this.enabled) return () => undefined;
    // Suggested structure: devices_config/{deviceId}
    return this.firestore.collection("devices_config").onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === "removed") return;
        onConfig(change.doc.id, change.doc.data());
      });
    });
  }

  public async mirrorPresence(deviceId: string): Promise<void> {
    if (!this.enabled) return;
    const ref = this.firestore.collection("devices_presence").doc(deviceId);
    await ref.set(
      {
        online: true,
        lastSeen: FieldValue.serverTimestamp(),
        source: "local-server-espnow",
      },
      { merge: true },
    );
  }
}

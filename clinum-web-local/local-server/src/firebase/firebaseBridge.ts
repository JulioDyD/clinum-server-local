import admin from "firebase-admin";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { isSpecialCallType } from "../types.js";
import type { ActiveCallState, CallHistoryRecord, DeviceRecord } from "../types.js";

export class FirebaseBridge {
  private db: ReturnType<typeof getFirestore> | null = null;
  private enabled: boolean;
  private locationId: string;

  public constructor(
    private readonly projectId: string,
    enabled: boolean,
    locationId: string = "",
  ) {
    this.enabled = enabled;
    this.locationId = locationId;
  }

  public static initAdmin(projectId: string, enabled: boolean): boolean {
    if (!enabled) return false;
    if (admin.apps.length > 0) return true;
    admin.initializeApp({ projectId });
    return true;
  }

  /** Activa/desactiva el sync en caliente (sin reiniciar el proceso). Inicializa el SDK la primera vez que se activa. */
  public setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled) FirebaseBridge.initAdmin(this.projectId, true);
    this.enabled = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /** Cambia la sede sin reiniciar: afecta solo los próximos escritos (no reescribe los ya enviados). */
  public setLocationId(locationId: string): void {
    this.locationId = locationId;
  }

  private get firestore() {
    if (!this.db) {
      this.db = getFirestore();
    }

    return this.db;
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  /** Actualiza el documento devices/{deviceId} en Firestore (merge: no sobreescribe nombre/ubicación puestos desde el web) */
  public async upsertDevice(record: DeviceRecord): Promise<void> {
    if (!this.enabled) return;
    await this.firestore.collection("devices").doc(record.deviceId).set(
      {
        isOnline: record.online,
        lastSeen: FieldValue.serverTimestamp(),
        mac: record.mac,
        name: record.name || null,
        type: "caller",
        callerLocationType: record.callerLocationType,
        ...(this.locationId ? { locationId: this.locationId } : {}),
        origin: "local-bridge",
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
      ...(this.locationId ? { locationId: this.locationId } : {}),
    };
    if (state.active) {
      data.startedAt = FieldValue.serverTimestamp();
      // Idempotente: state.startedAtMs ya es estable entre call_start y call_insist
      // (el store solo lo renueva en un inicio real), así que reescribirlo aquí
      // en cada insistencia no reinicia el cronómetro del web.
      data.timestamp = Timestamp.fromMillis(state.startedAtMs);
    } else {
      data.endedAt = FieldValue.serverTimestamp();
      if (state.finishOrigin) {
        data.finishOrigin = state.finishOrigin;
        data.finishOriginUpdatedAt = FieldValue.serverTimestamp();
      }
    }
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
      ...(this.locationId ? { locationId: this.locationId } : {}),
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

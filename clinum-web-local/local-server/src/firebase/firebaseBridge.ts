import admin from "firebase-admin";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { existsSync, readFileSync } from "node:fs";
import { isSpecialCallType } from "../types.js";
import type { ActiveCallState, CallHistoryRecord, DeviceRecord } from "../types.js";

export class FirebaseBridge {
  private db: ReturnType<typeof getFirestore> | null = null;
  private enabled: boolean;
  private locationId: string;
  private lastError: { message: string; atMs: number } | null = null;

  public constructor(
    private readonly projectId: string,
    enabled: boolean,
    locationId: string = "",
    private readonly credentialPath: string = "",
  ) {
    this.enabled = enabled;
    this.locationId = locationId;
  }

  /** Inicializa el SDK. Si hay credentialPath válido, lo usa explícito (no depende
   *  de la variable de entorno GOOGLE_APPLICATION_CREDENTIALS, que en producción
   *  puede no estar seteada aunque el archivo exista en disco). */
  public static initAdmin(projectId: string, enabled: boolean, credentialPath = ""): boolean {
    if (!enabled) return false;
    if (admin.apps.length > 0) return true;
    try {
      if (credentialPath && existsSync(credentialPath)) {
        const raw = JSON.parse(readFileSync(credentialPath, "utf8"));
        admin.initializeApp({ credential: admin.credential.cert(raw), projectId });
      } else {
        admin.initializeApp({ projectId });
      }
    } catch (err) {
      console.error("[firebase] initAdmin failed:", err instanceof Error ? err.message : err);
      return false;
    }
    return true;
  }

  /** Activa/desactiva el sync en caliente (sin reiniciar el proceso). Inicializa el SDK la primera vez que se activa. */
  public setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled) {
      const ok = FirebaseBridge.initAdmin(this.projectId, true, this.credentialPath);
      if (!ok) {
        this.lastError = { message: "No se pudo inicializar el SDK de Firebase (ver logs del servidor)", atMs: Date.now() };
        return;
      }
    }
    this.enabled = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getLastError(): { message: string; atMs: number } | null {
    return this.lastError;
  }

  private recordError(context: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = { message: `${context}: ${message}`, atMs: Date.now() };
    console.error(`[firebase] ${context}:`, err);
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
    try {
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
    } catch (err) {
      this.recordError(`upsertDevice(${record.deviceId})`, err);
    }
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
    try {
      await this.firestore.collection("called").doc(docId).set(data, { merge: true });
    } catch (err) {
      this.recordError(`upsertCalled(${docId})`, err);
    }
  }

  // ── Historial de llamados ─────────────────────────────────────────────────

  /** Guarda el llamado finalizado en care_history/{id} */
  public async saveCallHistory(record: CallHistoryRecord): Promise<void> {
    if (!this.enabled) return;
    try {
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
    } catch (err) {
      this.recordError(`saveCallHistory(${record.id})`, err);
    }
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
    try {
      await ref.set(
        {
          online: true,
          lastSeen: FieldValue.serverTimestamp(),
          source: "local-server-espnow",
        },
        { merge: true },
      );
    } catch (err) {
      this.recordError(`mirrorPresence(${deviceId})`, err);
    }
  }
}

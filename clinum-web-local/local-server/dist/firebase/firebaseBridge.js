import admin from "firebase-admin";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { existsSync, readFileSync } from "node:fs";
import { isSpecialCallType } from "../types.js";
export class FirebaseBridge {
    projectId;
    credentialPath;
    db = null;
    enabled;
    locationId;
    lastError = null;
    constructor(projectId, enabled, locationId = "", credentialPath = "") {
        this.projectId = projectId;
        this.credentialPath = credentialPath;
        this.enabled = enabled;
        this.locationId = locationId;
    }
    /** Inicializa el SDK. Si hay credentialPath válido, lo usa explícito (no depende
     *  de la variable de entorno GOOGLE_APPLICATION_CREDENTIALS, que en producción
     *  puede no estar seteada aunque el archivo exista en disco). */
    static initAdmin(projectId, enabled, credentialPath = "") {
        if (!enabled)
            return false;
        if (admin.apps.length > 0)
            return true;
        try {
            if (credentialPath && existsSync(credentialPath)) {
                const raw = JSON.parse(readFileSync(credentialPath, "utf8"));
                admin.initializeApp({ credential: admin.credential.cert(raw), projectId });
            }
            else {
                admin.initializeApp({ projectId });
            }
        }
        catch (err) {
            console.error("[firebase] initAdmin failed:", err instanceof Error ? err.message : err);
            return false;
        }
        return true;
    }
    /** Activa/desactiva el sync en caliente (sin reiniciar el proceso). Inicializa el SDK la primera vez que se activa. */
    setEnabled(enabled) {
        if (enabled && !this.enabled) {
            const ok = FirebaseBridge.initAdmin(this.projectId, true, this.credentialPath);
            if (!ok) {
                this.lastError = { message: "No se pudo inicializar el SDK de Firebase (ver logs del servidor)", atMs: Date.now() };
                return;
            }
        }
        this.enabled = enabled;
    }
    isEnabled() {
        return this.enabled;
    }
    getLastError() {
        return this.lastError;
    }
    recordError(context, err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = { message: `${context}: ${message}`, atMs: Date.now() };
        console.error(`[firebase] ${context}:`, err);
    }
    /** Cambia la sede sin reiniciar: afecta solo los próximos escritos (no reescribe los ya enviados). */
    setLocationId(locationId) {
        this.locationId = locationId;
    }
    get firestore() {
        if (!this.db) {
            this.db = getFirestore();
        }
        return this.db;
    }
    // ── Devices ──────────────────────────────────────────────────────────────
    /** Actualiza el documento devices/{deviceId} en Firestore (merge: no sobreescribe nombre/ubicación puestos desde el web) */
    async upsertDevice(record) {
        if (!this.enabled)
            return;
        try {
            await this.firestore.collection("devices").doc(record.deviceId).set({
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
            }, { merge: true });
        }
        catch (err) {
            this.recordError(`upsertDevice(${record.deviceId})`, err);
        }
    }
    // ── Called (estado activo) ────────────────────────────────────────────────
    async upsertCalled(state) {
        if (!this.enabled)
            return;
        const data = {
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
        }
        else {
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
        }
        catch (err) {
            this.recordError(`upsertCalled(${docId})`, err);
        }
    }
    // ── Historial de llamados ─────────────────────────────────────────────────
    /** Guarda el llamado finalizado en care_history/{id} */
    async saveCallHistory(record) {
        if (!this.enabled)
            return;
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
        }
        catch (err) {
            this.recordError(`saveCallHistory(${record.id})`, err);
        }
    }
    subscribeConfig(onConfig) {
        if (!this.enabled)
            return () => undefined;
        // Suggested structure: devices_config/{deviceId}
        return this.firestore.collection("devices_config").onSnapshot((snap) => {
            snap.docChanges().forEach((change) => {
                if (change.type === "removed")
                    return;
                onConfig(change.doc.id, change.doc.data());
            });
        });
    }
    async mirrorPresence(deviceId) {
        if (!this.enabled)
            return;
        const ref = this.firestore.collection("devices_presence").doc(deviceId);
        try {
            await ref.set({
                online: true,
                lastSeen: FieldValue.serverTimestamp(),
                source: "local-server-espnow",
            }, { merge: true });
        }
        catch (err) {
            this.recordError(`mirrorPresence(${deviceId})`, err);
        }
    }
}

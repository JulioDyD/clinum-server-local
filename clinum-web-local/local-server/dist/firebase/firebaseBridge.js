import admin from "firebase-admin";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { existsSync, readFileSync } from "node:fs";
import { isSpecialCallType } from "../types.js";
function stripUndefined(value) {
    if (Array.isArray(value)) {
        return value.map(item => stripUndefined(item));
    }
    if (value && typeof value === "object") {
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry !== undefined)
                result[key] = stripUndefined(entry);
        }
        return result;
    }
    return value;
}
export class FirebaseBridge {
    projectId;
    credentialPath;
    db = null;
    enabled;
    locationId;
    lastError = null;
    static lastInitError = "";
    /** Último snapshot estable enviado a Firestore para evitar escrituras repetidas. */
    lastDeviceSnapshot = new Map();
    /** Último llamado conocido por dispositivo (para que el fingerprint sea estable). */
    lastCallAtByDevice = new Map();
    lastPresenceSnapshot = "";
    outboxHandler = null;
    counters = {
        deviceWrites: 0,
        presenceWrites: 0,
        calledWrites: 0,
        historyWrites: 0,
        errors: 0,
    };
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
                const raw = JSON.parse(readFileSync(credentialPath, "utf8").replace(/^\uFEFF/, ""));
                if (raw?.project_id && projectId && raw.project_id !== projectId) {
                    throw new Error(`La credencial pertenece al proyecto ${raw.project_id}, no a ${projectId}`);
                }
                admin.initializeApp({ credential: admin.credential.cert(raw), projectId });
            }
            else {
                admin.initializeApp({ projectId });
            }
        }
        catch (err) {
            FirebaseBridge.lastInitError = err instanceof Error ? err.message : String(err);
            console.error("[firebase] initAdmin failed:", FirebaseBridge.lastInitError);
            return false;
        }
        return true;
    }
    /** Activa/desactiva el sync en caliente (sin reiniciar el proceso). Inicializa el SDK la primera vez que se activa. */
    setEnabled(enabled) {
        if (enabled && !this.enabled) {
            const ok = FirebaseBridge.initAdmin(this.projectId, true, this.credentialPath);
            if (!ok) {
                const detail = FirebaseBridge.lastInitError || "ver logs del servidor";
                this.lastError = { message: `No se pudo inicializar el SDK de Firebase: ${detail}`, atMs: Date.now() };
                return;
            }
        }
        this.enabled = enabled;
        this.lastError = null;
    }
    isEnabled() {
        return this.enabled;
    }
    getLastError() {
        return this.lastError;
    }
    getCounters() {
        return { ...this.counters };
    }
    /** Activa el outbox durable. Si no hay handler, las escrituras van directas. */
    setOutboxHandler(handler) {
        this.outboxHandler = handler;
    }
    sendOrQueue(kind, docId, payload, deleteFields = []) {
        if (this.outboxHandler) {
            this.outboxHandler(kind, docId, payload, deleteFields);
            return;
        }
        void this.writeQueued(kind, docId, payload, deleteFields).catch(() => undefined);
    }
    /** Escritura directa de una operación (usada por el outbox y por el modo directo). */
    async writeQueued(kind, docId, payload, deleteFields = []) {
        if (!this.enabled)
            return;
        const collectionName = kind === "device" ? "devices" : kind === "history" ? "care_history" : "called";
        const data = { ...payload };
        for (const field of deleteFields)
            data[field] = FieldValue.delete();
        if (kind === "called") {
            const startedAtMs = Number(payload.startedAtMs ?? 0);
            if (startedAtMs > 0) {
                data.startedAt = Timestamp.fromMillis(startedAtMs);
                data.timestamp = Timestamp.fromMillis(startedAtMs);
            }
            const endedAtMs = Number(payload.endedAtMs ?? 0);
            if (endedAtMs > 0)
                data.endedAt = Timestamp.fromMillis(endedAtMs);
            delete data.endedAtMs;
            data.updatedAt = FieldValue.serverTimestamp();
        }
        else if (kind === "device") {
            const lastSeenMs = Number(payload.lastSeenMs ?? Date.now());
            data.lastSeen = Timestamp.fromMillis(lastSeenMs);
            delete data.lastSeenMs;
            const lastCallAtMs = Number(payload.lastCallAtMs ?? 0);
            if (lastCallAtMs > 0)
                data.lastCallAt = Timestamp.fromMillis(lastCallAtMs);
            delete data.lastCallAtMs;
            data.updatedAt = FieldValue.serverTimestamp();
        }
        else {
            const startedAtMs = Number(payload.startedAtMs ?? 0);
            const endedAtMs = Number(payload.endedAtMs ?? 0);
            if (startedAtMs > 0)
                data.startedAt = Timestamp.fromMillis(startedAtMs);
            if (endedAtMs > 0)
                data.endedAt = Timestamp.fromMillis(endedAtMs);
            delete data.startedAtMs;
            delete data.endedAtMs;
            data.createdAt = FieldValue.serverTimestamp();
            data.updatedAt = FieldValue.serverTimestamp();
        }
        try {
            await this.firestore.collection(collectionName).doc(docId).set(data, { merge: true });
            if (kind === "device")
                this.counters.deviceWrites += 1;
            else if (kind === "called")
                this.counters.calledWrites += 1;
            else
                this.counters.historyWrites += 1;
        }
        catch (err) {
            this.recordError(`writeQueued(${kind}/${docId})`, err);
            throw err;
        }
    }
    recordError(context, err) {
        const message = err instanceof Error ? err.message : String(err);
        this.counters.errors += 1;
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
    /** Fuerza una escritura del dispositivo (registro o renombrado explícito). */
    async upsertDevice(record) {
        if (!this.enabled)
            return;
        const lastCallAtMs = this.lastCallAtByDevice.get(record.deviceId) ?? 0;
        const payload = this.buildDevicePayload(record, true, lastCallAtMs);
        this.lastDeviceSnapshot.set(record.deviceId, this.deviceFingerprint(record, true, lastCallAtMs));
        this.sendOrQueue("device", record.deviceId, payload);
    }
    /**
     * Escribe devices/{id} solo si cambió algo estable (online, nombre, ubicación,
     * tipo o último llamado). Los heartbeats ya no generan escrituras.
     */
    async updateDeviceIfChanged(record, extra = {}) {
        if (!this.enabled)
            return;
        const includeName = extra.includeName === true;
        if (extra.lastCallAtMs)
            this.lastCallAtByDevice.set(record.deviceId, extra.lastCallAtMs);
        const lastCallAtMs = extra.lastCallAtMs ?? this.lastCallAtByDevice.get(record.deviceId) ?? 0;
        const fingerprint = this.deviceFingerprint(record, includeName, lastCallAtMs);
        if (this.lastDeviceSnapshot.get(record.deviceId) === fingerprint)
            return;
        this.lastDeviceSnapshot.set(record.deviceId, fingerprint);
        this.sendOrQueue("device", record.deviceId, this.buildDevicePayload(record, includeName, lastCallAtMs));
    }
    buildDevicePayload(record, includeName, lastCallAtMs) {
        return {
            isOnline: record.online,
            lastSeenMs: record.lastSeenMs || Date.now(),
            mac: record.mac,
            ...(includeName && record.name ? { name: record.name } : {}),
            type: "caller",
            callerLocationType: record.callerLocationType,
            ...(this.locationId ? { locationId: this.locationId } : {}),
            ...(lastCallAtMs ? { lastCallAtMs } : {}),
            origin: "local-bridge",
            source: "espnow-local-bridge",
        };
    }
    deviceFingerprint(record, includeName, lastCallAtMs) {
        return JSON.stringify({
            online: record.online,
            mac: record.mac,
            name: includeName ? record.name ?? "" : "",
            callerLocationType: record.callerLocationType,
            locationId: this.locationId,
            lastCallAtMs: lastCallAtMs ?? 0,
        });
    }
    /**
     * Publica un único documento por sede con el lastSeen de todos los llamadores.
     * Reemplaza el costo de escribir N dispositivos en cada heartbeat.
     */
    async publishPresence(devices, onlineWindowS) {
        if (!this.enabled || !this.locationId)
            return;
        const map = {};
        for (const device of devices)
            map[device.deviceId] = device.lastSeenMs;
        const fingerprint = JSON.stringify({ onlineWindowS, map });
        if (fingerprint === this.lastPresenceSnapshot)
            return;
        try {
            await this.firestore.collection("site_presence").doc(this.locationId).set({
                locationId: this.locationId,
                onlineWindowS,
                devices: map,
                source: "local-server-espnow",
                updatedAt: FieldValue.serverTimestamp(),
            });
            this.lastPresenceSnapshot = fingerprint;
            this.counters.presenceWrites += 1;
        }
        catch (err) {
            this.lastPresenceSnapshot = "";
            this.recordError(`publishPresence(${this.locationId})`, err);
        }
    }
    /** Escucha cambios de configuración de la sede (ventana online, etc.). */
    subscribeSiteSettings(onSettings) {
        if (!this.enabled || !this.locationId)
            return () => undefined;
        return this.firestore.collection("site_settings").doc(this.locationId).onSnapshot((snap) => {
            const data = snap.data() ?? {};
            const raw = Number(data.onlineWindowS ?? data.online_window_s);
            if (!Number.isFinite(raw))
                return;
            onSettings({ onlineWindowS: Math.max(60, Math.min(600, raw)) });
        });
    }
    /**
     * Espeja los pacientes de la sede desde Firestore (el web es el dueño).
     * onSnapshot recibe la lista completa de IDs en el primer snapshot para
     * retirar del espejo local los que ya no existen en el web.
     */
    subscribePatients(onPatient, onSnapshot) {
        if (!this.enabled || !this.locationId)
            return () => undefined;
        let firstSnapshot = true;
        return this.firestore
            .collection("patients")
            .where("locationId", "==", this.locationId)
            .onSnapshot((snap) => {
            snap.docChanges().forEach((change) => {
                if (change.type === "removed") {
                    onPatient(null, change.doc.id);
                    return;
                }
                const patient = this.normalizeCloudPatient(change.doc.id, change.doc.data());
                if (patient)
                    onPatient(patient, change.doc.id);
            });
            if (firstSnapshot && onSnapshot) {
                const fromCache = snap.metadata?.fromCache === true;
                if (!fromCache) {
                    firstSnapshot = false;
                    onSnapshot(snap.docs.map(doc => doc.id));
                }
            }
        });
    }
    /** Escucha comandos pendientes de la web para esta sede. */
    subscribeSiteCommands(onCommand) {
        if (!this.enabled || !this.locationId)
            return () => undefined;
        return this.firestore
            .collection("site_sync")
            .doc(this.locationId)
            .collection("commands")
            .where("status", "==", "pending")
            .onSnapshot((snap) => {
            snap.docChanges().forEach((change) => {
                if (change.type === "removed")
                    return;
                const data = change.doc.data();
                if (data.status !== "pending")
                    return;
                onCommand(change.doc.id, String(data.type ?? ""), (data.payload ?? {}));
            });
        });
    }
    /** Publica una sección de estado de la sede para que la web la visualice. */
    async publishSiteSection(section, data) {
        if (!this.enabled || !this.locationId)
            return;
        const parent = this.firestore.collection("site_sync").doc(this.locationId);
        await parent.set({ locationId: this.locationId, updatedAt: FieldValue.serverTimestamp(), source: "local-bridge" }, { merge: true });
        await parent.collection("sections").doc(section).set({
            data: stripUndefined(data),
            revision: Date.now(),
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: "local-bridge",
        });
    }
    async markSiteCommand(commandId, status, result) {
        if (!this.enabled || !this.locationId || !commandId)
            return;
        try {
            await this.firestore
                .collection("site_sync")
                .doc(this.locationId)
                .collection("commands")
                .doc(commandId)
                .set({
                status,
                result: result ?? null,
                appliedAt: FieldValue.serverTimestamp(),
                appliedBy: "local-bridge",
            }, { merge: true });
        }
        catch (err) {
            this.recordError(`markSiteCommand(${commandId})`, err);
        }
    }
    normalizeCloudPatient(patientId, data) {
        if (!patientId)
            return null;
        const firstName = String(data.firstName ?? data.first_name ?? "").trim();
        const lastName = String(data.lastName ?? data.last_name ?? "").trim();
        const composed = `${firstName} ${lastName}`.trim();
        const name = String(data.name ?? data.fullName ?? data.full_name ?? composed ?? "").trim();
        const rawAdmission = data.admissionDate ?? data.admission_date;
        let admissionDate = null;
        if (typeof rawAdmission === "string" && rawAdmission.trim()) {
            admissionDate = rawAdmission.trim().slice(0, 16);
        }
        else if (rawAdmission && typeof rawAdmission.toDate === "function") {
            const date = rawAdmission.toDate();
            if (Number.isFinite(date.getTime()))
                admissionDate = date.toISOString().slice(0, 16);
        }
        const rawAge = data.age;
        const numericAge = rawAge === undefined || rawAge === null || rawAge === "" ? null : Number(rawAge);
        return {
            patientId,
            name: name || "Sin nombre",
            age: numericAge !== null && Number.isFinite(numericAge) ? numericAge : null,
            admissionDate,
            notes: typeof data.notes === "string" ? data.notes : null,
            assignedDevice: (data.assignedDevice ?? data.assigned_device ?? data.deviceId ?? null),
            createdAtMs: this.toMillis(data.createdAt ?? data.created_at) ?? undefined,
            updatedAtMs: this.toMillis(data.updatedAt ?? data.updated_at ?? data.updatedAtMs) ?? undefined,
        };
    }
    toMillis(value) {
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value === "string") {
            const parsed = Date.parse(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        const candidate = value;
        if (candidate && typeof candidate.toMillis === "function") {
            const ms = candidate.toMillis();
            return Number.isFinite(ms) ? ms : null;
        }
        if (candidate && typeof candidate.toDate === "function") {
            const date = candidate.toDate();
            return Number.isFinite(date.getTime()) ? date.getTime() : null;
        }
        return null;
    }
    // ── Called (estado activo) ────────────────────────────────────────────────
    async upsertCalled(state) {
        if (!this.enabled)
            return;
        const payload = {
            deviceId: state.deviceId,
            active: state.active,
            cons: state.cons,
            call_type: state.call_type,
            startedAtMs: state.startedAtMs,
            origin: "local-bridge",
            ...(this.locationId ? { locationId: this.locationId } : {}),
            ...(state.patientName ? { patientName: state.patientName } : {}),
        };
        const deleteFields = [];
        if (state.active) {
            // Limpiar el cierre anterior: si no, un nuevo llamado conserva endedAt.
            deleteFields.push("endedAt", "endedAtMs", "finishOrigin", "finishOriginUpdatedAt");
        }
        else {
            payload.endedAtMs = state.updatedAtMs || Date.now();
            if (state.finishOrigin)
                payload.finishOrigin = state.finishOrigin;
        }
        // Un llamador puede tener varios especiales concurrentes: cada tipo vive en
        // su propio documento para no pisarse. Normal/emergencia siguen en el doc
        // del dispositivo (uno solo a la vez).
        const docId = isSpecialCallType(state.call_type)
            ? `${state.deviceId}_${state.call_type}`
            : state.deviceId;
        this.sendOrQueue("called", docId, payload, deleteFields);
    }
    // ── Historial de llamados ─────────────────────────────────────────────────
    /** Guarda el llamado finalizado en care_history con el esquema que usan los reportes. */
    async saveCallHistory(record, context = {}) {
        if (!this.enabled)
            return;
        const attentionTimeMin = Number.isFinite(context.attentionTimeMin) ? Number(context.attentionTimeMin) : 5;
        const timeToAttendSeconds = Math.max(0, Math.round(record.durationMs / 1000));
        const durationMinutes = Math.round(record.durationMs / 60_000);
        const finishOrigin = record.finishOrigin === "monitor" ? "app" : "physical";
        // ID determinista: repetir el cierre no duplica el historial.
        const docId = `${record.deviceId}_${record.startedAtMs}`;
        const payload = {
            deviceId: record.deviceId,
            device: record.deviceId,
            deviceName: context.deviceName ?? null,
            locationId: this.locationId || null,
            locationName: context.locationName ?? null,
            floor: null,
            room: null,
            roomName: null,
            bed: null,
            bedName: null,
            patientName: record.patientName ?? null,
            patientFullName: record.patientName ?? null,
            callType: record.call_type,
            call_type: record.call_type,
            reportCallType: record.call_type,
            cons: record.cons,
            consecutive: record.cons,
            consecutiveCount: record.cons,
            startedAtMs: record.startedAtMs,
            endedAtMs: record.endedAtMs,
            durationMinutes,
            timeToAttendSeconds,
            attentionThresholdMinutes: attentionTimeMin,
            onTime: timeToAttendSeconds <= attentionTimeMin * 60,
            source: "physical",
            finishOrigin,
            finishOriginSource: record.finishOrigin ? "explicit" : "inferred",
        };
        this.sendOrQueue("history", docId, payload);
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

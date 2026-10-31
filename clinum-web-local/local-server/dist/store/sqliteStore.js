import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { isSpecialCallType } from "../types.js";
// ── Helpers ──────────────────────────────────────────────────────────────────
function ensureDir(filePath) {
    try {
        mkdirSync(dirname(filePath), { recursive: true });
    }
    catch { /* ignore */ }
}
function normalizePresenceRole(value) {
    if (value === "sillon")
        return "sillon";
    if (value === "cama" || value === "bed")
        return "cama";
    return "bathroom";
}
// ── SqliteStore ───────────────────────────────────────────────────────────────
export class SqliteStore {
    db;
    constructor(dbPath) {
        ensureDir(dbPath);
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this._migrate();
    }
    // ── Schema ──────────────────────────────────────────────────────────────────
    _migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id       TEXT PRIMARY KEY,
        mac             TEXT NOT NULL DEFAULT '',
        name            TEXT,
        online          INTEGER NOT NULL DEFAULT 0,
        last_seen_ms    INTEGER NOT NULL DEFAULT 0,
        registered_at_ms INTEGER NOT NULL DEFAULT 0,
        transport       TEXT NOT NULL DEFAULT '',
        firmware_version TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS active_calls (
        device_id    TEXT PRIMARY KEY,
        active       INTEGER NOT NULL DEFAULT 0,
        cons         INTEGER NOT NULL DEFAULT 0,
        call_type    TEXT NOT NULL DEFAULT 'normal',
        started_at_ms INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL DEFAULT 0,
        start_seq    INTEGER NOT NULL DEFAULT 0,
        last_seq     INTEGER NOT NULL DEFAULT 0
      );

      -- Llamados especiales (type3..type6): uno por (dispositivo, tipo), de modo
      -- que un mismo llamador puede tener varios especiales activos a la vez sin
      -- pisarse entre ellos. active_calls queda reservada a normal/emergency.
      CREATE TABLE IF NOT EXISTS active_special_calls (
        device_id     TEXT NOT NULL,
        call_type     TEXT NOT NULL,
        active        INTEGER NOT NULL DEFAULT 1,
        cons          INTEGER NOT NULL DEFAULT 0,
        started_at_ms INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL DEFAULT 0,
        start_seq     INTEGER NOT NULL DEFAULT 0,
        last_seq      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, call_type)
      );

      CREATE TABLE IF NOT EXISTS call_history (
        id            TEXT PRIMARY KEY,
        device_id     TEXT NOT NULL,
        call_type     TEXT NOT NULL DEFAULT 'normal',
        cons          INTEGER NOT NULL DEFAULT 0,
        started_at_ms INTEGER NOT NULL DEFAULT 0,
        ended_at_ms   INTEGER NOT NULL DEFAULT 0,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        patient_name  TEXT NOT NULL DEFAULT '',
        finish_origin TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS seq_tracker (
        device_id TEXT PRIMARY KEY,
        last_seq  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS lamps (
        lamp_id             TEXT PRIMARY KEY,
        mac                 TEXT NOT NULL DEFAULT '',
        name                TEXT,
        online              INTEGER NOT NULL DEFAULT 0,
        last_seen_ms        INTEGER NOT NULL DEFAULT 0,
        registered_at_ms    INTEGER NOT NULL DEFAULT 0,
        relay_capable       INTEGER NOT NULL DEFAULT 1,
        protocol_version    INTEGER NOT NULL DEFAULT 1,
        audio_enabled       INTEGER NOT NULL DEFAULT 1,
        brightness          INTEGER NOT NULL DEFAULT 100,
        buzzer_volume       INTEGER NOT NULL DEFAULT 100,
        transport           TEXT NOT NULL DEFAULT 'espnow',
        pending_transport   TEXT,
        transport_requested_at_ms INTEGER,
        applied_revision    INTEGER NOT NULL DEFAULT 0,
        applied_state       TEXT NOT NULL DEFAULT 'off'
      );

      CREATE TABLE IF NOT EXISTS caller_lamps (
        caller_device_id TEXT NOT NULL,
        lamp_id          TEXT NOT NULL,
        PRIMARY KEY (caller_device_id, lamp_id),
        FOREIGN KEY (lamp_id) REFERENCES lamps(lamp_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS special_profile_lamps (
        call_type  TEXT NOT NULL,
        lamp_id    TEXT NOT NULL,
        PRIMARY KEY (call_type, lamp_id),
        FOREIGN KEY (lamp_id) REFERENCES lamps(lamp_id) ON DELETE CASCADE
      );

      -- Pacientes (asignación 1:1 con un llamador). assigned_device UNIQUE
      -- garantiza que un llamador no tenga dos pacientes a la vez (NULL = libre).
      CREATE TABLE IF NOT EXISTS patients (
        patient_id      TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        age             INTEGER,
        admission_date  TEXT,
        notes           TEXT,
        assigned_device TEXT UNIQUE,
        created_at_ms   INTEGER NOT NULL DEFAULT 0,
        updated_at_ms   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS lamp_alert_profiles (
        call_type         TEXT PRIMARY KEY,
        label             TEXT NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 0,
        color_preset      INTEGER NOT NULL DEFAULT 0,
        animation_preset  INTEGER NOT NULL DEFAULT 0,
        sound_preset      INTEGER NOT NULL DEFAULT 0,
        audio_enabled     INTEGER NOT NULL DEFAULT 1,
        auto_end_s        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS location_settings (
        id                    INTEGER PRIMARY KEY CHECK (id = 1),
        name                  TEXT NOT NULL DEFAULT 'Sede principal',
        attention_time_min    INTEGER NOT NULL DEFAULT 5,
        background_color      TEXT NOT NULL DEFAULT '#0f172a',
        header_color          TEXT NOT NULL DEFAULT '#f59e0b',
        text_color            TEXT NOT NULL DEFAULT '#ffffff',
        normal_call_color     TEXT NOT NULL DEFAULT '#22c55e',
        emergency_call_color  TEXT NOT NULL DEFAULT '#ef4444',
        timer_color           TEXT NOT NULL DEFAULT '#22c55e',
        sound_enabled         INTEGER NOT NULL DEFAULT 1,
        sound_volume          INTEGER NOT NULL DEFAULT 80,
        alert_sound           TEXT NOT NULL DEFAULT 'clinum_normal.mp3',
        emergency_sound       TEXT NOT NULL DEFAULT 'clinum_emergency.mp3',
        voice_enabled         INTEGER NOT NULL DEFAULT 1,
        voice_rate            REAL NOT NULL DEFAULT 1.0,
        voice_pitch           REAL NOT NULL DEFAULT 1.0,
        voice_volume          REAL NOT NULL DEFAULT 0.9,
        pending_reminder_enabled INTEGER NOT NULL DEFAULT 0,
        pending_reminder_interval_s INTEGER NOT NULL DEFAULT 120,
        ui_scale_percent INTEGER NOT NULL DEFAULT 100
      );

      CREATE INDEX IF NOT EXISTS idx_call_history_device ON call_history(device_id);
      CREATE INDEX IF NOT EXISTS idx_call_history_started ON call_history(started_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_caller_lamps_lamp ON caller_lamps(lamp_id);
      CREATE TABLE IF NOT EXISTS event_receipts (
        device_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        PRIMARY KEY(device_id, seq)
      );
      CREATE TABLE IF NOT EXISTS pending_commands (
        device_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_sent_at_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(device_id, kind)
      );
      CREATE TABLE IF NOT EXISTS reliability_counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_received ON event_receipts(received_at_ms);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        name          TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL DEFAULT 0
      );

      -- Monitor de presencia (baños/camas). Todo aditivo: se puede desactivar
      -- por flags sin tocar el flujo de llamados ni las lámparas.
      CREATE TABLE IF NOT EXISTS presence_sensors (
        device_id     TEXT PRIMARY KEY,
        role          TEXT NOT NULL DEFAULT 'bathroom',
        area_name     TEXT NOT NULL DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at_ms INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS presence_sessions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id         TEXT NOT NULL,
        role              TEXT NOT NULL DEFAULT 'bathroom',
        area_name         TEXT NOT NULL DEFAULT '',
        patient_id        TEXT,
        patient_name      TEXT NOT NULL DEFAULT '',
        entered_at_ms     INTEGER NOT NULL,
        last_seen_at_ms   INTEGER NOT NULL,
        exited_at_ms      INTEGER,
        duration_ms       INTEGER,
        close_reason      TEXT NOT NULL DEFAULT '',
        alert_sent_at_ms  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_presence_sessions_device ON presence_sessions(device_id);
      CREATE INDEX IF NOT EXISTS idx_presence_sessions_entered ON presence_sessions(entered_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_presence_sessions_open ON presence_sessions(exited_at_ms);
      CREATE TABLE IF NOT EXISTS presence_settings (
        id                    INTEGER PRIMARY KEY CHECK (id = 1),
        enabled               INTEGER NOT NULL DEFAULT 0,
        show_on_location      INTEGER NOT NULL DEFAULT 0,
        show_free_on_location INTEGER NOT NULL DEFAULT 1,
        exit_grace_s          INTEGER NOT NULL DEFAULT 20,
        min_session_s         INTEGER NOT NULL DEFAULT 5,
        stale_s               INTEGER NOT NULL DEFAULT 180,
        long_stay_min         INTEGER NOT NULL DEFAULT 15,
        alert_enabled         INTEGER NOT NULL DEFAULT 1
      );
    `);
        this.db.prepare("INSERT OR IGNORE INTO location_settings (id) VALUES (1)").run();
        this.db.prepare("INSERT OR IGNORE INTO presence_settings (id) VALUES (1)").run();
        const normalColorMigration = this.db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get("normal_call_color_green");
        if (!normalColorMigration) {
            this.db.prepare("UPDATE location_settings SET normal_call_color = '#22c55e' WHERE normal_call_color = '#0ea5e9'").run();
            this.db.prepare("INSERT INTO schema_migrations (name, applied_at_ms) VALUES (?, ?)").run("normal_call_color_green", Date.now());
        }
        const insertProfile = this.db.prepare(`
      INSERT OR IGNORE INTO lamp_alert_profiles
        (call_type, label, enabled, color_preset, animation_preset, sound_preset, audio_enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
        insertProfile.run("normal", "Llamado normal", 1, 10, 1, 1);
        insertProfile.run("emergency", "Llamados de emergencia", 1, 0, 4, 4);
        insertProfile.run("type3", "Profesional medico", 1, 4, 7, 7);
        insertProfile.run("type4", "Profesional del aseo", 1, 6, 10, 10);
        insertProfile.run("type5", "Profesional seguridad", 1, 8, 13, 13);
        insertProfile.run("type6", "Acompanante o familiar", 1, 9, 16, 16);
        insertProfile.run("presence", "Presencia", 1, 7, 1, 17);
        // Migración: habilitar especiales en BDs existentes (antes reservados)
        this.db.prepare("UPDATE lamp_alert_profiles SET enabled = 1 WHERE call_type IN ('type3','type4','type5')").run();
        this.db.prepare("UPDATE lamp_alert_profiles SET label = 'Profesional medico' WHERE call_type = 'type3' AND label = 'Tipo 3'").run();
        this.db.prepare("UPDATE lamp_alert_profiles SET label = 'Profesional del aseo' WHERE call_type = 'type4' AND label = 'Tipo 4'").run();
        this.db.prepare("UPDATE lamp_alert_profiles SET label = 'Profesional seguridad' WHERE call_type = 'type5' AND label = 'Tipo 5'").run();
        // Migración: renombrar etiqueta del perfil de emergencia en BDs existentes
        this.db.prepare("UPDATE lamp_alert_profiles SET label = 'Llamados de emergencia' WHERE call_type = 'emergency' AND label = 'Emergencia'").run();
        const callColumns = this.db.pragma("table_info(active_calls)");
        if (!callColumns.some(column => column.name === "start_seq")) {
            this.db.exec("ALTER TABLE active_calls ADD COLUMN start_seq INTEGER NOT NULL DEFAULT 0");
        }
        // Migración: los especiales activos pasan a active_special_calls (varios
        // concurrentes por dispositivo); active_calls queda solo para normal/emergency.
        this._migrateSpecialCalls();
        // Repara bases de datos pre-existentes que tenían una tabla `lamps` con un esquema anterior.
        this._ensureColumn("lamps", "relay_capable", "INTEGER NOT NULL DEFAULT 1");
        this._ensureColumn("lamps", "protocol_version", "INTEGER NOT NULL DEFAULT 1");
        this._ensureColumn("lamps", "audio_enabled", "INTEGER NOT NULL DEFAULT 1");
        this._ensureColumn("lamps", "brightness", "INTEGER NOT NULL DEFAULT 100");
        this._ensureColumn("lamps", "buzzer_volume", "INTEGER NOT NULL DEFAULT 100");
        this._ensureColumn("lamps", "applied_revision", "INTEGER NOT NULL DEFAULT 0");
        this._ensureColumn("lamps", "applied_state", "TEXT NOT NULL DEFAULT 'off'");
        this._ensureColumn("lamps", "transport", "TEXT NOT NULL DEFAULT 'espnow'");
        this._ensureColumn("lamps", "pending_transport", "TEXT");
        this._ensureColumn("lamps", "transport_requested_at_ms", "INTEGER");
        this._ensureColumn("devices", "caller_location_type", "TEXT NOT NULL DEFAULT 'cama'");
        this._ensureColumn("devices", "transport", "TEXT NOT NULL DEFAULT ''");
        this._ensureColumn("devices", "firmware_version", "TEXT NOT NULL DEFAULT ''");
        this._ensureColumn("location_settings", "attention_time_min", "INTEGER NOT NULL DEFAULT 5");
        this._ensureColumn("location_settings", "pending_reminder_enabled", "INTEGER NOT NULL DEFAULT 0");
        this._ensureColumn("location_settings", "pending_reminder_interval_s", "INTEGER NOT NULL DEFAULT 120");
        this._ensureColumn("location_settings", "ui_scale_percent", "INTEGER NOT NULL DEFAULT 100");
        this._ensureColumn("call_history", "patient_name", "TEXT NOT NULL DEFAULT ''");
        this._ensureColumn("call_history", "finish_origin", "TEXT NOT NULL DEFAULT ''");
        this._ensureColumn("lamp_alert_profiles", "auto_end_s", "INTEGER NOT NULL DEFAULT 0");
    }
    _ensureColumn(table, column, definition) {
        const columns = this.db.pragma(`table_info(${table})`);
        if (!columns.some(existing => existing.name === column)) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    }
    _migrateSpecialCalls() {
        const specialList = "'type3','type4','type5','type6'";
        const activeSpecials = this.db
            .prepare(`SELECT * FROM active_calls WHERE active = 1 AND call_type IN (${specialList})`)
            .all();
        if (activeSpecials.length > 0) {
            const insert = this.db.prepare(`
        INSERT OR IGNORE INTO active_special_calls
          (device_id, call_type, active, cons, started_at_ms, updated_at_ms, start_seq, last_seq)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `);
            const move = this.db.transaction(() => {
                for (const row of activeSpecials) {
                    insert.run(row.device_id, row.call_type, row.cons, row.started_at_ms, row.updated_at_ms, row.start_seq, row.last_seq);
                }
                this.db.prepare(`DELETE FROM active_calls WHERE active = 1 AND call_type IN (${specialList})`).run();
            });
            move();
        }
        // Filas inactivas de especiales (marcadores de fin): normalizarlas para que
        // la lógica de reintento de fin de llamada no las trate como llamada propia.
        this.db.prepare(`UPDATE active_calls SET call_type = 'normal' WHERE active = 0 AND call_type IN (${specialList})`).run();
    }
    // ── Row → Type mappers ────────────────────────────────────────────────────
    _rowToDevice(row) {
        const transport = row.transport || undefined;
        return {
            deviceId: row.device_id,
            mac: row.mac,
            name: row.name,
            online: Boolean(row.online),
            lastSeenMs: row.last_seen_ms,
            registeredAtMs: row.registered_at_ms,
            callerLocationType: row.caller_location_type ?? "cama",
            transport,
            firmwareVersion: row.firmware_version || undefined,
        };
    }
    _rowToCall(row) {
        return {
            deviceId: row.device_id,
            active: Boolean(row.active),
            cons: row.cons,
            call_type: row.call_type,
            startedAtMs: row.started_at_ms,
            updatedAtMs: row.updated_at_ms,
            startSeq: row.start_seq,
            lastSeq: row.last_seq,
        };
    }
    _rowToHistory(row) {
        const patientName = row.patient_name || undefined;
        const finishOrigin = row.finish_origin === "monitor" ? "monitor"
            : row.finish_origin === "llamador" ? "llamador" : undefined;
        return {
            id: row.id,
            deviceId: row.device_id,
            call_type: row.call_type,
            cons: row.cons,
            startedAtMs: row.started_at_ms,
            endedAtMs: row.ended_at_ms,
            durationMs: row.duration_ms,
            ...(patientName ? { patientName } : {}),
            ...(finishOrigin ? { finishOrigin } : {}),
        };
    }
    _rowToPatient(row) {
        return {
            patientId: row.patient_id,
            name: row.name,
            age: row.age === null || row.age === undefined ? undefined : Number(row.age),
            admissionDate: row.admission_date || undefined,
            notes: row.notes || undefined,
            assignedDevice: row.assigned_device || null,
            createdAtMs: row.created_at_ms,
            updatedAtMs: row.updated_at_ms,
        };
    }
    _rowToLamp(row) {
        return {
            lampId: row.lamp_id,
            mac: row.mac,
            name: row.name,
            online: Boolean(row.online),
            lastSeenMs: row.last_seen_ms,
            registeredAtMs: row.registered_at_ms,
            relayCapable: Boolean(row.relay_capable),
            protocolVersion: row.protocol_version,
            audioEnabled: Boolean(row.audio_enabled),
            brightness: row.brightness,
            buzzerVolume: row.buzzer_volume,
            transport: row.transport || "espnow",
            pendingTransport: row.pending_transport ?? undefined,
            transportRequestedAtMs: row.transport_requested_at_ms ?? undefined,
            appliedRevision: row.applied_revision,
            appliedState: row.applied_state,
        };
    }
    // ── Seq tracking ──────────────────────────────────────────────────────────
    // Receipts viejos no deben bloquear un seq reutilizado tras reboot/erase del
    // terminal. Si el fingerprint difiere pero el receipt anterior es antiguo, se
    // sobrescribe y el evento nuevo se aplica como llamado fresco.
    static RECEIPT_REUSE_WINDOW_MS = 5 * 60 * 1000;
    /** Receipt and state mutation commit together, before any acknowledgement. */
    receiveCallEvent(frame, apply) {
        const fingerprint = JSON.stringify([frame.msgType, frame.call_type ?? "normal", frame.cons ?? 0, frame.callId ?? 0]);
        return this.db.transaction(() => {
            const receipt = this.db
                .prepare("SELECT fingerprint, received_at_ms FROM event_receipts WHERE device_id = ? AND seq = ?")
                .get(frame.deviceId, frame.seq);
            if (receipt) {
                if (receipt.fingerprint === fingerprint) {
                    this.incrementReliability("duplicate");
                    return { result: "duplicate" };
                }
                const ageMs = Date.now() - receipt.received_at_ms;
                if (ageMs < SqliteStore.RECEIPT_REUSE_WINDOW_MS) {
                    this.incrementReliability("invalid");
                    return { result: "invalid" };
                }
            }
            if (this.isDuplicateOrOld(frame.deviceId, frame.seq)) {
                this.incrementReliability("stale");
                return { result: "stale" };
            }
            if (frame.callId && !isSpecialCallType(frame.call_type ?? "normal")) {
                const state = this.getCallForDevice(frame.deviceId);
                const invalidStart = frame.msgType === "call_start" && (state?.active ? state.startSeq !== frame.callId : frame.callId !== frame.seq);
                const invalidContinuation = frame.msgType !== "call_start" && (!state || state.startSeq !== frame.callId || (frame.msgType === "call_insist" && !state.active));
                if (invalidStart || invalidContinuation) {
                    this.incrementReliability("stale");
                    return { result: "stale" };
                }
            }
            const value = apply();
            if (receipt) {
                this.db
                    .prepare("UPDATE event_receipts SET fingerprint = ?, received_at_ms = ? WHERE device_id = ? AND seq = ?")
                    .run(fingerprint, Date.now(), frame.deviceId, frame.seq);
            }
            else {
                this.db.prepare("INSERT INTO event_receipts(device_id,seq,fingerprint,received_at_ms) VALUES (?,?,?,?)").run(frame.deviceId, frame.seq, fingerprint, Date.now());
            }
            this.incrementReliability("committed");
            return { result: "ok", value };
        })();
    }
    incrementReliability(name) {
        this.db.prepare("INSERT INTO reliability_counters(name,value) VALUES (?,1) ON CONFLICT(name) DO UPDATE SET value=value+1").run(name);
    }
    getReliabilityCounters() {
        return Object.fromEntries(this.db.prepare("SELECT name,value FROM reliability_counters").all().map(r => [r.name, r.value]));
    }
    savePendingCommand(deviceId, kind, seq, payload) {
        this.db.prepare(`INSERT INTO pending_commands(device_id,kind,seq,payload) VALUES (?,?,?,?)
      ON CONFLICT(device_id,kind) DO UPDATE SET seq=excluded.seq,payload=excluded.payload,attempts=0,last_sent_at_ms=0`).run(deviceId, kind, seq, JSON.stringify(payload));
    }
    nextCommandSeq() {
        return this.transaction(() => {
            const row = this.db.prepare("SELECT value FROM reliability_counters WHERE name='command_sequence'").get();
            const value = ((row?.value ?? (Date.now() >>> 0)) + 1) >>> 0 || 1;
            this.db.prepare("INSERT INTO reliability_counters(name,value) VALUES ('command_sequence',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(value);
            return value;
        });
    }
    getPendingCommands() {
        return this.db.prepare("SELECT * FROM pending_commands").all().map(r => ({
            deviceId: r.device_id, kind: r.kind, seq: r.seq,
            payload: JSON.parse(r.payload), attempts: r.attempts, lastSentAtMs: r.last_sent_at_ms,
        }));
    }
    confirmPendingCommand(deviceId, seq) {
        this.db.prepare("DELETE FROM pending_commands WHERE device_id=? AND seq=?").run(deviceId, seq);
    }
    cancelPendingCommand(deviceId, kind) {
        this.db.prepare("DELETE FROM pending_commands WHERE device_id=? AND kind=?").run(deviceId, kind);
    }
    markCommandSent(deviceId, kind) {
        this.db.prepare("UPDATE pending_commands SET attempts=attempts+1,last_sent_at_ms=? WHERE device_id=? AND kind=?").run(Date.now(), deviceId, kind);
    }
    clearPendingCommands() {
        return this.db.prepare("DELETE FROM pending_commands").run().changes;
    }
    transaction(work) { return this.db.transaction(work)(); }
    isDuplicateOrOld(deviceId, seq) {
        const row = this.db
            .prepare("SELECT last_seq FROM seq_tracker WHERE device_id = ?")
            .get(deviceId);
        return row !== undefined && seq <= row.last_seq;
    }
    markSeq(deviceId, seq) {
        this.db
            .prepare("INSERT INTO seq_tracker (device_id, last_seq) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seq = excluded.last_seq")
            .run(deviceId, seq);
    }
    // ── Devices ───────────────────────────────────────────────────────────────
    registerDevice(deviceId, mac, initialName, transport, firmwareVersion) {
        const now = Date.now();
        this.db.prepare(`
      INSERT INTO devices (device_id, mac, name, online, last_seen_ms, registered_at_ms, transport, firmware_version)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        mac            = CASE WHEN excluded.mac != '' THEN excluded.mac ELSE devices.mac END,
        name           = CASE
                           WHEN excluded.name IS NOT NULL AND (
                             devices.name IS NULL OR trim(devices.name) = '' OR
                             devices.name = 'Dispositivo' OR
                             devices.name GLOB 'Dispositivo [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
                           ) THEN excluded.name
                           ELSE devices.name
                         END,
        online         = 1,
        last_seen_ms   = excluded.last_seen_ms,
        transport       = COALESCE(NULLIF(excluded.transport, ''), devices.transport),
        firmware_version = COALESCE(NULLIF(excluded.firmware_version, ''), devices.firmware_version)
    `).run(deviceId, mac || "", initialName || null, now, now, transport ?? "", firmwareVersion ?? "");
        return this._rowToDevice(this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId));
    }
    touchDevice(deviceId, mac, transport, firmwareVersion) {
        const now = Date.now();
        this.db.prepare(`
      INSERT INTO devices (device_id, mac, online, last_seen_ms, registered_at_ms, transport, firmware_version)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        mac          = CASE WHEN excluded.mac != '' THEN excluded.mac ELSE devices.mac END,
        online       = 1,
        last_seen_ms = excluded.last_seen_ms,
        transport       = COALESCE(NULLIF(excluded.transport, ''), devices.transport),
        firmware_version = COALESCE(NULLIF(excluded.firmware_version, ''), devices.firmware_version)
    `).run(deviceId, mac || "", now, now, transport ?? "", firmwareVersion ?? "");
        return this._rowToDevice(this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId));
    }
    getDevice(deviceId) {
        const row = this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId);
        return row ? this._rowToDevice(row) : undefined;
    }
    getDevices() {
        return this.db.prepare("SELECT * FROM devices ORDER BY registered_at_ms ASC").all()
            .map(r => this._rowToDevice(r));
    }
    updateDeviceName(deviceId, name) {
        const result = this.db
            .prepare("UPDATE devices SET name = ? WHERE device_id = ?")
            .run(name, deviceId);
        if (result.changes === 0)
            return undefined;
        return this._rowToDevice(this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId));
    }
    updateDeviceLocationType(deviceId, callerLocationType) {
        const allowed = new Set(["cama", "sillon", "bano"]);
        const value = allowed.has(callerLocationType) ? callerLocationType : "cama";
        const result = this.db
            .prepare("UPDATE devices SET caller_location_type = ? WHERE device_id = ?")
            .run(value, deviceId);
        if (result.changes === 0)
            return undefined;
        return this._rowToDevice(this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId));
    }
    deleteDevice(deviceId) {
        const result = this.db.transaction(() => {
            this.db.prepare("UPDATE patients SET assigned_device = NULL, updated_at_ms = ? WHERE assigned_device = ?").run(Date.now(), deviceId);
            this.db.prepare("DELETE FROM active_calls        WHERE device_id = ?").run(deviceId);
            this.db.prepare("DELETE FROM active_special_calls WHERE device_id = ?").run(deviceId);
            this.db.prepare("DELETE FROM seq_tracker   WHERE device_id = ?").run(deviceId);
            this.db.prepare("DELETE FROM event_receipts WHERE device_id = ?").run(deviceId);
            this.db.prepare("DELETE FROM pending_commands WHERE device_id = ?").run(deviceId);
            this.db.prepare("DELETE FROM presence_sensors WHERE device_id = ?").run(deviceId);
            return this.db.prepare("DELETE FROM devices WHERE device_id = ?").run(deviceId);
        })();
        return result.changes > 0;
    }
    // ── Sound lamps ──────────────────────────────────────────────────────────
    registerLamp(lampId, mac, relayCapable = true, protocolVersion = 1, initialName, transport = "espnow") {
        const now = Date.now();
        this.db.prepare(`
      INSERT INTO lamps (lamp_id, mac, name, online, last_seen_ms, registered_at_ms, relay_capable, protocol_version, transport)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(lamp_id) DO UPDATE SET
        mac              = CASE WHEN excluded.mac != '' THEN excluded.mac ELSE lamps.mac END,
        online           = 1,
        last_seen_ms     = excluded.last_seen_ms,
        relay_capable    = excluded.relay_capable,
        protocol_version = excluded.protocol_version,
        transport        = excluded.transport,
        pending_transport = CASE
          WHEN lamps.pending_transport = excluded.transport THEN NULL
          ELSE lamps.pending_transport
        END,
        transport_requested_at_ms = CASE
          WHEN lamps.pending_transport = excluded.transport THEN NULL
          ELSE lamps.transport_requested_at_ms
        END
    `).run(lampId, mac || "", initialName || null, now, now, relayCapable ? 1 : 0, protocolVersion, transport);
        return this.getLamp(lampId);
    }
    touchLamp(lampId, mac, appliedRevision, appliedState, observedTransport) {
        const existing = this.getLamp(lampId);
        const lamp = existing
            ? this.registerLamp(lampId, mac ?? "", existing.relayCapable, existing.protocolVersion, undefined, existing.transport)
            : this.registerLamp(lampId, mac ?? "");
        if (observedTransport && existing?.pendingTransport === observedTransport) {
            this.db.prepare(`
        UPDATE lamps
        SET transport = ?, pending_transport = NULL, transport_requested_at_ms = NULL
        WHERE lamp_id = ?
      `).run(observedTransport, lampId);
        }
        if (appliedRevision !== undefined && appliedState !== undefined) {
            this.db.prepare(`
        UPDATE lamps SET applied_revision = ?, applied_state = ? WHERE lamp_id = ?
      `).run(appliedRevision, appliedState, lampId);
        }
        return this.getLamp(lampId) ?? lamp;
    }
    getLamp(lampId) {
        const row = this.db.prepare("SELECT * FROM lamps WHERE lamp_id = ?").get(lampId);
        return row ? this._rowToLamp(row) : undefined;
    }
    getLamps() {
        return this.db.prepare("SELECT * FROM lamps ORDER BY registered_at_ms ASC").all()
            .map(row => this._rowToLamp(row));
    }
    updateLamp(lampId, values) {
        const current = this.getLamp(lampId);
        if (!current)
            return undefined;
        const brightness = Math.max(1, Math.min(100, Math.round(values.brightness ?? current.brightness)));
        const buzzerVolume = Math.max(0, Math.min(100, Math.round(values.buzzerVolume ?? current.buzzerVolume)));
        this.db.prepare(`
      UPDATE lamps SET name = ?, audio_enabled = ?, brightness = ?, buzzer_volume = ? WHERE lamp_id = ?
    `).run(values.name ?? current.name ?? null, (values.audioEnabled ?? current.audioEnabled) ? 1 : 0, brightness, buzzerVolume, lampId);
        return this.getLamp(lampId);
    }
    requestLampTransport(lampId, transport) {
        const current = this.getLamp(lampId);
        if (!current)
            return undefined;
        this.db.prepare(`
      UPDATE lamps SET pending_transport = ?, transport_requested_at_ms = ? WHERE lamp_id = ?
    `).run(transport, Date.now(), lampId);
        return this.getLamp(lampId);
    }
    deleteLamp(lampId) {
        return this.db.prepare("DELETE FROM lamps WHERE lamp_id = ?").run(lampId).changes > 0;
    }
    getLampIdsForCaller(callerDeviceId) {
        return this.db.prepare(`
      SELECT lamp_id FROM caller_lamps WHERE caller_device_id = ? ORDER BY lamp_id
    `).all(callerDeviceId).map(row => row.lamp_id);
    }
    getCallerIdsForLamp(lampId) {
        return this.db.prepare(`
      SELECT caller_device_id FROM caller_lamps WHERE lamp_id = ?
    `).all(lampId).map(row => row.caller_device_id);
    }
    setLampAssignments(callerDeviceId, lampIds) {
        const uniqueLampIds = [...new Set(lampIds)];
        const replace = this.db.transaction(() => {
            for (const lampId of uniqueLampIds) {
                if (!this.getLamp(lampId))
                    throw new Error(`Unknown lamp: ${lampId}`);
            }
            this.db.prepare("DELETE FROM caller_lamps WHERE caller_device_id = ?").run(callerDeviceId);
            const insert = this.db.prepare("INSERT INTO caller_lamps (caller_device_id, lamp_id) VALUES (?, ?)");
            for (const lampId of uniqueLampIds)
                insert.run(callerDeviceId, lampId);
        });
        replace();
        return this.getLampIdsForCaller(callerDeviceId);
    }
    getEffectiveLampState(lampId) {
        // Prioridad: emergency > normal > especiales (type3..type6)
        // caller_lamps solo aplica a llamados normales/emergencia; los especiales
        // usan sus propias lámparas (special_profile_lamps).
        const rows = this.db.prepare(`
      SELECT active_calls.call_type
      FROM caller_lamps
      JOIN active_calls ON active_calls.device_id = caller_lamps.caller_device_id
      WHERE caller_lamps.lamp_id = ? AND active_calls.active = 1
        AND active_calls.call_type IN ('normal', 'emergency')
    `).all(lampId);
        if (rows.some(row => row.call_type === "emergency"))
            return "emergency";
        if (rows.some(row => row.call_type === "normal"))
            return "normal";
        // Lámparas designadas por perfil de llamado especial
        const specialRows = this.db.prepare(`
      SELECT active_special_calls.call_type
      FROM special_profile_lamps
      JOIN active_special_calls
        ON active_special_calls.call_type = special_profile_lamps.call_type
      WHERE special_profile_lamps.lamp_id = ? AND active_special_calls.active = 1
    `).all(lampId);
        if (specialRows.length > 0) {
            const order = ["type3", "type4", "type5", "type6"];
            for (const t of order) {
                if (specialRows.some(row => row.call_type === t))
                    return t;
            }
        }
        if (rows.length > 0)
            return "normal";
        return "off";
    }
    // ── Lámparas por perfil de llamado especial ──────────────────────────────
    getLampIdsForSpecialProfile(callType) {
        return this.db.prepare(`
      SELECT lamp_id FROM special_profile_lamps WHERE call_type = ?
    `).all(callType).map(row => row.lamp_id);
    }
    setLampAssignmentsForSpecialProfile(callType, lampIds) {
        this.db.prepare("DELETE FROM special_profile_lamps WHERE call_type = ?").run(callType);
        const insert = this.db.prepare(`
      INSERT OR IGNORE INTO special_profile_lamps (call_type, lamp_id) VALUES (?, ?)
    `);
        for (const lampId of lampIds)
            insert.run(callType, lampId);
    }
    /** Ids de lámparas afectadas por un estado especial activo (para resync) */
    getLampIdsForSpecialCallTypes(activeTypes) {
        if (activeTypes.length === 0)
            return [];
        const placeholders = activeTypes.map(() => "?").join(",");
        return this.db.prepare(`
      SELECT DISTINCT lamp_id FROM special_profile_lamps WHERE call_type IN (${placeholders})
    `).all(...activeTypes).map(row => row.lamp_id);
    }
    getLampAlertProfiles() {
        return this.db.prepare(`
      SELECT * FROM lamp_alert_profiles
      ORDER BY CASE call_type
        WHEN 'normal' THEN 1
        WHEN 'emergency' THEN 2
        WHEN 'presence' THEN 3
        WHEN 'type3' THEN 4
        WHEN 'type4' THEN 5
        WHEN 'type5' THEN 6
        ELSE 99
      END
    `).all()
            .map(row => ({
            callType: row.call_type,
            label: row.label,
            enabled: Boolean(row.enabled),
            colorPreset: row.color_preset,
            animationPreset: row.animation_preset,
            soundPreset: row.sound_preset,
            audioEnabled: Boolean(row.audio_enabled),
            autoEndS: Number(row.auto_end_s ?? 0),
        }));
    }
    getLampAlertProfile(callType) {
        return this.getLampAlertProfiles().find(profile => profile.callType === callType);
    }
    updateLampAlertProfile(callType, values) {
        const current = this.getLampAlertProfile(callType);
        if (!current)
            return undefined;
        const preset = (value, fallback) => Math.max(0, Math.min(19, Math.round(value ?? fallback)));
        const autoEndS = Math.max(0, Math.min(86_400, Math.round(values.autoEndS ?? current.autoEndS)));
        this.db.prepare(`
      UPDATE lamp_alert_profiles SET label = ?, enabled = ?, color_preset = ?, animation_preset = ?,
        sound_preset = ?, audio_enabled = ?, auto_end_s = ? WHERE call_type = ?
    `).run(values.label ?? current.label, (values.enabled ?? current.enabled) ? 1 : 0, preset(values.colorPreset, current.colorPreset), preset(values.animationPreset, current.animationPreset), preset(values.soundPreset, current.soundPreset), (values.audioEnabled ?? current.audioEnabled) ? 1 : 0, autoEndS, callType);
        return this.getLampAlertProfile(callType);
    }
    // ── Location settings ────────────────────────────────────────────────────
    getLocationSettings() {
        const row = this.db.prepare("SELECT * FROM location_settings WHERE id = 1").get();
        return {
            name: row.name,
            attentionTimeMin: Number(row.attention_time_min ?? 5) || 5,
            backgroundColor: row.background_color,
            headerColor: row.header_color,
            textColor: row.text_color,
            normalCallColor: row.normal_call_color,
            emergencyCallColor: row.emergency_call_color,
            timerColor: row.timer_color,
            soundEnabled: Boolean(row.sound_enabled),
            soundVolume: row.sound_volume,
            alertSound: row.alert_sound,
            emergencySound: row.emergency_sound,
            voiceEnabled: Boolean(row.voice_enabled),
            voiceRate: row.voice_rate,
            voicePitch: row.voice_pitch,
            voiceVolume: row.voice_volume,
            pendingReminderEnabled: Boolean(row.pending_reminder_enabled ?? 0),
            pendingReminderIntervalS: Number(row.pending_reminder_interval_s ?? 120) || 120,
            uiScalePercent: Number(row.ui_scale_percent ?? 100) || 100,
        };
    }
    updateLocationSettings(values) {
        const current = this.getLocationSettings();
        const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
        this.db.prepare(`
      UPDATE location_settings SET
        name = ?, attention_time_min = ?, background_color = ?, header_color = ?, text_color = ?,
        normal_call_color = ?, emergency_call_color = ?, timer_color = ?,
        sound_enabled = ?, sound_volume = ?, alert_sound = ?, emergency_sound = ?,
        voice_enabled = ?, voice_rate = ?, voice_pitch = ?, voice_volume = ?,
        pending_reminder_enabled = ?, pending_reminder_interval_s = ?, ui_scale_percent = ?
      WHERE id = 1
    `).run((values.name ?? current.name).trim() || current.name, clamp(values.attentionTimeMin ?? current.attentionTimeMin ?? 5, 1, 10, 5), values.backgroundColor ?? current.backgroundColor, values.headerColor ?? current.headerColor, values.textColor ?? current.textColor, values.normalCallColor ?? current.normalCallColor, values.emergencyCallColor ?? current.emergencyCallColor, values.timerColor ?? current.timerColor, (values.soundEnabled ?? current.soundEnabled) ? 1 : 0, clamp(values.soundVolume ?? current.soundVolume, 0, 100, current.soundVolume), values.alertSound ?? current.alertSound, values.emergencySound ?? current.emergencySound, (values.voiceEnabled ?? current.voiceEnabled) ? 1 : 0, clamp(values.voiceRate ?? current.voiceRate, 0.5, 2, current.voiceRate), clamp(values.voicePitch ?? current.voicePitch, 0.5, 2, current.voicePitch), clamp(values.voiceVolume ?? current.voiceVolume, 0, 1, current.voiceVolume), (values.pendingReminderEnabled ?? current.pendingReminderEnabled) ? 1 : 0, clamp(values.pendingReminderIntervalS ?? current.pendingReminderIntervalS ?? 120, 5, 900, 120), clamp(values.uiScalePercent ?? current.uiScalePercent ?? 100, 50, 200, 100));
        return this.getLocationSettings();
    }
    // ── Presence monitor ──────────────────────────────────────────────────────
    _rowToPresenceSensor(row) {
        return {
            deviceId: row.device_id,
            role: normalizePresenceRole(row.role),
            areaName: row.area_name || "",
            enabled: Boolean(row.enabled),
            createdAtMs: Number(row.created_at_ms ?? 0),
            updatedAtMs: Number(row.updated_at_ms ?? 0),
        };
    }
    _rowToPresenceSession(row) {
        return {
            id: Number(row.id),
            deviceId: row.device_id,
            role: normalizePresenceRole(row.role),
            areaName: row.area_name || "",
            patientId: row.patient_id === null || row.patient_id === undefined ? undefined : String(row.patient_id),
            patientName: row.patient_name || "",
            enteredAtMs: Number(row.entered_at_ms ?? 0),
            lastSeenAtMs: Number(row.last_seen_at_ms ?? 0),
            exitedAtMs: row.exited_at_ms === null || row.exited_at_ms === undefined ? undefined : Number(row.exited_at_ms),
            durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
            closeReason: row.close_reason || "",
            alertSentAtMs: Number(row.alert_sent_at_ms ?? 0),
        };
    }
    getPresenceSensors() {
        return this.db.prepare("SELECT * FROM presence_sensors ORDER BY area_name COLLATE NOCASE, device_id").all()
            .map(row => this._rowToPresenceSensor(row));
    }
    getPresenceSensor(deviceId) {
        const row = this.db.prepare("SELECT * FROM presence_sensors WHERE device_id = ?").get(deviceId);
        return row ? this._rowToPresenceSensor(row) : undefined;
    }
    upsertPresenceSensor(deviceId, role, areaName, enabled = true) {
        const now = Date.now();
        const safeRole = normalizePresenceRole(role);
        const safeArea = String(areaName ?? "").trim().slice(0, 60);
        this.db.prepare(`
      INSERT INTO presence_sensors (device_id, role, area_name, enabled, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        role = excluded.role, area_name = excluded.area_name,
        enabled = excluded.enabled, updated_at_ms = excluded.updated_at_ms
    `).run(deviceId, safeRole, safeArea, enabled ? 1 : 0, now, now);
        return this.getPresenceSensor(deviceId);
    }
    deletePresenceSensor(deviceId) {
        return this.db.prepare("DELETE FROM presence_sensors WHERE device_id = ?").run(deviceId).changes > 0;
    }
    getPresenceSettings() {
        const row = this.db.prepare("SELECT * FROM presence_settings WHERE id = 1").get();
        return {
            enabled: Boolean(row.enabled),
            showOnLocation: Boolean(row.show_on_location),
            showFreeOnLocation: Boolean(row.show_free_on_location ?? 1),
            exitGraceS: Number(row.exit_grace_s ?? 20) || 20,
            minSessionS: Number(row.min_session_s ?? 5) || 5,
            staleS: Number(row.stale_s ?? 180) || 180,
            longStayMin: Number(row.long_stay_min ?? 15) || 15,
            alertEnabled: Boolean(row.alert_enabled ?? 1),
        };
    }
    updatePresenceSettings(values) {
        const current = this.getPresenceSettings();
        const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
        this.db.prepare(`
      UPDATE presence_settings SET
        enabled = ?, show_on_location = ?, show_free_on_location = ?,
        exit_grace_s = ?, min_session_s = ?, stale_s = ?, long_stay_min = ?, alert_enabled = ?
      WHERE id = 1
    `).run((values.enabled ?? current.enabled) ? 1 : 0, (values.showOnLocation ?? current.showOnLocation) ? 1 : 0, (values.showFreeOnLocation ?? current.showFreeOnLocation) ? 1 : 0, clamp(values.exitGraceS ?? current.exitGraceS, 0, 300, current.exitGraceS), clamp(values.minSessionS ?? current.minSessionS, 0, 300, current.minSessionS), clamp(values.staleS ?? current.staleS, 30, 3600, current.staleS), clamp(values.longStayMin ?? current.longStayMin, 1, 240, current.longStayMin), (values.alertEnabled ?? current.alertEnabled) ? 1 : 0);
        return this.getPresenceSettings();
    }
    openPresenceSession(deviceId, role, areaName, enteredAtMs, lastSeenAtMs) {
        const result = this.db.prepare(`
      INSERT INTO presence_sessions (device_id, role, area_name, patient_id, patient_name, entered_at_ms, last_seen_at_ms, close_reason, alert_sent_at_ms)
      VALUES (?, ?, ?, NULL, '', ?, ?, '', 0)
    `).run(deviceId, role, areaName, enteredAtMs, lastSeenAtMs);
        return this.getPresenceSession(Number(result.lastInsertRowid));
    }
    getPresenceSession(id) {
        const row = this.db.prepare("SELECT * FROM presence_sessions WHERE id = ?").get(id);
        return row ? this._rowToPresenceSession(row) : undefined;
    }
    getOpenPresenceSession(deviceId) {
        const row = this.db.prepare("SELECT * FROM presence_sessions WHERE device_id = ? AND exited_at_ms IS NULL ORDER BY id DESC LIMIT 1").get(deviceId);
        return row ? this._rowToPresenceSession(row) : undefined;
    }
    getOpenPresenceSessions() {
        return this.db.prepare("SELECT * FROM presence_sessions WHERE exited_at_ms IS NULL ORDER BY entered_at_ms").all()
            .map(row => this._rowToPresenceSession(row));
    }
    touchPresenceSession(id, lastSeenAtMs) {
        this.db.prepare("UPDATE presence_sessions SET last_seen_at_ms = ? WHERE id = ? AND exited_at_ms IS NULL").run(lastSeenAtMs, id);
    }
    markPresenceSessionAlert(id, atMs) {
        this.db.prepare("UPDATE presence_sessions SET alert_sent_at_ms = ? WHERE id = ? AND exited_at_ms IS NULL").run(atMs, id);
    }
    closePresenceSession(id, exitedAtMs, closeReason, minDurationMs = 0) {
        const session = this.getPresenceSession(id);
        if (!session || session.exitedAtMs !== undefined)
            return session;
        const durationMs = Math.max(0, exitedAtMs - session.enteredAtMs);
        if (minDurationMs > 0 && durationMs < minDurationMs) {
            this.db.prepare("DELETE FROM presence_sessions WHERE id = ?").run(id);
            return undefined;
        }
        this.db.prepare("UPDATE presence_sessions SET exited_at_ms = ?, duration_ms = ?, close_reason = ? WHERE id = ?")
            .run(exitedAtMs, durationMs, closeReason, id);
        return this.getPresenceSession(id);
    }
    closeAllOpenPresenceSessions(closeReason, atMs) {
        let closed = 0;
        for (const session of this.getOpenPresenceSessions()) {
            if (this.closePresenceSession(session.id, atMs, closeReason))
                closed++;
        }
        return closed;
    }
    getPresenceSessions(filter = {}) {
        const where = [];
        const params = [];
        if (filter.deviceId) {
            where.push("device_id = ?");
            params.push(filter.deviceId);
        }
        if (filter.fromMs !== undefined) {
            where.push("entered_at_ms >= ?");
            params.push(filter.fromMs);
        }
        if (filter.toMs !== undefined) {
            where.push("entered_at_ms <= ?");
            params.push(filter.toMs);
        }
        if (filter.openOnly)
            where.push("exited_at_ms IS NULL");
        const limit = Math.max(1, Math.min(5000, Math.floor(filter.limit ?? 500)));
        const sql = `SELECT * FROM presence_sessions${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY entered_at_ms DESC LIMIT ${limit}`;
        return this.db.prepare(sql).all(...params).map(row => this._rowToPresenceSession(row));
    }
    // ── Calls ─────────────────────────────────────────────────────────────────
    applyCallStart(deviceId, seq, cons, callType) {
        if (isSpecialCallType(callType))
            return this._applySpecialCallStart(deviceId, seq, cons, callType);
        const now = Date.now();
        const prev = this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId);
        const startedAtMs = (prev && Boolean(prev.active)) ? prev.started_at_ms : now;
        const startSeq = (prev && Boolean(prev.active)) ? (prev.start_seq || seq) : seq;
        this.db.prepare(`
      INSERT INTO active_calls (device_id, active, cons, call_type, started_at_ms, updated_at_ms, start_seq, last_seq)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        active       = 1,
        cons         = excluded.cons,
        call_type    = excluded.call_type,
        started_at_ms = excluded.started_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        start_seq    = excluded.start_seq,
        last_seq     = excluded.last_seq
    `).run(deviceId, cons, callType, startedAtMs, now, startSeq, seq);
        this.markSeq(deviceId, seq);
        return this._rowToCall(this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId));
    }
    /** Inicia (o renueva por insistencia) un llamado especial de un dispositivo. */
    _applySpecialCallStart(deviceId, seq, cons, callType) {
        const now = Date.now();
        const prev = this.db
            .prepare("SELECT * FROM active_special_calls WHERE device_id = ? AND call_type = ?")
            .get(deviceId, callType);
        const startedAtMs = (prev && Boolean(prev.active)) ? prev.started_at_ms : now;
        const startSeq = (prev && Boolean(prev.active)) ? (prev.start_seq || seq) : seq;
        this.db.prepare(`
      INSERT INTO active_special_calls (device_id, call_type, active, cons, started_at_ms, updated_at_ms, start_seq, last_seq)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, call_type) DO UPDATE SET
        active        = 1,
        cons          = excluded.cons,
        started_at_ms = excluded.started_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        start_seq     = excluded.start_seq,
        last_seq      = excluded.last_seq
    `).run(deviceId, callType, cons, startedAtMs, now, startSeq, seq);
        this.markSeq(deviceId, seq);
        return this._rowToCall(this.db.prepare("SELECT * FROM active_special_calls WHERE device_id = ? AND call_type = ?")
            .get(deviceId, callType));
    }
    /**
     * Finaliza un llamado especial puntual y registra su historial.
     * Devuelve undefined si ese especial no estaba activo.
     * @param seq Solo si el cierre llegó en un frame del dispositivo (dedupe/ACK).
     */
    applySpecialCallEnd(deviceId, callType, seq) {
        const prev = this.db
            .prepare("SELECT * FROM active_special_calls WHERE device_id = ? AND call_type = ?")
            .get(deviceId, callType);
        if (!prev || !Boolean(prev.active))
            return undefined;
        const now = Date.now();
        this.db.prepare("DELETE FROM active_special_calls WHERE device_id = ? AND call_type = ?")
            .run(deviceId, callType);
        if (seq !== undefined)
            this.markSeq(deviceId, seq);
        const historyRecord = {
            id: `${deviceId}_${callType}_${now}`,
            deviceId,
            call_type: callType,
            cons: prev.cons,
            startedAtMs: prev.started_at_ms,
            endedAtMs: now,
            durationMs: now - prev.started_at_ms,
            patientName: this.getPatientByDevice(deviceId)?.name,
            finishOrigin: seq !== undefined ? "llamador" : "monitor",
        };
        this.db.prepare(`
      INSERT OR IGNORE INTO call_history (id, device_id, call_type, cons, started_at_ms, ended_at_ms, duration_ms, patient_name, finish_origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(historyRecord.id, historyRecord.deviceId, historyRecord.call_type, historyRecord.cons, historyRecord.startedAtMs, historyRecord.endedAtMs, historyRecord.durationMs, historyRecord.patientName ?? '', historyRecord.finishOrigin ?? '');
        const state = {
            deviceId,
            active: false,
            cons: 0,
            call_type: callType,
            startedAtMs: historyRecord.startedAtMs,
            updatedAtMs: now,
            startSeq: prev.start_seq,
            lastSeq: seq ?? prev.last_seq,
            finishOrigin: historyRecord.finishOrigin,
        };
        return { state, historyRecord };
    }
    applyCallEnd(deviceId, seq) {
        const now = Date.now();
        const prev = this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId);
        this.db.prepare(`
      INSERT INTO active_calls (device_id, active, cons, call_type, started_at_ms, updated_at_ms, last_seq)
      VALUES (?, 0, 0, 'normal', ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        active       = 0,
        cons         = 0,
        updated_at_ms = excluded.updated_at_ms,
        last_seq     = excluded.last_seq
    `).run(deviceId, now, now, seq);
        this.markSeq(deviceId, seq);
        let historyRecord;
        if (prev && Boolean(prev.active)) {
            const startedAtMs = prev.started_at_ms;
            const callType = prev.call_type;
            const cons = prev.cons;
            historyRecord = {
                id: `${deviceId}_${now}`,
                deviceId,
                call_type: callType,
                cons,
                startedAtMs,
                endedAtMs: now,
                durationMs: now - startedAtMs,
                patientName: this.getPatientByDevice(deviceId)?.name,
                finishOrigin: "llamador",
            };
            this.db.prepare(`
        INSERT OR IGNORE INTO call_history (id, device_id, call_type, cons, started_at_ms, ended_at_ms, duration_ms, patient_name, finish_origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(historyRecord.id, historyRecord.deviceId, historyRecord.call_type, historyRecord.cons, historyRecord.startedAtMs, historyRecord.endedAtMs, historyRecord.durationMs, historyRecord.patientName ?? '', historyRecord.finishOrigin ?? '');
        }
        const state = this._rowToCall(this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId));
        return { state: { ...state, finishOrigin: historyRecord?.finishOrigin }, historyRecord };
    }
    /** Activos de normal/emergency + todos los especiales activos (N por dispositivo). */
    getActiveCalls() {
        const base = this.db.prepare("SELECT * FROM active_calls WHERE active = 1").all()
            .map(r => this._rowToCall(r));
        const specials = this.db.prepare("SELECT * FROM active_special_calls WHERE active = 1").all()
            .map(r => this._rowToCall(r));
        return [...base, ...specials].map(state => this.withPatientName(state));
    }
    /** Llamada propia del dispositivo (normal/emergency); los especiales no cuentan. */
    getCallForDevice(deviceId) {
        const row = this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId);
        return row ? this._rowToCall(row) : undefined;
    }
    getActiveCallForDevice(deviceId) {
        const row = this.db
            .prepare("SELECT * FROM active_calls WHERE device_id = ? AND active = 1")
            .get(deviceId);
        return row ? this._rowToCall(row) : undefined;
    }
    /** Especiales activos de un dispositivo (varios a la vez). */
    getActiveSpecialCallsForDevice(deviceId) {
        return this.db
            .prepare("SELECT * FROM active_special_calls WHERE device_id = ? AND active = 1 ORDER BY started_at_ms ASC")
            .all(deviceId)
            .map(r => this._rowToCall(r));
    }
    getAllCalls() {
        const base = this.db.prepare("SELECT * FROM active_calls").all()
            .map(r => this._rowToCall(r));
        const specials = this.db.prepare("SELECT * FROM active_special_calls").all()
            .map(r => this._rowToCall(r));
        return [...base, ...specials];
    }
    getCallHistory(deviceId, limit = 500) {
        if (deviceId) {
            return this.db.prepare("SELECT * FROM call_history WHERE device_id = ? ORDER BY started_at_ms DESC LIMIT ?").all(deviceId, limit)
                .map(r => this._rowToHistory(r));
        }
        return this.db.prepare("SELECT * FROM call_history ORDER BY started_at_ms DESC LIMIT ?").all(limit)
            .map(r => this._rowToHistory(r));
    }
    /** Fuerza el cierre de un llamado activo desde la UI (sin validar seq) */
    forceEndCall(deviceId) {
        const now = Date.now();
        const prev = this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId);
        this.db.prepare(`
      INSERT INTO active_calls (device_id, active, cons, call_type, started_at_ms, updated_at_ms, last_seq)
      VALUES (?, 0, 0, 'normal', ?, ?, 0)
      ON CONFLICT(device_id) DO UPDATE SET
        active        = 0,
        cons          = 0,
        updated_at_ms = excluded.updated_at_ms
    `).run(deviceId, now, now);
        let historyRecord;
        if (prev && Boolean(prev.active)) {
            const startedAtMs = prev.started_at_ms;
            const callType = prev.call_type;
            const cons = prev.cons;
            historyRecord = {
                id: `${deviceId}_${now}`,
                deviceId,
                call_type: callType,
                cons,
                startedAtMs,
                endedAtMs: now,
                durationMs: now - startedAtMs,
                patientName: this.getPatientByDevice(deviceId)?.name,
                finishOrigin: "monitor",
            };
            this.db.prepare(`
        INSERT OR IGNORE INTO call_history (id, device_id, call_type, cons, started_at_ms, ended_at_ms, duration_ms, patient_name, finish_origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(historyRecord.id, historyRecord.deviceId, historyRecord.call_type, historyRecord.cons, historyRecord.startedAtMs, historyRecord.endedAtMs, historyRecord.durationMs, historyRecord.patientName ?? '', historyRecord.finishOrigin ?? '');
        }
        const state = this._rowToCall(this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId));
        return { state: { ...state, finishOrigin: historyRecord?.finishOrigin }, historyRecord };
    }
    // ── Patients ───────────────────────────────────────────────────────────────
    _validateName(name) {
        if (typeof name !== "string")
            throw new Error("El nombre del paciente es obligatorio");
        const value = String(name ?? "").trim();
        if (!value)
            throw new Error("El nombre del paciente es obligatorio");
        if (value.length > 60)
            throw new Error("El nombre no puede superar 60 caracteres");
        return value;
    }
    _validateAge(age) {
        if (age === null || age === undefined || age === "")
            return null;
        if (typeof age !== "number")
            throw new Error("Edad inválida (0-150)");
        const value = age;
        if (!Number.isInteger(value) || value < 0 || value > 150)
            throw new Error("Edad inválida (0-150)");
        return value;
    }
    _validateAdmissionDate(value) {
        if (value === null || value === undefined || value === "")
            return null;
        if (typeof value !== "string")
            throw new Error("Fecha de ingreso inválida");
        const text = value.trim();
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(text) || !Number.isFinite(Date.parse(text)))
            throw new Error("Fecha de ingreso inválida");
        return text;
    }
    _validateNotes(value) {
        if (value === null || value === undefined || value === "")
            return null;
        if (typeof value !== "string")
            throw new Error("Notas inválidas");
        const text = value.replace(/\s+/g, " ").trim();
        if (text.length > 120)
            throw new Error("Las notas no pueden superar 120 caracteres");
        return text;
    }
    _validateDevice(deviceId) {
        if (deviceId === null || deviceId === undefined || deviceId === "")
            return null;
        if (typeof deviceId !== "string")
            throw new Error("Llamador inválido");
        const value = deviceId;
        const device = this.getDevice(value);
        if (!device || /^RPT-/i.test(device.firmwareVersion ?? ""))
            throw new Error(`Llamador no encontrado: ${value}`);
        return value;
    }
    /** Libera el llamador si otro paciente lo tiene asignado (regla 1:1). */
    _freeDevice(deviceId, exceptPatientId) {
        this.db.prepare(`
      UPDATE patients SET assigned_device = NULL, updated_at_ms = ?
      WHERE assigned_device = ? AND patient_id != ?
    `).run(Date.now(), deviceId, exceptPatientId ?? "");
    }
    createPatient(input) {
        const name = this._validateName(input.name);
        const age = this._validateAge(input.age);
        const admissionDate = this._validateAdmissionDate(input.admissionDate);
        const notes = this._validateNotes(input.notes);
        const deviceId = this._validateDevice(input.assignedDevice);
        const now = Date.now();
        const patientId = randomUUID();
        this.db.transaction(() => {
            if (deviceId)
                this._freeDevice(deviceId, patientId);
            this.db.prepare(`
        INSERT INTO patients (patient_id, name, age, admission_date, notes, assigned_device, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(patientId, name, age, admissionDate, notes, deviceId, now, now);
        })();
        return this.getPatient(patientId);
    }
    getPatient(patientId) {
        const row = this.db.prepare("SELECT * FROM patients WHERE patient_id = ?").get(patientId);
        return row ? this._rowToPatient(row) : undefined;
    }
    getPatients() {
        return this.db.prepare("SELECT * FROM patients ORDER BY created_at_ms DESC").all()
            .map(row => this._rowToPatient(row));
    }
    getPatientByDevice(deviceId) {
        if (!deviceId)
            return undefined;
        const row = this.db.prepare("SELECT * FROM patients WHERE assigned_device = ?").get(deviceId);
        return row ? this._rowToPatient(row) : undefined;
    }
    updatePatient(patientId, input) {
        const current = this.getPatient(patientId);
        if (!current)
            return undefined;
        const name = input.name !== undefined ? this._validateName(input.name) : current.name;
        const age = input.age !== undefined ? this._validateAge(input.age) : (current.age ?? null);
        const admissionDate = input.admissionDate !== undefined
            ? this._validateAdmissionDate(input.admissionDate)
            : (current.admissionDate ?? null);
        const notes = input.notes !== undefined ? this._validateNotes(input.notes) : (current.notes ?? null);
        const hasAssignment = Object.prototype.hasOwnProperty.call(input, "assignedDevice");
        const deviceId = hasAssignment ? this._validateDevice(input.assignedDevice) : current.assignedDevice;
        const now = Date.now();
        this.db.transaction(() => {
            if (hasAssignment && deviceId && deviceId !== current.assignedDevice)
                this._freeDevice(deviceId, patientId);
            this.db.prepare(`
        UPDATE patients
        SET name = ?, age = ?, admission_date = ?, notes = ?, assigned_device = ?, updated_at_ms = ?
        WHERE patient_id = ?
      `).run(name, age, admissionDate, notes, deviceId, now, patientId);
        })();
        return this.getPatient(patientId);
    }
    deletePatient(patientId) {
        return this.db.prepare("DELETE FROM patients WHERE patient_id = ?").run(patientId).changes > 0;
    }
    /** Inyecta el nombre del paciente asignado (para payloads de llamada activa). */
    withPatientName(state) {
        const patient = this.getPatientByDevice(state.deviceId);
        return { ...state, patientName: patient?.name };
    }
    // ── Utilidades ────────────────────────────────────────────────────────────
    /** Marca todos los dispositivos offline (útil al arrancar) */
    sweepOfflineDevices(timeoutMs, nowMs = Date.now()) {
        const cutoff = nowMs - timeoutMs;
        const stale = this.db.prepare("SELECT device_id FROM devices WHERE online = 1 AND last_seen_ms < ?").all(cutoff);
        if (stale.length === 0)
            return [];
        this.db.prepare("UPDATE devices SET online = 0 WHERE online = 1 AND last_seen_ms < ?").run(cutoff);
        return stale.map(row => row.device_id);
    }
    sweepOfflineLamps(timeoutMs, nowMs = Date.now()) {
        const cutoff = nowMs - timeoutMs;
        const stale = this.db.prepare("SELECT lamp_id FROM lamps WHERE online = 1 AND last_seen_ms < ?").all(cutoff);
        if (stale.length === 0)
            return [];
        this.db.prepare("UPDATE lamps SET online = 0 WHERE online = 1 AND last_seen_ms < ?").run(cutoff);
        return stale.map(row => row.lamp_id);
    }
    markAllOffline() {
        this.db.prepare("UPDATE devices SET online = 0").run();
        this.db.prepare("UPDATE lamps SET online = 0").run();
    }
    close() {
        this.db.close();
    }
}

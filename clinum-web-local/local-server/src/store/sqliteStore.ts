import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { isSpecialCallType } from "../types.js";
import type {
  ActiveCallState,
  CallHistoryRecord,
  CallType,
  DeviceRecord,
  IncomingFrame,
  LampEffectiveState,
  LampAlertProfile,
  LampRecord,
  LocationSettings,
  PatientInput,
  PatientRecord,
  SpecialCallType,
} from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(filePath: string) {
  try { mkdirSync(dirname(filePath), { recursive: true }); } catch { /* ignore */ }
}

// ── SqliteStore ───────────────────────────────────────────────────────────────

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    ensureDir(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this._migrate();
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  private _migrate() {
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
    `);

    this.db.prepare("INSERT OR IGNORE INTO location_settings (id) VALUES (1)").run();

    const normalColorMigration = this.db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get("normal_call_color_green") as { name: string } | undefined;
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

    const callColumns = this.db.pragma("table_info(active_calls)") as Array<{ name: string }>;
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

  private _ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some(existing => existing.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private _migrateSpecialCalls(): void {
    const specialList = "'type3','type4','type5','type6'";
    const activeSpecials = this.db
      .prepare(`SELECT * FROM active_calls WHERE active = 1 AND call_type IN (${specialList})`)
      .all() as Record<string, unknown>[];
    if (activeSpecials.length > 0) {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO active_special_calls
          (device_id, call_type, active, cons, started_at_ms, updated_at_ms, start_seq, last_seq)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `);
      const move = this.db.transaction(() => {
        for (const row of activeSpecials) {
          insert.run(
            row.device_id as string,
            row.call_type as string,
            row.cons as number,
            row.started_at_ms as number,
            row.updated_at_ms as number,
            row.start_seq as number,
            row.last_seq as number,
          );
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

  private _rowToDevice(row: Record<string, unknown>): DeviceRecord {
    const transport = (row.transport as DeviceRecord["transport"]) || undefined;
    return {
      deviceId:       row.device_id as string,
      mac:            row.mac as string,
      name:           row.name as string | undefined,
      online:         Boolean(row.online),
      lastSeenMs:     row.last_seen_ms as number,
      registeredAtMs: row.registered_at_ms as number,
      callerLocationType: (row.caller_location_type as DeviceRecord["callerLocationType"]) ?? "cama",
      transport,
      firmwareVersion: (row.firmware_version as string) || undefined,
    };
  }

  private _rowToCall(row: Record<string, unknown>): ActiveCallState {
    return {
      deviceId:    row.device_id as string,
      active:      Boolean(row.active),
      cons:        row.cons as number,
      call_type:   row.call_type as CallType,
      startedAtMs: row.started_at_ms as number,
      updatedAtMs: row.updated_at_ms as number,
      startSeq:    row.start_seq as number,
      lastSeq:     row.last_seq as number,
    };
  }

  private _rowToHistory(row: Record<string, unknown>): CallHistoryRecord {
    const patientName = (row.patient_name as string) || undefined;
    const finishOrigin = (row.finish_origin as string) === "monitor" ? "monitor" as const
      : (row.finish_origin as string) === "llamador" ? "llamador" as const : undefined;
    return {
      id:          row.id as string,
      deviceId:    row.device_id as string,
      call_type:   row.call_type as CallType,
      cons:        row.cons as number,
      startedAtMs: row.started_at_ms as number,
      endedAtMs:   row.ended_at_ms as number,
      durationMs:  row.duration_ms as number,
      ...(patientName ? { patientName } : {}),
      ...(finishOrigin ? { finishOrigin } : {}),
    };
  }

  private _rowToPatient(row: Record<string, unknown>): PatientRecord {
    return {
      patientId:      row.patient_id as string,
      name:           row.name as string,
      age:            row.age === null || row.age === undefined ? undefined : Number(row.age),
      admissionDate:  (row.admission_date as string) || undefined,
      notes:          (row.notes as string) || undefined,
      assignedDevice: (row.assigned_device as string) || null,
      createdAtMs:    row.created_at_ms as number,
      updatedAtMs:    row.updated_at_ms as number,
    };
  }

  private _rowToLamp(row: Record<string, unknown>): LampRecord {
    return {
      lampId: row.lamp_id as string,
      mac: row.mac as string,
      name: row.name as string | undefined,
      online: Boolean(row.online),
      lastSeenMs: row.last_seen_ms as number,
      registeredAtMs: row.registered_at_ms as number,
      relayCapable: Boolean(row.relay_capable),
      protocolVersion: row.protocol_version as number,
      audioEnabled: Boolean(row.audio_enabled),
      brightness: row.brightness as number,
      buzzerVolume: row.buzzer_volume as number,
      transport: (row.transport as "espnow" | "lora") || "espnow",
      pendingTransport: (row.pending_transport as "espnow" | "lora" | null) ?? undefined,
      transportRequestedAtMs: (row.transport_requested_at_ms as number | null) ?? undefined,
      appliedRevision: row.applied_revision as number,
      appliedState: row.applied_state as LampEffectiveState,
    };
  }

  // ── Seq tracking ──────────────────────────────────────────────────────────

  // Receipts viejos no deben bloquear un seq reutilizado tras reboot/erase del
  // terminal. Si el fingerprint difiere pero el receipt anterior es antiguo, se
  // sobrescribe y el evento nuevo se aplica como llamado fresco.
  private static readonly RECEIPT_REUSE_WINDOW_MS = 5 * 60 * 1000;

  /** Receipt and state mutation commit together, before any acknowledgement. */
  public receiveCallEvent<T>(frame: IncomingFrame, apply: () => T): { result: "ok" | "duplicate" | "stale" | "invalid"; value?: T } {
    const fingerprint = JSON.stringify([frame.msgType, frame.call_type ?? "normal", frame.cons ?? 0, frame.callId ?? 0]);
    return this.db.transaction(() => {
      const receipt = this.db
        .prepare("SELECT fingerprint, received_at_ms FROM event_receipts WHERE device_id = ? AND seq = ?")
        .get(frame.deviceId, frame.seq) as { fingerprint: string; received_at_ms: number } | undefined;
      if (receipt) {
        if (receipt.fingerprint === fingerprint) {
          this.incrementReliability("duplicate");
          return { result: "duplicate" as const };
        }
        const ageMs = Date.now() - receipt.received_at_ms;
        if (ageMs < SqliteStore.RECEIPT_REUSE_WINDOW_MS) {
          this.incrementReliability("invalid");
          return { result: "invalid" as const };
        }
      }
      if (this.isDuplicateOrOld(frame.deviceId, frame.seq)) {
        this.incrementReliability("stale");
        return { result: "stale" as const };
      }
      if (frame.callId && !isSpecialCallType(frame.call_type ?? "normal")) {
        const state = this.getCallForDevice(frame.deviceId);
        const invalidStart = frame.msgType === "call_start" && (state?.active ? state.startSeq !== frame.callId : frame.callId !== frame.seq);
        const invalidContinuation = frame.msgType !== "call_start" && (!state || state.startSeq !== frame.callId || (frame.msgType === "call_insist" && !state.active));
        if (invalidStart || invalidContinuation) { this.incrementReliability("stale"); return { result: "stale" as const }; }
      }
      const value = apply();
      if (receipt) {
        this.db
          .prepare("UPDATE event_receipts SET fingerprint = ?, received_at_ms = ? WHERE device_id = ? AND seq = ?")
          .run(fingerprint, Date.now(), frame.deviceId, frame.seq);
      } else {
        this.db.prepare("INSERT INTO event_receipts(device_id,seq,fingerprint,received_at_ms) VALUES (?,?,?,?)").run(frame.deviceId, frame.seq, fingerprint, Date.now());
      }
      this.incrementReliability("committed");
      return { result: "ok" as const, value };
    })();
  }

  public incrementReliability(name: string): void {
    this.db.prepare("INSERT INTO reliability_counters(name,value) VALUES (?,1) ON CONFLICT(name) DO UPDATE SET value=value+1").run(name);
  }

  public getReliabilityCounters(): Record<string, number> {
    return Object.fromEntries((this.db.prepare("SELECT name,value FROM reliability_counters").all() as Array<{name:string; value:number}>).map(r => [r.name, r.value]));
  }

  public savePendingCommand(deviceId: string, kind: string, seq: number, payload: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO pending_commands(device_id,kind,seq,payload) VALUES (?,?,?,?)
      ON CONFLICT(device_id,kind) DO UPDATE SET seq=excluded.seq,payload=excluded.payload,attempts=0,last_sent_at_ms=0`).run(deviceId, kind, seq, JSON.stringify(payload));
  }

  public nextCommandSeq(): number {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM reliability_counters WHERE name='command_sequence'").get() as {value:number} | undefined;
      const value = ((row?.value ?? (Date.now() >>> 0)) + 1) >>> 0 || 1;
      this.db.prepare("INSERT INTO reliability_counters(name,value) VALUES ('command_sequence',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(value);
      return value;
    });
  }

  public getPendingCommands(): Array<{deviceId:string; kind:string; seq:number; payload:Record<string,unknown>; attempts:number; lastSentAtMs:number}> {
    return (this.db.prepare("SELECT * FROM pending_commands").all() as Array<Record<string,unknown>>).map(r => ({
      deviceId: r.device_id as string, kind: r.kind as string, seq: r.seq as number,
      payload: JSON.parse(r.payload as string), attempts: r.attempts as number, lastSentAtMs: r.last_sent_at_ms as number,
    }));
  }

  public confirmPendingCommand(deviceId: string, seq: number): void {
    this.db.prepare("DELETE FROM pending_commands WHERE device_id=? AND seq=?").run(deviceId, seq);
  }

  public cancelPendingCommand(deviceId: string, kind: string): void {
    this.db.prepare("DELETE FROM pending_commands WHERE device_id=? AND kind=?").run(deviceId, kind);
  }

  public markCommandSent(deviceId: string, kind: string): void {
    this.db.prepare("UPDATE pending_commands SET attempts=attempts+1,last_sent_at_ms=? WHERE device_id=? AND kind=?").run(Date.now(), deviceId, kind);
  }

  public clearPendingCommands(): number {
    return this.db.prepare("DELETE FROM pending_commands").run().changes;
  }

  public transaction<T>(work: () => T): T { return this.db.transaction(work)(); }

  public isDuplicateOrOld(deviceId: string, seq: number): boolean {
    const row = this.db
      .prepare("SELECT last_seq FROM seq_tracker WHERE device_id = ?")
      .get(deviceId) as { last_seq: number } | undefined;
    return row !== undefined && seq <= row.last_seq;
  }

  public markSeq(deviceId: string, seq: number): void {
    this.db
      .prepare("INSERT INTO seq_tracker (device_id, last_seq) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seq = excluded.last_seq")
      .run(deviceId, seq);
  }

  // ── Devices ───────────────────────────────────────────────────────────────

  public registerDevice(
    deviceId: string,
    mac: string,
    initialName?: string,
    transport?: DeviceRecord["transport"],
    firmwareVersion?: string,
  ): DeviceRecord {
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

    return this._rowToDevice(
      this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
  }

  public touchDevice(deviceId: string, mac?: string, transport?: DeviceRecord["transport"], firmwareVersion?: string): DeviceRecord {
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

    return this._rowToDevice(
      this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
  }

  public getDevice(deviceId: string): DeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId);
    return row ? this._rowToDevice(row as Record<string, unknown>) : undefined;
  }

  public getDevices(): DeviceRecord[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY registered_at_ms ASC").all() as Record<string, unknown>[])
      .map(r => this._rowToDevice(r));
  }

  public updateDeviceName(deviceId: string, name: string): DeviceRecord | undefined {
    const result = this.db
      .prepare("UPDATE devices SET name = ? WHERE device_id = ?")
      .run(name, deviceId);
    if (result.changes === 0) return undefined;
    return this._rowToDevice(
      this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
  }

  public updateDeviceLocationType(deviceId: string, callerLocationType: string): DeviceRecord | undefined {
    const allowed = new Set(["cama", "sillon", "bano"]);
    const value = allowed.has(callerLocationType) ? callerLocationType : "cama";
    const result = this.db
      .prepare("UPDATE devices SET caller_location_type = ? WHERE device_id = ?")
      .run(value, deviceId);
    if (result.changes === 0) return undefined;
    return this._rowToDevice(
      this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
  }

  public deleteDevice(deviceId: string): boolean {
    const result = this.db.transaction(() => {
      this.db.prepare("UPDATE patients SET assigned_device = NULL, updated_at_ms = ? WHERE assigned_device = ?").run(Date.now(), deviceId);
      this.db.prepare("DELETE FROM active_calls        WHERE device_id = ?").run(deviceId);
      this.db.prepare("DELETE FROM active_special_calls WHERE device_id = ?").run(deviceId);
      this.db.prepare("DELETE FROM seq_tracker   WHERE device_id = ?").run(deviceId);
      this.db.prepare("DELETE FROM event_receipts WHERE device_id = ?").run(deviceId);
      this.db.prepare("DELETE FROM pending_commands WHERE device_id = ?").run(deviceId);
      return this.db.prepare("DELETE FROM devices WHERE device_id = ?").run(deviceId);
    })();
    return (result as Database.RunResult).changes > 0;
  }

  // ── Sound lamps ──────────────────────────────────────────────────────────

  public registerLamp(lampId: string, mac: string, relayCapable = true, protocolVersion = 1, initialName?: string, transport: "espnow" | "lora" = "espnow"): LampRecord {
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
    return this.getLamp(lampId)!;
  }

  public touchLamp(lampId: string, mac?: string, appliedRevision?: number, appliedState?: LampEffectiveState, observedTransport?: "espnow" | "lora"): LampRecord {
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

  public getLamp(lampId: string): LampRecord | undefined {
    const row = this.db.prepare("SELECT * FROM lamps WHERE lamp_id = ?").get(lampId);
    return row ? this._rowToLamp(row as Record<string, unknown>) : undefined;
  }

  public getLamps(): LampRecord[] {
    return (this.db.prepare("SELECT * FROM lamps ORDER BY registered_at_ms ASC").all() as Record<string, unknown>[])
      .map(row => this._rowToLamp(row));
  }

  public updateLamp(lampId: string, values: { name?: string; audioEnabled?: boolean; brightness?: number; buzzerVolume?: number }): LampRecord | undefined {
    const current = this.getLamp(lampId);
    if (!current) return undefined;
    const brightness = Math.max(1, Math.min(100, Math.round(values.brightness ?? current.brightness)));
    const buzzerVolume = Math.max(0, Math.min(100, Math.round(values.buzzerVolume ?? current.buzzerVolume)));
    this.db.prepare(`
      UPDATE lamps SET name = ?, audio_enabled = ?, brightness = ?, buzzer_volume = ? WHERE lamp_id = ?
    `).run(values.name ?? current.name ?? null, (values.audioEnabled ?? current.audioEnabled) ? 1 : 0, brightness, buzzerVolume, lampId);
    return this.getLamp(lampId);
  }

  public requestLampTransport(lampId: string, transport: "espnow" | "lora"): LampRecord | undefined {
    const current = this.getLamp(lampId);
    if (!current) return undefined;
    this.db.prepare(`
      UPDATE lamps SET pending_transport = ?, transport_requested_at_ms = ? WHERE lamp_id = ?
    `).run(transport, Date.now(), lampId);
    return this.getLamp(lampId);
  }

  public deleteLamp(lampId: string): boolean {
    return this.db.prepare("DELETE FROM lamps WHERE lamp_id = ?").run(lampId).changes > 0;
  }

  public getLampIdsForCaller(callerDeviceId: string): string[] {
    return (this.db.prepare(`
      SELECT lamp_id FROM caller_lamps WHERE caller_device_id = ? ORDER BY lamp_id
    `).all(callerDeviceId) as Array<{ lamp_id: string }>).map(row => row.lamp_id);
  }

  public getCallerIdsForLamp(lampId: string): string[] {
    return (this.db.prepare(`
      SELECT caller_device_id FROM caller_lamps WHERE lamp_id = ?
    `).all(lampId) as Array<{ caller_device_id: string }>).map(row => row.caller_device_id);
  }

  public setLampAssignments(callerDeviceId: string, lampIds: string[]): string[] {
    const uniqueLampIds = [...new Set(lampIds)];
    const replace = this.db.transaction(() => {
      for (const lampId of uniqueLampIds) {
        if (!this.getLamp(lampId)) throw new Error(`Unknown lamp: ${lampId}`);
      }
      this.db.prepare("DELETE FROM caller_lamps WHERE caller_device_id = ?").run(callerDeviceId);
      const insert = this.db.prepare("INSERT INTO caller_lamps (caller_device_id, lamp_id) VALUES (?, ?)");
      for (const lampId of uniqueLampIds) insert.run(callerDeviceId, lampId);
    });
    replace();
    return this.getLampIdsForCaller(callerDeviceId);
  }

  public getEffectiveLampState(lampId: string): LampEffectiveState {
    // Prioridad: emergency > normal > especiales (type3..type6)
    // caller_lamps solo aplica a llamados normales/emergencia; los especiales
    // usan sus propias lámparas (special_profile_lamps).
    const rows = this.db.prepare(`
      SELECT active_calls.call_type
      FROM caller_lamps
      JOIN active_calls ON active_calls.device_id = caller_lamps.caller_device_id
      WHERE caller_lamps.lamp_id = ? AND active_calls.active = 1
        AND active_calls.call_type IN ('normal', 'emergency')
    `).all(lampId) as Array<{ call_type: CallType }>;
    if (rows.some(row => row.call_type === "emergency")) return "emergency";
    if (rows.some(row => row.call_type === "normal")) return "normal";

    // Lámparas designadas por perfil de llamado especial
    const specialRows = this.db.prepare(`
      SELECT active_special_calls.call_type
      FROM special_profile_lamps
      JOIN active_special_calls
        ON active_special_calls.call_type = special_profile_lamps.call_type
      WHERE special_profile_lamps.lamp_id = ? AND active_special_calls.active = 1
    `).all(lampId) as Array<{ call_type: CallType }>;
    if (specialRows.length > 0) {
      const order: CallType[] = ["type3", "type4", "type5", "type6"];
      for (const t of order) {
        if (specialRows.some(row => row.call_type === t)) return t;
      }
    }
    if (rows.length > 0) return "normal";
    return "off";
  }

  // ── Lámparas por perfil de llamado especial ──────────────────────────────

  public getLampIdsForSpecialProfile(callType: string): string[] {
    return (this.db.prepare(`
      SELECT lamp_id FROM special_profile_lamps WHERE call_type = ?
    `).all(callType) as Array<{ lamp_id: string }>).map(row => row.lamp_id);
  }

  public setLampAssignmentsForSpecialProfile(callType: string, lampIds: string[]): void {
    this.db.prepare("DELETE FROM special_profile_lamps WHERE call_type = ?").run(callType);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO special_profile_lamps (call_type, lamp_id) VALUES (?, ?)
    `);
    for (const lampId of lampIds) insert.run(callType, lampId);
  }

  /** Ids de lámparas afectadas por un estado especial activo (para resync) */
  public getLampIdsForSpecialCallTypes(activeTypes: string[]): string[] {
    if (activeTypes.length === 0) return [];
    const placeholders = activeTypes.map(() => "?").join(",");
    return (this.db.prepare(`
      SELECT DISTINCT lamp_id FROM special_profile_lamps WHERE call_type IN (${placeholders})
    `).all(...activeTypes) as Array<{ lamp_id: string }>).map(row => row.lamp_id);
  }

  public getLampAlertProfiles(): LampAlertProfile[] {
    return (this.db.prepare(`
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
    `).all() as Record<string, unknown>[])
      .map(row => ({
        callType: row.call_type as string,
        label: row.label as string,
        enabled: Boolean(row.enabled),
        colorPreset: row.color_preset as number,
        animationPreset: row.animation_preset as number,
        soundPreset: row.sound_preset as number,
        audioEnabled: Boolean(row.audio_enabled),
        autoEndS: Number(row.auto_end_s ?? 0),
      }));
  }

  public getLampAlertProfile(callType: string): LampAlertProfile | undefined {
    return this.getLampAlertProfiles().find(profile => profile.callType === callType);
  }

  public updateLampAlertProfile(callType: string, values: Partial<Omit<LampAlertProfile, "callType">>): LampAlertProfile | undefined {
    const current = this.getLampAlertProfile(callType);
    if (!current) return undefined;
    const preset = (value: number | undefined, fallback: number) => Math.max(0, Math.min(19, Math.round(value ?? fallback)));
    const autoEndS = Math.max(0, Math.min(86_400, Math.round(values.autoEndS ?? current.autoEndS)));
    this.db.prepare(`
      UPDATE lamp_alert_profiles SET label = ?, enabled = ?, color_preset = ?, animation_preset = ?,
        sound_preset = ?, audio_enabled = ?, auto_end_s = ? WHERE call_type = ?
    `).run(
      values.label ?? current.label,
      (values.enabled ?? current.enabled) ? 1 : 0,
      preset(values.colorPreset, current.colorPreset),
      preset(values.animationPreset, current.animationPreset),
      preset(values.soundPreset, current.soundPreset),
      (values.audioEnabled ?? current.audioEnabled) ? 1 : 0,
      autoEndS,
      callType,
    );
    return this.getLampAlertProfile(callType);
  }

  // ── Location settings ────────────────────────────────────────────────────

  public getLocationSettings(): LocationSettings {
    const row = this.db.prepare("SELECT * FROM location_settings WHERE id = 1").get() as Record<string, unknown>;
    return {
      name: row.name as string,
      attentionTimeMin: Number(row.attention_time_min ?? 5) || 5,
      backgroundColor: row.background_color as string,
      headerColor: row.header_color as string,
      textColor: row.text_color as string,
      normalCallColor: row.normal_call_color as string,
      emergencyCallColor: row.emergency_call_color as string,
      timerColor: row.timer_color as string,
      soundEnabled: Boolean(row.sound_enabled),
      soundVolume: row.sound_volume as number,
      alertSound: row.alert_sound as string,
      emergencySound: row.emergency_sound as string,
      voiceEnabled: Boolean(row.voice_enabled),
      voiceRate: row.voice_rate as number,
      voicePitch: row.voice_pitch as number,
      voiceVolume: row.voice_volume as number,
      pendingReminderEnabled: Boolean(row.pending_reminder_enabled ?? 0),
      pendingReminderIntervalS: Number(row.pending_reminder_interval_s ?? 120) || 120,
      uiScalePercent: Number(row.ui_scale_percent ?? 100) || 100,
    };
  }

  public updateLocationSettings(values: Partial<LocationSettings>): LocationSettings {
    const current = this.getLocationSettings();
    const clamp = (value: number, min: number, max: number, fallback: number) =>
      Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
    this.db.prepare(`
      UPDATE location_settings SET
        name = ?, attention_time_min = ?, background_color = ?, header_color = ?, text_color = ?,
        normal_call_color = ?, emergency_call_color = ?, timer_color = ?,
        sound_enabled = ?, sound_volume = ?, alert_sound = ?, emergency_sound = ?,
        voice_enabled = ?, voice_rate = ?, voice_pitch = ?, voice_volume = ?,
        pending_reminder_enabled = ?, pending_reminder_interval_s = ?, ui_scale_percent = ?
      WHERE id = 1
    `).run(
      (values.name ?? current.name).trim() || current.name,
      clamp(values.attentionTimeMin ?? current.attentionTimeMin ?? 5, 1, 10, 5),
      values.backgroundColor ?? current.backgroundColor,
      values.headerColor ?? current.headerColor,
      values.textColor ?? current.textColor,
      values.normalCallColor ?? current.normalCallColor,
      values.emergencyCallColor ?? current.emergencyCallColor,
      values.timerColor ?? current.timerColor,
      (values.soundEnabled ?? current.soundEnabled) ? 1 : 0,
      clamp(values.soundVolume ?? current.soundVolume, 0, 100, current.soundVolume),
      values.alertSound ?? current.alertSound,
      values.emergencySound ?? current.emergencySound,
      (values.voiceEnabled ?? current.voiceEnabled) ? 1 : 0,
      clamp(values.voiceRate ?? current.voiceRate, 0.5, 2, current.voiceRate),
      clamp(values.voicePitch ?? current.voicePitch, 0.5, 2, current.voicePitch),
      clamp(values.voiceVolume ?? current.voiceVolume, 0, 1, current.voiceVolume),
      (values.pendingReminderEnabled ?? current.pendingReminderEnabled) ? 1 : 0,
      clamp(values.pendingReminderIntervalS ?? current.pendingReminderIntervalS ?? 120, 10, 900, 120),
      clamp(values.uiScalePercent ?? current.uiScalePercent ?? 100, 50, 200, 100),
    );
    return this.getLocationSettings();
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  public applyCallStart(deviceId: string, seq: number, cons: number, callType: CallType): ActiveCallState {
    if (isSpecialCallType(callType)) return this._applySpecialCallStart(deviceId, seq, cons, callType);

    const now = Date.now();
    const prev = this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId) as Record<string, unknown> | undefined;
    const startedAtMs = (prev && Boolean(prev.active)) ? (prev.started_at_ms as number) : now;
    const startSeq = (prev && Boolean(prev.active)) ? (prev.start_seq as number || seq) : seq;

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
    return this._rowToCall(
      this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
  }

  /** Inicia (o renueva por insistencia) un llamado especial de un dispositivo. */
  private _applySpecialCallStart(deviceId: string, seq: number, cons: number, callType: SpecialCallType): ActiveCallState {
    const now = Date.now();
    const prev = this.db
      .prepare("SELECT * FROM active_special_calls WHERE device_id = ? AND call_type = ?")
      .get(deviceId, callType) as Record<string, unknown> | undefined;
    const startedAtMs = (prev && Boolean(prev.active)) ? (prev.started_at_ms as number) : now;
    const startSeq = (prev && Boolean(prev.active)) ? (prev.start_seq as number || seq) : seq;

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
    return this._rowToCall(
      this.db.prepare("SELECT * FROM active_special_calls WHERE device_id = ? AND call_type = ?")
        .get(deviceId, callType) as Record<string, unknown>
    );
  }

  /**
   * Finaliza un llamado especial puntual y registra su historial.
   * Devuelve undefined si ese especial no estaba activo.
   * @param seq Solo si el cierre llegó en un frame del dispositivo (dedupe/ACK).
   */
  public applySpecialCallEnd(
    deviceId: string,
    callType: SpecialCallType,
    seq?: number,
  ): { state: ActiveCallState; historyRecord: CallHistoryRecord | undefined } | undefined {
    const prev = this.db
      .prepare("SELECT * FROM active_special_calls WHERE device_id = ? AND call_type = ?")
      .get(deviceId, callType) as Record<string, unknown> | undefined;
    if (!prev || !Boolean(prev.active)) return undefined;

    const now = Date.now();
    this.db.prepare("DELETE FROM active_special_calls WHERE device_id = ? AND call_type = ?")
      .run(deviceId, callType);
    if (seq !== undefined) this.markSeq(deviceId, seq);

    const historyRecord: CallHistoryRecord = {
      id:          `${deviceId}_${callType}_${now}`,
      deviceId,
      call_type:   callType,
      cons:        prev.cons as number,
      startedAtMs: prev.started_at_ms as number,
      endedAtMs:   now,
      durationMs:  now - (prev.started_at_ms as number),
      patientName: this.getPatientByDevice(deviceId)?.name,
      finishOrigin: seq !== undefined ? "llamador" : "monitor",
    };
    this.db.prepare(`
      INSERT OR IGNORE INTO call_history (id, device_id, call_type, cons, started_at_ms, ended_at_ms, duration_ms, patient_name, finish_origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(historyRecord.id, historyRecord.deviceId, historyRecord.call_type, historyRecord.cons,
           historyRecord.startedAtMs, historyRecord.endedAtMs, historyRecord.durationMs, historyRecord.patientName ?? '', historyRecord.finishOrigin ?? '');

    const state: ActiveCallState = {
      deviceId,
      active: false,
      cons: 0,
      call_type: callType,
      startedAtMs: historyRecord.startedAtMs,
      updatedAtMs: now,
      startSeq: prev.start_seq as number,
      lastSeq: seq ?? (prev.last_seq as number),
      finishOrigin: historyRecord.finishOrigin,
    };
    return { state, historyRecord };
  }

  public applyCallEnd(deviceId: string, seq: number): { state: ActiveCallState; historyRecord: CallHistoryRecord | undefined } {
    const now = Date.now();
    const prev = this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId) as Record<string, unknown> | undefined;

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

    let historyRecord: CallHistoryRecord | undefined;
    if (prev && Boolean(prev.active)) {
      const startedAtMs = prev.started_at_ms as number;
      const callType    = prev.call_type as CallType;
      const cons        = prev.cons as number;
      historyRecord = {
        id:          `${deviceId}_${now}`,
        deviceId,
        call_type:   callType,
        cons,
        startedAtMs,
        endedAtMs:   now,
        durationMs:  now - startedAtMs,
        patientName: this.getPatientByDevice(deviceId)?.name,
        finishOrigin: "llamador",
      };
      this.db.prepare(`
        INSERT OR IGNORE INTO call_history (id, device_id, call_type, cons, started_at_ms, ended_at_ms, duration_ms, patient_name, finish_origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(historyRecord.id, historyRecord.deviceId, historyRecord.call_type, historyRecord.cons,
             historyRecord.startedAtMs, historyRecord.endedAtMs, historyRecord.durationMs, historyRecord.patientName ?? '', historyRecord.finishOrigin ?? '');
    }

    const state = this._rowToCall(
      this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
    return { state: { ...state, finishOrigin: historyRecord?.finishOrigin }, historyRecord };
  }

  /** Activos de normal/emergency + todos los especiales activos (N por dispositivo). */
  public getActiveCalls(): ActiveCallState[] {
    const base = (this.db.prepare("SELECT * FROM active_calls WHERE active = 1").all() as Record<string, unknown>[])
      .map(r => this._rowToCall(r));
    const specials = (this.db.prepare("SELECT * FROM active_special_calls WHERE active = 1").all() as Record<string, unknown>[])
      .map(r => this._rowToCall(r));
    return [...base, ...specials].map(state => this.withPatientName(state));
  }

  /** Llamada propia del dispositivo (normal/emergency); los especiales no cuentan. */
  public getCallForDevice(deviceId: string): ActiveCallState | undefined {
    const row = this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId) as Record<string, unknown> | undefined;
    return row ? this._rowToCall(row) : undefined;
  }

  public getActiveCallForDevice(deviceId: string): ActiveCallState | undefined {
    const row = this.db
      .prepare("SELECT * FROM active_calls WHERE device_id = ? AND active = 1")
      .get(deviceId);
    return row ? this._rowToCall(row as Record<string, unknown>) : undefined;
  }

  /** Especiales activos de un dispositivo (varios a la vez). */
  public getActiveSpecialCallsForDevice(deviceId: string): ActiveCallState[] {
    return (this.db
      .prepare("SELECT * FROM active_special_calls WHERE device_id = ? AND active = 1 ORDER BY started_at_ms ASC")
      .all(deviceId) as Record<string, unknown>[])
      .map(r => this._rowToCall(r));
  }

  public getAllCalls(): ActiveCallState[] {
    const base = (this.db.prepare("SELECT * FROM active_calls").all() as Record<string, unknown>[])
      .map(r => this._rowToCall(r));
    const specials = (this.db.prepare("SELECT * FROM active_special_calls").all() as Record<string, unknown>[])
      .map(r => this._rowToCall(r));
    return [...base, ...specials];
  }

  public getCallHistory(deviceId?: string, limit = 500): CallHistoryRecord[] {
    if (deviceId) {
      return (this.db.prepare("SELECT * FROM call_history WHERE device_id = ? ORDER BY started_at_ms DESC LIMIT ?").all(deviceId, limit) as Record<string, unknown>[])
        .map(r => this._rowToHistory(r));
    }
    return (this.db.prepare("SELECT * FROM call_history ORDER BY started_at_ms DESC LIMIT ?").all(limit) as Record<string, unknown>[])
      .map(r => this._rowToHistory(r));
  }
  /** Fuerza el cierre de un llamado activo desde la UI (sin validar seq) */
  public forceEndCall(deviceId: string): { state: ActiveCallState; historyRecord: CallHistoryRecord | undefined } {
    const now = Date.now();
    const prev = this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId) as Record<string, unknown> | undefined;

    this.db.prepare(`
      INSERT INTO active_calls (device_id, active, cons, call_type, started_at_ms, updated_at_ms, last_seq)
      VALUES (?, 0, 0, 'normal', ?, ?, 0)
      ON CONFLICT(device_id) DO UPDATE SET
        active        = 0,
        cons          = 0,
        updated_at_ms = excluded.updated_at_ms
    `).run(deviceId, now, now);

    let historyRecord: CallHistoryRecord | undefined;
    if (prev && Boolean(prev.active)) {
      const startedAtMs = prev.started_at_ms as number;
      const callType    = prev.call_type as CallType;
      const cons        = prev.cons as number;
      historyRecord = {
        id:          `${deviceId}_${now}`,
        deviceId,
        call_type:   callType,
        cons,
        startedAtMs,
        endedAtMs:   now,
        durationMs:  now - startedAtMs,
        patientName: this.getPatientByDevice(deviceId)?.name,
        finishOrigin: "monitor",
      };
      this.db.prepare(`
        INSERT OR IGNORE INTO call_history (id, device_id, call_type, cons, started_at_ms, ended_at_ms, duration_ms, patient_name, finish_origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(historyRecord.id, historyRecord.deviceId, historyRecord.call_type, historyRecord.cons,
             historyRecord.startedAtMs, historyRecord.endedAtMs, historyRecord.durationMs, historyRecord.patientName ?? '', historyRecord.finishOrigin ?? '');
    }

    const state = this._rowToCall(
      this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
    return { state: { ...state, finishOrigin: historyRecord?.finishOrigin }, historyRecord };
  }
  // ── Patients ───────────────────────────────────────────────────────────────

  private _validateName(name: unknown): string {
    if (typeof name !== "string") throw new Error("El nombre del paciente es obligatorio");
    const value = String(name ?? "").trim();
    if (!value) throw new Error("El nombre del paciente es obligatorio");
    if (value.length > 60) throw new Error("El nombre no puede superar 60 caracteres");
    return value;
  }

  private _validateAge(age: unknown): number | null {
    if (age === null || age === undefined || age === "") return null;
    if (typeof age !== "number") throw new Error("Edad inválida (0-150)");
    const value = age;
    if (!Number.isInteger(value) || value < 0 || value > 150) throw new Error("Edad inválida (0-150)");
    return value;
  }

  private _validateAdmissionDate(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") throw new Error("Fecha de ingreso inválida");
    const text = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error("Fecha de ingreso inválida");
    return text;
  }

  private _validateNotes(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") throw new Error("Notas inválidas");
    const text = value.replace(/\s+/g, " ").trim();
    if (text.length > 120) throw new Error("Las notas no pueden superar 120 caracteres");
    return text;
  }

  private _validateDevice(deviceId: unknown): string | null {
    if (deviceId === null || deviceId === undefined || deviceId === "") return null;
    if (typeof deviceId !== "string") throw new Error("Llamador inválido");
    const value = deviceId;
    const device = this.getDevice(value);
    if (!device || /^RPT-/i.test(device.firmwareVersion ?? "")) throw new Error(`Llamador no encontrado: ${value}`);
    return value;
  }

  /** Libera el llamador si otro paciente lo tiene asignado (regla 1:1). */
  private _freeDevice(deviceId: string, exceptPatientId?: string): void {
    this.db.prepare(`
      UPDATE patients SET assigned_device = NULL, updated_at_ms = ?
      WHERE assigned_device = ? AND patient_id != ?
    `).run(Date.now(), deviceId, exceptPatientId ?? "");
  }

  public createPatient(input: PatientInput): PatientRecord {
    const name = this._validateName(input.name);
    const age = this._validateAge(input.age);
    const admissionDate = this._validateAdmissionDate(input.admissionDate);
    const notes = this._validateNotes(input.notes);
    const deviceId = this._validateDevice(input.assignedDevice);
    const now = Date.now();
    const patientId = randomUUID();

    this.db.transaction(() => {
      if (deviceId) this._freeDevice(deviceId, patientId);
      this.db.prepare(`
        INSERT INTO patients (patient_id, name, age, admission_date, notes, assigned_device, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(patientId, name, age, admissionDate, notes, deviceId, now, now);
    })();

    return this.getPatient(patientId)!;
  }

  public getPatient(patientId: string): PatientRecord | undefined {
    const row = this.db.prepare("SELECT * FROM patients WHERE patient_id = ?").get(patientId);
    return row ? this._rowToPatient(row as Record<string, unknown>) : undefined;
  }

  public getPatients(): PatientRecord[] {
    return (this.db.prepare("SELECT * FROM patients ORDER BY created_at_ms DESC").all() as Record<string, unknown>[])
      .map(row => this._rowToPatient(row));
  }

  public getPatientByDevice(deviceId: string): PatientRecord | undefined {
    if (!deviceId) return undefined;
    const row = this.db.prepare("SELECT * FROM patients WHERE assigned_device = ?").get(deviceId);
    return row ? this._rowToPatient(row as Record<string, unknown>) : undefined;
  }

  public updatePatient(patientId: string, input: PatientInput): PatientRecord | undefined {
    const current = this.getPatient(patientId);
    if (!current) return undefined;

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
      if (hasAssignment && deviceId && deviceId !== current.assignedDevice) this._freeDevice(deviceId, patientId);
      this.db.prepare(`
        UPDATE patients
        SET name = ?, age = ?, admission_date = ?, notes = ?, assigned_device = ?, updated_at_ms = ?
        WHERE patient_id = ?
      `).run(name, age, admissionDate, notes, deviceId, now, patientId);
    })();

    return this.getPatient(patientId);
  }

  public deletePatient(patientId: string): boolean {
    return this.db.prepare("DELETE FROM patients WHERE patient_id = ?").run(patientId).changes > 0;
  }

  /** Inyecta el nombre del paciente asignado (para payloads de llamada activa). */
  public withPatientName(state: ActiveCallState): ActiveCallState {
    const patient = this.getPatientByDevice(state.deviceId);
    return { ...state, patientName: patient?.name };
  }

  // ── Utilidades ────────────────────────────────────────────────────────────

  /** Marca todos los dispositivos offline (útil al arrancar) */
  public sweepOfflineDevices(timeoutMs: number, nowMs: number = Date.now()): string[] {
    const cutoff = nowMs - timeoutMs;
    const stale = this.db.prepare(
      "SELECT device_id FROM devices WHERE online = 1 AND last_seen_ms < ?"
    ).all(cutoff) as Array<{ device_id: string }>;
    if (stale.length === 0) return [];
    this.db.prepare(
      "UPDATE devices SET online = 0 WHERE online = 1 AND last_seen_ms < ?"
    ).run(cutoff);
    return stale.map(row => row.device_id);
  }

  public sweepOfflineLamps(timeoutMs: number, nowMs: number = Date.now()): string[] {
    const cutoff = nowMs - timeoutMs;
    const stale = this.db.prepare(
      "SELECT lamp_id FROM lamps WHERE online = 1 AND last_seen_ms < ?"
    ).all(cutoff) as Array<{ lamp_id: string }>;
    if (stale.length === 0) return [];
    this.db.prepare(
      "UPDATE lamps SET online = 0 WHERE online = 1 AND last_seen_ms < ?"
    ).run(cutoff);
    return stale.map(row => row.lamp_id);
  }

  public markAllOffline(): void {
    this.db.prepare("UPDATE devices SET online = 0").run();
    this.db.prepare("UPDATE lamps SET online = 0").run();
  }

  public close(): void {
    this.db.close();
  }
}

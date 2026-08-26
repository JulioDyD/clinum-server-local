import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type {
  ActiveCallState,
  CallHistoryRecord,
  CallType,
  DeviceRecord,
  LampEffectiveState,
  LampAlertProfile,
  LampRecord,
  LocationSettings,
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
        registered_at_ms INTEGER NOT NULL DEFAULT 0
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

      CREATE TABLE IF NOT EXISTS call_history (
        id            TEXT PRIMARY KEY,
        device_id     TEXT NOT NULL,
        call_type     TEXT NOT NULL DEFAULT 'normal',
        cons          INTEGER NOT NULL DEFAULT 0,
        started_at_ms INTEGER NOT NULL DEFAULT 0,
        ended_at_ms   INTEGER NOT NULL DEFAULT 0,
        duration_ms   INTEGER NOT NULL DEFAULT 0
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
        applied_revision    INTEGER NOT NULL DEFAULT 0,
        applied_state       TEXT NOT NULL DEFAULT 'off'
      );

      CREATE TABLE IF NOT EXISTS caller_lamps (
        caller_device_id TEXT NOT NULL,
        lamp_id          TEXT NOT NULL,
        PRIMARY KEY (caller_device_id, lamp_id),
        FOREIGN KEY (lamp_id) REFERENCES lamps(lamp_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lamp_alert_profiles (
        call_type         TEXT PRIMARY KEY,
        label             TEXT NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 0,
        color_preset      INTEGER NOT NULL DEFAULT 0,
        animation_preset  INTEGER NOT NULL DEFAULT 0,
        sound_preset      INTEGER NOT NULL DEFAULT 0,
        audio_enabled     INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS location_settings (
        id                    INTEGER PRIMARY KEY CHECK (id = 1),
        name                  TEXT NOT NULL DEFAULT 'Sede principal',
        background_color      TEXT NOT NULL DEFAULT '#0f172a',
        header_color          TEXT NOT NULL DEFAULT '#f59e0b',
        text_color            TEXT NOT NULL DEFAULT '#ffffff',
        normal_call_color     TEXT NOT NULL DEFAULT '#0ea5e9',
        emergency_call_color  TEXT NOT NULL DEFAULT '#ef4444',
        timer_color           TEXT NOT NULL DEFAULT '#22c55e',
        sound_enabled         INTEGER NOT NULL DEFAULT 1,
        sound_volume          INTEGER NOT NULL DEFAULT 80,
        alert_sound           TEXT NOT NULL DEFAULT 'clinum_normal.mp3',
        emergency_sound       TEXT NOT NULL DEFAULT 'clinum_emergency.mp3',
        voice_enabled         INTEGER NOT NULL DEFAULT 1,
        voice_rate            REAL NOT NULL DEFAULT 1.0,
        voice_pitch           REAL NOT NULL DEFAULT 1.0,
        voice_volume          REAL NOT NULL DEFAULT 0.9
      );

      CREATE INDEX IF NOT EXISTS idx_call_history_device ON call_history(device_id);
      CREATE INDEX IF NOT EXISTS idx_call_history_started ON call_history(started_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_caller_lamps_lamp ON caller_lamps(lamp_id);
    `);

    this.db.prepare("INSERT OR IGNORE INTO location_settings (id) VALUES (1)").run();

    const insertProfile = this.db.prepare(`
      INSERT OR IGNORE INTO lamp_alert_profiles
        (call_type, label, enabled, color_preset, animation_preset, sound_preset, audio_enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    insertProfile.run("normal", "Llamado normal", 1, 10, 1, 1);
    insertProfile.run("emergency", "Emergencia", 1, 0, 4, 4);
    insertProfile.run("type3", "Tipo 3", 0, 4, 7, 7);
    insertProfile.run("type4", "Tipo 4", 0, 6, 10, 10);
    insertProfile.run("type5", "Tipo 5", 0, 8, 13, 13);

    const callColumns = this.db.pragma("table_info(active_calls)") as Array<{ name: string }>;
    if (!callColumns.some(column => column.name === "start_seq")) {
      this.db.exec("ALTER TABLE active_calls ADD COLUMN start_seq INTEGER NOT NULL DEFAULT 0");
    }

    // Repara bases de datos pre-existentes que tenían una tabla `lamps` con un esquema anterior.
    this._ensureColumn("lamps", "relay_capable", "INTEGER NOT NULL DEFAULT 1");
    this._ensureColumn("lamps", "protocol_version", "INTEGER NOT NULL DEFAULT 1");
    this._ensureColumn("lamps", "audio_enabled", "INTEGER NOT NULL DEFAULT 1");
    this._ensureColumn("lamps", "brightness", "INTEGER NOT NULL DEFAULT 100");
    this._ensureColumn("lamps", "buzzer_volume", "INTEGER NOT NULL DEFAULT 100");
    this._ensureColumn("lamps", "applied_revision", "INTEGER NOT NULL DEFAULT 0");
    this._ensureColumn("lamps", "applied_state", "TEXT NOT NULL DEFAULT 'off'");
    this._ensureColumn("devices", "caller_location_type", "TEXT NOT NULL DEFAULT 'cama'");
  }

  private _ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some(existing => existing.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // ── Row → Type mappers ────────────────────────────────────────────────────

  private _rowToDevice(row: Record<string, unknown>): DeviceRecord {
    return {
      deviceId:       row.device_id as string,
      mac:            row.mac as string,
      name:           row.name as string | undefined,
      online:         Boolean(row.online),
      lastSeenMs:     row.last_seen_ms as number,
      registeredAtMs: row.registered_at_ms as number,
      callerLocationType: (row.caller_location_type as DeviceRecord["callerLocationType"]) ?? "cama",
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
    return {
      id:          row.id as string,
      deviceId:    row.device_id as string,
      call_type:   row.call_type as CallType,
      cons:        row.cons as number,
      startedAtMs: row.started_at_ms as number,
      endedAtMs:   row.ended_at_ms as number,
      durationMs:  row.duration_ms as number,
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
      appliedRevision: row.applied_revision as number,
      appliedState: row.applied_state as LampEffectiveState,
    };
  }

  // ── Seq tracking ──────────────────────────────────────────────────────────

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

  public registerDevice(deviceId: string, mac: string): DeviceRecord {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO devices (device_id, mac, online, last_seen_ms, registered_at_ms)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        mac            = CASE WHEN excluded.mac != '' THEN excluded.mac ELSE devices.mac END,
        online         = 1,
        last_seen_ms   = excluded.last_seen_ms
    `).run(deviceId, mac || "", now, now);

    return this._rowToDevice(
      this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
  }

  public touchDevice(deviceId: string, mac?: string): DeviceRecord {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO devices (device_id, mac, online, last_seen_ms, registered_at_ms)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        mac          = CASE WHEN excluded.mac != '' THEN excluded.mac ELSE devices.mac END,
        online       = 1,
        last_seen_ms = excluded.last_seen_ms
    `).run(deviceId, mac || "", now, now);

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
      this.db.prepare("DELETE FROM active_calls  WHERE device_id = ?").run(deviceId);
      this.db.prepare("DELETE FROM seq_tracker   WHERE device_id = ?").run(deviceId);
      return this.db.prepare("DELETE FROM devices WHERE device_id = ?").run(deviceId);
    })();
    return (result as Database.RunResult).changes > 0;
  }

  // ── Sound lamps ──────────────────────────────────────────────────────────

  public registerLamp(lampId: string, mac: string, relayCapable = true, protocolVersion = 1): LampRecord {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO lamps (lamp_id, mac, online, last_seen_ms, registered_at_ms, relay_capable, protocol_version)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(lamp_id) DO UPDATE SET
        mac              = CASE WHEN excluded.mac != '' THEN excluded.mac ELSE lamps.mac END,
        online           = 1,
        last_seen_ms     = excluded.last_seen_ms,
        relay_capable    = excluded.relay_capable,
        protocol_version = excluded.protocol_version
    `).run(lampId, mac || "", now, now, relayCapable ? 1 : 0, protocolVersion);
    return this.getLamp(lampId)!;
  }

  public touchLamp(lampId: string, mac?: string, appliedRevision?: number, appliedState?: LampEffectiveState): LampRecord {
    const lamp = this.registerLamp(lampId, mac ?? "");
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

  public deleteLamp(lampId: string): boolean {
    return this.db.prepare("DELETE FROM lamps WHERE lamp_id = ?").run(lampId).changes > 0;
  }

  public getLampIdsForCaller(callerDeviceId: string): string[] {
    return (this.db.prepare(`
      SELECT lamp_id FROM caller_lamps WHERE caller_device_id = ? ORDER BY lamp_id
    `).all(callerDeviceId) as Array<{ lamp_id: string }>).map(row => row.lamp_id);
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
    const rows = this.db.prepare(`
      SELECT active_calls.call_type
      FROM caller_lamps
      JOIN active_calls ON active_calls.device_id = caller_lamps.caller_device_id
      WHERE caller_lamps.lamp_id = ? AND active_calls.active = 1
    `).all(lampId) as Array<{ call_type: CallType }>;
    if (rows.some(row => row.call_type === "emergency")) return "emergency";
    if (rows.length > 0) return "normal";
    return "off";
  }

  public getLampAlertProfiles(): LampAlertProfile[] {
    return (this.db.prepare("SELECT * FROM lamp_alert_profiles ORDER BY rowid").all() as Record<string, unknown>[])
      .map(row => ({
        callType: row.call_type as string,
        label: row.label as string,
        enabled: Boolean(row.enabled),
        colorPreset: row.color_preset as number,
        animationPreset: row.animation_preset as number,
        soundPreset: row.sound_preset as number,
        audioEnabled: Boolean(row.audio_enabled),
      }));
  }

  public getLampAlertProfile(callType: string): LampAlertProfile | undefined {
    return this.getLampAlertProfiles().find(profile => profile.callType === callType);
  }

  public updateLampAlertProfile(callType: string, values: Partial<Omit<LampAlertProfile, "callType">>): LampAlertProfile | undefined {
    const current = this.getLampAlertProfile(callType);
    if (!current) return undefined;
    const preset = (value: number | undefined, fallback: number) => Math.max(0, Math.min(19, Math.round(value ?? fallback)));
    this.db.prepare(`
      UPDATE lamp_alert_profiles SET label = ?, enabled = ?, color_preset = ?, animation_preset = ?,
        sound_preset = ?, audio_enabled = ? WHERE call_type = ?
    `).run(
      values.label ?? current.label,
      (values.enabled ?? current.enabled) ? 1 : 0,
      preset(values.colorPreset, current.colorPreset),
      preset(values.animationPreset, current.animationPreset),
      preset(values.soundPreset, current.soundPreset),
      (values.audioEnabled ?? current.audioEnabled) ? 1 : 0,
      callType,
    );
    return this.getLampAlertProfile(callType);
  }

  // ── Location settings ────────────────────────────────────────────────────

  public getLocationSettings(): LocationSettings {
    const row = this.db.prepare("SELECT * FROM location_settings WHERE id = 1").get() as Record<string, unknown>;
    return {
      name: row.name as string,
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
    };
  }

  public updateLocationSettings(values: Partial<LocationSettings>): LocationSettings {
    const current = this.getLocationSettings();
    const clamp = (value: number, min: number, max: number, fallback: number) =>
      Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
    this.db.prepare(`
      UPDATE location_settings SET
        name = ?, background_color = ?, header_color = ?, text_color = ?,
        normal_call_color = ?, emergency_call_color = ?, timer_color = ?,
        sound_enabled = ?, sound_volume = ?, alert_sound = ?, emergency_sound = ?,
        voice_enabled = ?, voice_rate = ?, voice_pitch = ?, voice_volume = ?
      WHERE id = 1
    `).run(
      (values.name ?? current.name).trim() || current.name,
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
    );
    return this.getLocationSettings();
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  public applyCallStart(deviceId: string, seq: number, cons: number, callType: CallType): ActiveCallState {
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
      };
      this.db.prepare(`
        INSERT OR IGNORE INTO call_history (id, device_id, call_type, cons, started_at_ms, ended_at_ms, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(historyRecord.id, historyRecord.deviceId, historyRecord.call_type, historyRecord.cons,
             historyRecord.startedAtMs, historyRecord.endedAtMs, historyRecord.durationMs);
    }

    const state = this._rowToCall(
      this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
    return { state, historyRecord };
  }

  public getActiveCalls(): ActiveCallState[] {
    return (this.db.prepare("SELECT * FROM active_calls WHERE active = 1").all() as Record<string, unknown>[])
      .map(r => this._rowToCall(r));
  }

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

  public getAllCalls(): ActiveCallState[] {
    return (this.db.prepare("SELECT * FROM active_calls").all() as Record<string, unknown>[])
      .map(r => this._rowToCall(r));
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
      };
      this.db.prepare(`
        INSERT OR IGNORE INTO call_history (id, device_id, call_type, cons, started_at_ms, ended_at_ms, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(historyRecord.id, historyRecord.deviceId, historyRecord.call_type, historyRecord.cons,
             historyRecord.startedAtMs, historyRecord.endedAtMs, historyRecord.durationMs);
    }

    const state = this._rowToCall(
      this.db.prepare("SELECT * FROM active_calls WHERE device_id = ?").get(deviceId) as Record<string, unknown>
    );
    return { state, historyRecord };
  }
  // ── Utilidades ────────────────────────────────────────────────────────────

  /** Marca todos los dispositivos offline (útil al arrancar) */
  public markAllOffline(): void {
    this.db.prepare("UPDATE devices SET online = 0").run();
    this.db.prepare("UPDATE lamps SET online = 0").run();
  }

  public close(): void {
    this.db.close();
  }
}

export type CallType = "normal" | "emergency" | "type3" | "type4" | "type5" | "type6";

export const SPECIAL_CALL_TYPES = ["type3", "type4", "type5", "type6"] as const;
export type SpecialCallType = (typeof SPECIAL_CALL_TYPES)[number];

export function isSpecialCallType(value: string): value is SpecialCallType {
  return (SPECIAL_CALL_TYPES as readonly string[]).includes(value);
}

export type LampEffectiveState = "off" | "normal" | "emergency" | "presence" | SpecialCallType;

export type LampRecord = {
  lampId: string;
  mac: string;
  name?: string;
  online: boolean;
  lastSeenMs: number;
  registeredAtMs: number;
  relayCapable: boolean;
  protocolVersion: number;
  audioEnabled: boolean;
  brightness: number;
  buzzerVolume: number;
  transport: "espnow" | "lora";
  pendingTransport?: "espnow" | "lora";
  transportRequestedAtMs?: number;
  appliedRevision: number;
  appliedState: LampEffectiveState;
};

export type LampAssignment = {
  callerDeviceId: string;
  lampId: string;
};

export type LampAlertProfile = {
  callType: string;
  label: string;
  enabled: boolean;
  colorPreset: number;
  animationPreset: number;
  soundPreset: number;
  audioEnabled: boolean;
  /** Segundos antes de finalizar el llamado especial automáticamente (0 = solo manual) */
  autoEndS: number;
};

/** Configuración de la pantalla de sala (nombre, tema, sonidos y voz) */
export type LocationSettings = {
  name: string;
  attentionTimeMin: number;
  backgroundColor: string;
  headerColor: string;
  textColor: string;
  normalCallColor: string;
  emergencyCallColor: string;
  timerColor: string;
  soundEnabled: boolean;
  soundVolume: number;
  alertSound: string;
  emergencySound: string;
  voiceEnabled: boolean;
  voiceRate: number;
  voicePitch: number;
  voiceVolume: number;
  /** Aviso automático en pantalla mientras haya llamados sin finalizar */
  pendingReminderEnabled: boolean;
  /** Cada cuántos segundos se repite el aviso (10–900) */
  pendingReminderIntervalS: number;
};

export type IncomingFrame = {
  msgType: "register" | "call_start" | "call_insist" | "call_end" | "heartbeat" | "config_ack" |
    "presence" |
    "lamp_register" | "lamp_state_ack" | "lamp_heartbeat" | "lamp_snapshot_request" | "lamp_test_ack";
  deviceId: string;
  seq: number;
  sentAtMs: number;
  srcMac?: string;
  call_type?: CallType;
  cons?: number;
  configResult?: number;
  presenceState?: number;
  rssi?: number;
  hops?: number;
  lampId?: string;
  deviceType?: string;
  initialName?: string;
  relayCapable?: boolean;
  protocolVersion?: number;
  commandSeq?: number;
  stateRevision?: number;
  appliedRevision?: number;
  appliedState?: number;
  result?: number;
  gatewayRssi?: number;
  source?: "espnow" | "lora";
  firmwareVersion?: string;
  /** Stable identity of a clinical call, independent of individual event sequences. */
  callId?: number;
};

/** Registro local de un dispositivo llamador */
export type DeviceRecord = {
  deviceId: string;
  mac: string;
  name?: string;
  online: boolean;
  lastSeenMs: number;
  registeredAtMs: number;
  callerLocationType: "cama" | "sillon" | "bano";
  /** Red por la que se registro: "espnow" (NOW) o "lora" (LORA) */
  transport?: "espnow" | "lora";
  /** Version de firmware reportada en el REGISTER (ej. "TVLN-11.1" o "CLN-11.1") */
  firmwareVersion?: string;
};

export type ActiveCallState = {
  deviceId: string;
  active: boolean;
  cons: number;
  call_type: CallType;
  startedAtMs: number;
  updatedAtMs: number;
  startSeq: number;
  lastSeq: number;
  /** Nombre del paciente asignado al llamador (se inyecta en el servidor) */
  patientName?: string;
  /** Quién finalizó: llamador físico o monitor local (solo presente al cerrar) */
  finishOrigin?: "llamador" | "monitor";
};

/** Registro local de un paciente (asignacion 1:1 con un llamador) */
export type PatientRecord = {
  /** UUID string — mismo estilo que el doc-id de Firestore en la nube Clinum */
  patientId: string;
  name: string;
  age?: number;
  /** ISO-8601 "YYYY-MM-DDTHH:MM" (lo espera formatAdmissionDate del llamador) */
  admissionDate?: string;
  notes?: string;
  /** deviceId del llamador asignado o null */
  assignedDevice: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

/** Campos editables de un paciente (entrada del formulario) */
export type PatientInput = {
  name?: string;
  age?: number | null;
  admissionDate?: string | null;
  notes?: string | null;
  assignedDevice?: string | null;
};

/** Downlink server → gateway con los datos del paciente de un llamador */
export type PatientUpdateFrame = {
  msgType: "patient_update";
  deviceId: string;
  seq?: number;
  patient: {
    name: string;
    age?: string;
    admissionDate?: string;
    notes?: string;
  } | null;
};

/** Registro histórico de un llamado finalizado */
export type CallHistoryRecord = {
  id: string;
  deviceId: string;
  call_type: CallType;
  cons: number;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  /** Nombre del paciente asignado al cerrar (foto del momento, no cambia si se reasigna) */
  patientName?: string;
  /** Quién finalizó: llamador físico o monitor local */
  finishOrigin?: "llamador" | "monitor";
};

export type AckFrame = {
  msgType: "ack";
  deviceId: string;
  seq: number;
  result: "ok" | "duplicate" | "invalid" | "stale";
  callActive?: 0 | 1;
  callType?: CallType;
  callStartedAtS?: number;
  callCons?: number;
  callStartSeq?: number;
};

export type LampSessionAckFrame = {
  msgType: "lamp_session_ack";
  lampId: string;
  seq: number;
  result: "ok" | "duplicate" | "invalid";
};

export type ConfigUpdateFrame = {
  msgType: "config_update";
  deviceId: string;
  seq?: number;
  config: Record<string, unknown>;
};

export type TimeSyncFrame = {
  msgType: "time_sync";
  epochS: number;
};

export type LampStateFrame = {
  msgType: "lamp_state";
  lampId: string;
  commandSeq: number;
  stateRevision: number;
  associationRevision: number;
  effectiveState: 0 | 1 | 2;
  normalToggleMs: number;
  emergencyToggleMs: number;
  colorPreset: number;
  animationPreset: number;
  soundPreset: number;
  audioEnabled: boolean;
  brightness: number;
  buzzerVolume: number;
};

export type LampTestFrame = {
  msgType: "lamp_test";
  lampId: string;
  commandSeq: number;
  testState: 1 | 2;
  durationMs: number;
  colorPreset: number;
  animationPreset: number;
  soundPreset: number;
  audioEnabled: boolean;
  brightness: number;
  buzzerVolume: number;
};

export type GatewaySiteConfig = {
  siteId: string;
  gatewayId: string;
  opMode?: "local" | "test";
  espnow: {
    enabled: boolean;
    channel: number;
  };
  lora: {
    enabled: boolean;
    address: number;
    networkId: number;
    frequency: number;
    spreadingFactor: number;
    bandwidth: number;
    codingRate: number;
    preamble: number;
    crc: boolean;
    txPowerDbm: number;
  };
};

export type GatewayControlFrame =
  | { msgType: "gateway_config_required"; protocolVersion: number; mac?: string; firmwareVersion?: string }
  | { msgType: "gateway_config_ack"; result: "stored" | "invalid"; gatewayId?: string }
  | {
      msgType: "gateway_status";
      provisioned: boolean;
      siteId: string;
      gatewayId: string;
      /** MAC del gateway en formato AA:BB:CC:DD:EE:FF (firmware nuevo). */
      mac?: string;
      /** Versión de firmware reportada por el gateway. */
      firmwareVersion?: string;
      opMode?: string;
      serverOnline?: boolean;
      peerServer?: string;
      modeMismatch?: boolean;
      espnow: { configured: boolean; enabled: boolean; channel: number };
      lora: { configured: boolean; enabled: boolean; address: number; networkId: number; frequency: number };
    };

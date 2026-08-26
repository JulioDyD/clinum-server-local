export type CallType = "normal" | "emergency";

export type LampEffectiveState = "off" | "normal" | "emergency";

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
};

/** Configuración de la pantalla de sala (nombre, tema, sonidos y voz) */
export type LocationSettings = {
  name: string;
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
};

export type IncomingFrame = {
  msgType: "register" | "call_start" | "call_insist" | "call_end" | "heartbeat" | "config_ack" |
    "lamp_register" | "lamp_state_ack" | "lamp_heartbeat" | "lamp_snapshot_request" | "lamp_test_ack";
  deviceId: string;
  seq: number;
  sentAtMs: number;
  srcMac?: string;
  call_type?: CallType;
  cons?: number;
  configResult?: number;
  rssi?: number;
  hops?: number;
  lampId?: string;
  deviceType?: string;
  relayCapable?: boolean;
  protocolVersion?: number;
  commandSeq?: number;
  stateRevision?: number;
  appliedRevision?: number;
  appliedState?: number;
  result?: number;
  gatewayRssi?: number;
  source?: "espnow" | "lora";
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
};

export type AckFrame = {
  msgType: "ack";
  deviceId: string;
  seq: number;
  result: "ok" | "duplicate" | "invalid";
  callActive?: 0 | 1;
  callType?: "normal" | "emergency";
  callStartedAtS?: number;
  callCons?: number;
  callStartSeq?: number;
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

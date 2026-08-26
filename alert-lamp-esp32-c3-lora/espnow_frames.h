#pragma once

#include <stdint.h>

enum EspNowMsgType : uint8_t {
  ESPNOW_MSG_CALL_START = 1,
  ESPNOW_MSG_CALL_INSIST = 2,
  ESPNOW_MSG_CALL_END = 3,
  ESPNOW_MSG_HEARTBEAT = 4,
  ESPNOW_MSG_ACK = 5,
  ESPNOW_MSG_CONFIG = 6,
  ESPNOW_MSG_REGISTER = 7,
  ESPNOW_MSG_RELAY_REQ = 8,
  ESPNOW_MSG_RELAY_CONFIRM = 9,
  ESPNOW_MSG_CONFIG_ACK = 10,
  ESPNOW_MSG_LAMP_REGISTER = 11,
  ESPNOW_MSG_LAMP_STATE = 12,
  ESPNOW_MSG_LAMP_STATE_ACK = 13,
  ESPNOW_MSG_LAMP_HEARTBEAT = 14,
  ESPNOW_MSG_LAMP_SNAPSHOT_REQUEST = 15,
  ESPNOW_MSG_LAMP_TEST = 16,
  ESPNOW_MSG_LAMP_TEST_ACK = 17,
};

enum LampEffectiveState : uint8_t { LAMP_STATE_OFF = 0, LAMP_STATE_NORMAL = 1, LAMP_STATE_EMERGENCY = 2 };
enum LampApplyResult : uint8_t { LAMP_RESULT_INVALID = 0, LAMP_RESULT_APPLIED = 1, LAMP_RESULT_DUPLICATE = 2, LAMP_RESULT_OLD_REVISION = 3 };

struct __attribute__((packed)) EspNowCallFrame {
  uint8_t msgType; uint32_t seq; uint32_t sentAtMs; uint16_t cons; uint8_t isEmergency; char deviceId[13];
};
struct __attribute__((packed)) EspNowAckFrame {
  uint8_t msgType; uint32_t seq; uint8_t result; char deviceId[13]; uint32_t epochS; uint8_t callActive;
  uint8_t callType; uint32_t callStartedAtS; uint16_t callCons; uint32_t callStartSeq;
};
struct __attribute__((packed)) EspNowConfigFrame {
  uint8_t msgType; uint32_t seq; uint8_t applyWiFi; uint8_t useStaticIP; char deviceId[13]; char ssid[33];
  char password[65]; char ip[16]; char gateway[16]; char subnet[16]; char dns1[16]; char dns2[16];
  uint8_t applyBrightness; uint8_t brightness; uint8_t applyAudioAlert; uint8_t audioAlertEnabled;
  uint8_t applyName; char name[33]; uint8_t endCall; uint32_t targetCallSeq;
};
struct __attribute__((packed)) EspNowCallFrameEmbed {
  uint8_t msgType; uint32_t seq; uint32_t sentAtMs; uint16_t cons; uint8_t isEmergency; char deviceId[13];
};
struct __attribute__((packed)) EspNowRelayReqFrame {
  uint8_t msgType; uint32_t relaySeq; uint8_t origMac[6]; uint8_t prevHopMac[6]; uint32_t origSeq;
  uint8_t ttl; char deviceId[13]; EspNowCallFrameEmbed embedded;
};
struct __attribute__((packed)) EspNowRelayConfirmFrame {
  uint8_t msgType; uint32_t origSeq; uint8_t result; char deviceId[13]; uint32_t epochS;
};
struct __attribute__((packed)) LampRegisterFrame {
  uint8_t msgType; uint32_t seq; uint32_t sentAtMs; char lampId[13]; char deviceType[24]; uint8_t relayCapable; uint8_t protocolVersion;
};
struct __attribute__((packed)) LampStateFrame {
  uint8_t msgType; uint32_t commandSeq; uint64_t stateRevision; uint32_t associationRevision; uint8_t effectiveState;
  uint16_t normalToggleMs; uint16_t emergencyToggleMs; uint8_t colorPreset; uint8_t animationPreset;
  uint8_t soundPreset; uint8_t audioEnabled; uint8_t brightness; uint8_t buzzerVolume; char lampId[13];
};
struct __attribute__((packed)) LampStateAckFrame {
  uint8_t msgType; uint32_t commandSeq; uint64_t stateRevision; uint8_t appliedState; uint8_t result; char lampId[13];
};
struct __attribute__((packed)) LampHeartbeatFrame {
  uint8_t msgType; uint32_t seq; uint32_t sentAtMs; uint64_t appliedRevision; uint8_t appliedState;
  uint8_t relayCapable; int8_t gatewayRssi; char lampId[13];
};
struct __attribute__((packed)) LampSnapshotRequestFrame {
  uint8_t msgType; uint32_t seq; uint64_t appliedRevision; char lampId[13];
};
struct __attribute__((packed)) LampTestFrame {
  uint8_t msgType; uint32_t commandSeq; uint8_t testState; uint16_t durationMs;
  uint8_t colorPreset; uint8_t animationPreset; uint8_t soundPreset; uint8_t audioEnabled; uint8_t brightness;
  uint8_t buzzerVolume; char lampId[13];
};

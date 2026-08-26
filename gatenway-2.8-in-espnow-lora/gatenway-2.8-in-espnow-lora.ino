#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_now.h>
#include <ArduinoJson.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include "iot_config.h"

#if LORA_ENABLED
#include "lora_transport.h"
HardwareSerial LoraSerial(1);
LoraTransport lora;
LoraConfig loraCfg;
String loraLine;
#endif

enum EspNowMsgType : uint8_t {
  ESPNOW_MSG_CALL_START = 1,
  ESPNOW_MSG_CALL_INSIST = 2,
  ESPNOW_MSG_CALL_END = 3,
  ESPNOW_MSG_HEARTBEAT = 4,
  ESPNOW_MSG_ACK = 5,
  ESPNOW_MSG_CONFIG = 6,
  ESPNOW_MSG_REGISTER = 7,
  ESPNOW_MSG_CONFIG_ACK = 10,
  ESPNOW_MSG_LAMP_REGISTER = 11,
  ESPNOW_MSG_LAMP_STATE = 12,
  ESPNOW_MSG_LAMP_STATE_ACK = 13,
  ESPNOW_MSG_LAMP_HEARTBEAT = 14,
  ESPNOW_MSG_LAMP_SNAPSHOT_REQUEST = 15,
  ESPNOW_MSG_LAMP_TEST = 16,
  ESPNOW_MSG_LAMP_TEST_ACK = 17,
};

static const uint8_t ESPNOW_BROADCAST_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

struct __attribute__((packed)) EspNowCallFrame {
  uint8_t msgType;
  uint32_t seq;
  uint32_t sentAtMs;
  uint16_t cons;
  uint8_t isEmergency;
  char deviceId[13];
};

struct __attribute__((packed)) EspNowRegisterFrame {
  uint8_t msgType;
  uint32_t seq;
  uint32_t sentAtMs;
  char deviceId[13];
};

struct __attribute__((packed)) EspNowAckFrame {
  uint8_t msgType;
  uint32_t seq;
  uint8_t result; // 0=invalid,1=ok,2=duplicate
  char deviceId[13];
  uint32_t epochS;         // epoch segundos del servidor (0=no sincronizado)
  uint8_t  callActive;     // 1 = hay llamado activo que el terminal debe retomar
  uint8_t  callType;       // 0=normal, 1=emergency
  uint32_t callStartedAtS; // epoch segundos cuando inicio el llamado
  uint16_t callCons;       // consecutivos acumulados del llamado
  uint32_t callStartSeq;   // secuencia estable del inicio de la llamada activa
};

struct __attribute__((packed)) EspNowConfigFrame {
  uint8_t msgType;
  uint32_t seq;
  uint8_t applyWiFi;
  uint8_t useStaticIP;
  char deviceId[13];
  char ssid[33];
  char password[65];
  char ip[16];
  char gateway[16];
  char subnet[16];
  char dns1[16];
  char dns2[16];
  uint8_t applyBrightness;
  uint8_t brightness;
  uint8_t applyAudioAlert;
  uint8_t audioAlertEnabled;
  uint8_t applyName;
  char name[33];
  uint8_t endCall;
  uint32_t targetCallSeq;
};

struct __attribute__((packed)) LampRegisterFrame {
  uint8_t msgType;
  uint32_t seq;
  uint32_t sentAtMs;
  char lampId[13];
  char deviceType[24];
  uint8_t relayCapable;
  uint8_t protocolVersion;
};

struct __attribute__((packed)) LampStateFrame {
  uint8_t msgType;
  uint32_t commandSeq;
  uint64_t stateRevision;
  uint32_t associationRevision;
  uint8_t effectiveState;
  uint16_t normalToggleMs;
  uint16_t emergencyToggleMs;
  uint8_t colorPreset;
  uint8_t animationPreset;
  uint8_t soundPreset;
  uint8_t audioEnabled;
  uint8_t brightness;
  uint8_t buzzerVolume;
  char lampId[13];
};

struct __attribute__((packed)) LampStateAckFrame {
  uint8_t msgType;
  uint32_t commandSeq;
  uint64_t stateRevision;
  uint8_t appliedState;
  uint8_t result;
  char lampId[13];
};

struct __attribute__((packed)) LampHeartbeatFrame {
  uint8_t msgType;
  uint32_t seq;
  uint32_t sentAtMs;
  uint64_t appliedRevision;
  uint8_t appliedState;
  uint8_t relayCapable;
  int8_t gatewayRssi;
  char lampId[13];
};

struct __attribute__((packed)) LampSnapshotRequestFrame {
  uint8_t msgType;
  uint32_t seq;
  uint64_t appliedRevision;
  char lampId[13];
};

struct __attribute__((packed)) LampTestFrame {
  uint8_t msgType;
  uint32_t commandSeq;
  uint8_t testState;
  uint16_t durationMs;
  uint8_t colorPreset;
  uint8_t animationPreset;
  uint8_t soundPreset;
  uint8_t audioEnabled;
  uint8_t brightness;
  uint8_t buzzerVolume;
  char lampId[13];
};

enum class DeviceTransport : uint8_t {
  NONE = 0,
  ESPNOW = 1,
  LORA = 2,
};

struct DeviceRoute {
  bool used;
  char deviceId[13];
  uint8_t mac[6];
  DeviceTransport transport;
  uint16_t loraAddr;
  uint32_t lastSeenMs;
};

DeviceRoute routes[MAX_KNOWN_DEVICES];
String serialLine;

struct EspNowRxItem {
  uint8_t srcMac[6];
  uint8_t data[64]; // >= sizeof(LampRegisterFrame), la trama entrante mas grande soportada
  uint8_t len;
  bool updateRoute;
};

QueueHandle_t eventRxQueue = nullptr;
QueueHandle_t heartbeatRxQueue = nullptr;
volatile uint32_t droppedEventFrames = 0;
volatile uint32_t droppedHeartbeatFrames = 0;
volatile uint32_t droppedUnknownFrames = 0;

// ---- Deduplicacion: evita emitir dos veces el mismo frame (relay + directo) ----
struct DedupEntry {
  bool     used;
  char     deviceId[13];
  uint32_t seq;
  uint32_t seenAtMs;
};
DedupEntry dedupCache[ESPNOW_DEDUP_CACHE_SIZE];

// ---- Sincronizacion de tiempo desde servidor ----
static uint32_t epochBaseS  = 0;   // epoch en segundos al momento de sync
static uint32_t epochSyncMs = 0;   // millis() al momento de sync
static bool     timeSynced  = false;

uint32_t currentEpochS() {
  if (!timeSynced) return 0;
  return epochBaseS + (uint32_t)((millis() - (unsigned long)epochSyncMs) / 1000UL);
}

bool isDuplicate(const char* devId, uint32_t seq) {
  uint32_t now = millis();
  for (int i = 0; i < ESPNOW_DEDUP_CACHE_SIZE; i++) {
    if (!dedupCache[i].used) continue;
    // Expirar entradas antiguas
    if ((now - dedupCache[i].seenAtMs) > ESPNOW_DEDUP_TTL_MS) {
      dedupCache[i].used = false;
      continue;
    }
    if (dedupCache[i].seq == seq && strncmp(dedupCache[i].deviceId, devId, 12) == 0) {
      return true;  // Ya fue procesado
    }
  }
  return false;
}

void markSeen(const char* devId, uint32_t seq) {
  uint32_t now = millis();
  // Buscar slot libre o el mas antiguo
  int slot = 0;
  uint32_t oldest = UINT32_MAX;
  for (int i = 0; i < ESPNOW_DEDUP_CACHE_SIZE; i++) {
    if (!dedupCache[i].used || (now - dedupCache[i].seenAtMs) > ESPNOW_DEDUP_TTL_MS) {
      slot = i;
      break;
    }
    if (dedupCache[i].seenAtMs < oldest) { oldest = dedupCache[i].seenAtMs; slot = i; }
  }
  dedupCache[slot].used = true;
  dedupCache[slot].seq  = seq;
  dedupCache[slot].seenAtMs = now;
  strncpy(dedupCache[slot].deviceId, devId, 12);
  dedupCache[slot].deviceId[12] = '\0';
}

static const char* msgTypeToString(uint8_t t) {
  switch (t) {
    case ESPNOW_MSG_REGISTER: return "register";
    case ESPNOW_MSG_CALL_START: return "call_start";
    case ESPNOW_MSG_CALL_INSIST: return "call_insist";
    case ESPNOW_MSG_CALL_END: return "call_end";
    case ESPNOW_MSG_HEARTBEAT: return "heartbeat";
    case ESPNOW_MSG_LAMP_REGISTER: return "lamp_register";
    case ESPNOW_MSG_LAMP_STATE_ACK: return "lamp_state_ack";
    case ESPNOW_MSG_LAMP_HEARTBEAT: return "lamp_heartbeat";
    case ESPNOW_MSG_LAMP_SNAPSHOT_REQUEST: return "lamp_snapshot_request";
    case ESPNOW_MSG_LAMP_TEST_ACK: return "lamp_test_ack";
    default: return "unknown";
  }
}

String macToString(const uint8_t mac[6]) {
  char buf[18];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

int findRouteById(const char* deviceId) {
  for (int i = 0; i < MAX_KNOWN_DEVICES; ++i) {
    if (routes[i].used && strncmp(routes[i].deviceId, deviceId, 12) == 0) return i;
  }
  return -1;
}

int allocRoute(const char* deviceId) {
  int freeIdx = -1;
  uint32_t oldestMs = UINT32_MAX;
  int oldestIdx = 0;

  for (int i = 0; i < MAX_KNOWN_DEVICES; ++i) {
    if (!routes[i].used && freeIdx < 0) freeIdx = i;
    if (routes[i].used && routes[i].lastSeenMs < oldestMs) {
      oldestMs = routes[i].lastSeenMs;
      oldestIdx = i;
    }
  }

  int idx = (freeIdx >= 0) ? freeIdx : oldestIdx;
  routes[idx].used = true;
  routes[idx].transport = DeviceTransport::NONE;
  routes[idx].loraAddr = 0;
  strncpy(routes[idx].deviceId, deviceId, sizeof(routes[idx].deviceId) - 1);
  routes[idx].deviceId[12] = '\0';
  return idx;
}

void upsertRoute(const char* deviceId, const uint8_t srcMac[6]) {
  int idx = findRouteById(deviceId);
  if (idx < 0) idx = allocRoute(deviceId);

  memcpy(routes[idx].mac, srcMac, 6);
  routes[idx].transport = DeviceTransport::ESPNOW;
  routes[idx].loraAddr = 0;
  routes[idx].lastSeenMs = millis();

  if (!esp_now_is_peer_exist(srcMac)) {
    // Verificar limite de peers ESP-NOW (20 unicast)
    esp_now_peer_num_t peerCount = {};
    esp_now_get_peer_num(&peerCount);
    if (peerCount.total_num >= ESPNOW_MAX_UNICAST_PEERS) {
      // Eliminar el peer mas antiguo del route table que este registrado
      uint32_t oldestMs  = UINT32_MAX;
      int      oldestIdx = -1;
      for (int i = 0; i < MAX_KNOWN_DEVICES; i++) {
        if (!routes[i].used) continue;
        if (memcmp(routes[i].mac, srcMac, 6) == 0) continue;  // No es el actual
        if (routes[i].lastSeenMs < oldestMs && esp_now_is_peer_exist(routes[i].mac)) {
          oldestMs  = routes[i].lastSeenMs;
          oldestIdx = i;
        }
      }
      if (oldestIdx >= 0) {
        esp_now_del_peer(routes[oldestIdx].mac);
        #if ENABLE_SERIAL_DEBUG
        Serial.print("DEBUG peer LRU removido: slot=");
        Serial.println(oldestIdx);
        #endif
      }
    }
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, srcMac, 6);
    peer.channel = ESPNOW_CHANNEL;
    peer.encrypt = false;
    esp_now_add_peer(&peer);
  }
}

void upsertLoraRoute(const char* deviceId, uint16_t loraAddr) {
  int idx = findRouteById(deviceId);
  if (idx < 0) idx = allocRoute(deviceId);
  routes[idx].transport = DeviceTransport::LORA;
  routes[idx].loraAddr = loraAddr;
  routes[idx].lastSeenMs = millis();
}

void loraSynthMac(uint16_t addr, uint8_t out[6]) {
  out[0] = 0x00; out[1] = 0x00; out[2] = 0x00; out[3] = 0x00;
  out[4] = (uint8_t)(addr >> 8);
  out[5] = (uint8_t)(addr & 0xFF);
}

bool sendViaLora(const char* deviceId, const char* line) {
  int idx = findRouteById(deviceId);
  if (idx < 0 || routes[idx].transport != DeviceTransport::LORA) return false;
  return lora.sendLine(routes[idx].loraAddr, line);
}

void emitUplinkJson(const EspNowCallFrame& frame, const uint8_t srcMac[6], const char* source = "espnow") {
  // El servidor local es la autoridad de deduplicacion y siempre responde al
  // reintento. No silenciar aqui: pudo haberse perdido el ACK anterior.
  if (isDuplicate(frame.deviceId, frame.seq)) {
    #if ENABLE_SERIAL_DEBUG
    Serial.print("DEBUG dedup descartado seq=");
    Serial.print(frame.seq);
    Serial.print(" dev=");
    Serial.println(frame.deviceId);
    #endif
  } else {
    markSeen(frame.deviceId, frame.seq);
  }

  StaticJsonDocument<256> doc;
  doc["msgType"] = msgTypeToString(frame.msgType);
  doc["deviceId"] = frame.deviceId;
  doc["seq"] = frame.seq;
  doc["sentAtMs"] = frame.sentAtMs;
  doc["srcMac"] = macToString(srcMac);
  doc["source"] = source;

  if (frame.msgType == ESPNOW_MSG_CALL_START || frame.msgType == ESPNOW_MSG_CALL_INSIST) {
    doc["call_type"] = frame.isEmergency ? "emergency" : "normal";
    doc["cons"] = frame.cons;
  }

  String out;
  serializeJson(doc, out);
  Serial.println(out);

  #if ENABLE_SERIAL_DEBUG
  Serial.print("DEBUG uplink emitted seq=");
  Serial.println(frame.seq);
  #endif
}

void emitRegisterJson(const EspNowRegisterFrame& frame, const uint8_t srcMac[6], const char* source = "espnow") {
  StaticJsonDocument<256> doc;
  doc["msgType"] = "register";
  doc["deviceId"] = frame.deviceId;
  doc["seq"] = frame.seq;
  doc["sentAtMs"] = frame.sentAtMs;
  doc["srcMac"] = macToString(srcMac);
  doc["source"] = source;

  String out;
  serializeJson(doc, out);
  Serial.println(out);

  #if ENABLE_SERIAL_DEBUG
  Serial.print("DEBUG register emitted seq=");
  Serial.println(frame.seq);
  #endif
}

void emitLampJson(const EspNowRxItem& item) {
  const uint8_t msgType = item.data[0];
  StaticJsonDocument<320> doc;
  doc["msgType"] = msgTypeToString(msgType);
  doc["srcMac"] = macToString(item.srcMac);

  if (msgType == ESPNOW_MSG_LAMP_REGISTER && item.len == sizeof(LampRegisterFrame)) {
    LampRegisterFrame frame = {};
    memcpy(&frame, item.data, sizeof(frame));
    frame.lampId[12] = '\0';
    frame.deviceType[23] = '\0';
    upsertRoute(frame.lampId, item.srcMac);
    doc["lampId"] = frame.lampId;
    doc["seq"] = frame.seq;
    doc["sentAtMs"] = frame.sentAtMs;
    doc["deviceType"] = frame.deviceType;
    doc["relayCapable"] = frame.relayCapable != 0;
    doc["protocolVersion"] = frame.protocolVersion;
  } else if ((msgType == ESPNOW_MSG_LAMP_STATE_ACK || msgType == ESPNOW_MSG_LAMP_TEST_ACK) &&
             item.len == sizeof(LampStateAckFrame)) {
    LampStateAckFrame frame = {};
    memcpy(&frame, item.data, sizeof(frame));
    frame.lampId[12] = '\0';
    upsertRoute(frame.lampId, item.srcMac);
    doc["lampId"] = frame.lampId;
    doc["commandSeq"] = frame.commandSeq;
    doc["stateRevision"] = frame.stateRevision;
    doc["appliedState"] = frame.appliedState;
    doc["result"] = frame.result;
  } else if (msgType == ESPNOW_MSG_LAMP_HEARTBEAT && item.len == sizeof(LampHeartbeatFrame)) {
    LampHeartbeatFrame frame = {};
    memcpy(&frame, item.data, sizeof(frame));
    frame.lampId[12] = '\0';
    upsertRoute(frame.lampId, item.srcMac);
    doc["lampId"] = frame.lampId;
    doc["seq"] = frame.seq;
    doc["sentAtMs"] = frame.sentAtMs;
    doc["appliedRevision"] = frame.appliedRevision;
    doc["appliedState"] = frame.appliedState;
    doc["relayCapable"] = frame.relayCapable != 0;
    doc["gatewayRssi"] = frame.gatewayRssi;
  } else if (msgType == ESPNOW_MSG_LAMP_SNAPSHOT_REQUEST && item.len == sizeof(LampSnapshotRequestFrame)) {
    LampSnapshotRequestFrame frame = {};
    memcpy(&frame, item.data, sizeof(frame));
    frame.lampId[12] = '\0';
    upsertRoute(frame.lampId, item.srcMac);
    doc["lampId"] = frame.lampId;
    doc["seq"] = frame.seq;
    doc["appliedRevision"] = frame.appliedRevision;
  } else {
    return;
  }

  String out;
  serializeJson(doc, out);
  Serial.println(out);
}

void processEspNowRxItem(const EspNowRxItem& item) {
  const uint8_t* data = item.data;
  int len = item.len;
  uint8_t msgType = item.data[0];

  if (msgType == ESPNOW_MSG_LAMP_REGISTER || msgType == ESPNOW_MSG_LAMP_STATE_ACK ||
      msgType == ESPNOW_MSG_LAMP_HEARTBEAT || msgType == ESPNOW_MSG_LAMP_SNAPSHOT_REQUEST ||
      msgType == ESPNOW_MSG_LAMP_TEST_ACK) {
    emitLampJson(item);
    return;
  }

  if (msgType == ESPNOW_MSG_REGISTER) {
    if (len < (int)sizeof(EspNowRegisterFrame)) return;

    EspNowRegisterFrame reg = {};
    memcpy(&reg, data, sizeof(EspNowRegisterFrame));
    reg.deviceId[12] = '\0';

    upsertRoute(reg.deviceId, item.srcMac);
    emitRegisterJson(reg, item.srcMac);
    return;
  }

  if (msgType >= ESPNOW_MSG_CALL_START && msgType <= ESPNOW_MSG_HEARTBEAT) {
    if (len < (int)sizeof(EspNowCallFrame)) return;

    EspNowCallFrame frame = {};
    memcpy(&frame, data, sizeof(EspNowCallFrame));
    frame.deviceId[12] = '\0';

    if (item.updateRoute) upsertRoute(frame.deviceId, item.srcMac);
    emitUplinkJson(frame, item.srcMac);
    return;
  }

  if (msgType == ESPNOW_MSG_CONFIG_ACK) {
    if (len < (int)sizeof(EspNowCallFrame)) return;
    EspNowCallFrame frame = {};
    memcpy(&frame, data, sizeof(EspNowCallFrame));
    frame.deviceId[12] = '\0';
    if (item.updateRoute) upsertRoute(frame.deviceId, item.srcMac);

    StaticJsonDocument<192> doc;
    doc["msgType"] = "config_ack";
    doc["deviceId"] = frame.deviceId;
    doc["seq"] = frame.seq;
    doc["sentAtMs"] = frame.sentAtMs;
    doc["configResult"] = frame.cons > 0 ? 1 : 0;
    String out;
    serializeJson(doc, out);
    Serial.println(out);
  }
}

void onEspNowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  if (!info || !data || len <= 0 || len > (int)sizeof(EspNowRxItem::data)) return;

  const uint8_t msgType = data[0];
  const bool isRegister = msgType == ESPNOW_MSG_REGISTER && len >= (int)sizeof(EspNowRegisterFrame);
  const bool isCallFrame = msgType >= ESPNOW_MSG_CALL_START &&
                           msgType <= ESPNOW_MSG_HEARTBEAT &&
                           len >= (int)sizeof(EspNowCallFrame);
  const bool isConfigAck = msgType == ESPNOW_MSG_CONFIG_ACK && len >= (int)sizeof(EspNowCallFrame);
  const bool isLampFrame =
      (msgType == ESPNOW_MSG_LAMP_REGISTER && len == (int)sizeof(LampRegisterFrame)) ||
      ((msgType == ESPNOW_MSG_LAMP_STATE_ACK || msgType == ESPNOW_MSG_LAMP_TEST_ACK) &&
       len == (int)sizeof(LampStateAckFrame)) ||
      (msgType == ESPNOW_MSG_LAMP_HEARTBEAT && len == (int)sizeof(LampHeartbeatFrame)) ||
      (msgType == ESPNOW_MSG_LAMP_SNAPSHOT_REQUEST && len == (int)sizeof(LampSnapshotRequestFrame));
  if (!isRegister && !isCallFrame && !isConfigAck && !isLampFrame) {
    droppedUnknownFrames++;
    return;
  }

  EspNowRxItem item = {};
  memcpy(item.srcMac, info->src_addr, 6);
  memcpy(item.data, data, len);
  item.len = (uint8_t)len;
  item.updateRoute = !(msgType == ESPNOW_MSG_HEARTBEAT &&
                       memcmp(info->des_addr, ESPNOW_BROADCAST_MAC, 6) == 0);

  QueueHandle_t queue = msgType == ESPNOW_MSG_HEARTBEAT ? heartbeatRxQueue : eventRxQueue;
  if (!queue || xQueueSend(queue, &item, 0) != pdTRUE) {
    if (msgType == ESPNOW_MSG_HEARTBEAT) droppedHeartbeatFrames++;
    else droppedEventFrames++;
  }
}

void handleLampStateFromLocal(JsonDocument& doc) {
  const char* lampId = doc["lampId"] | "";
  int idx = findRouteById(lampId);
  if (idx < 0) return;

  LampStateFrame frame = {};
  frame.msgType = ESPNOW_MSG_LAMP_STATE;
  frame.commandSeq = doc["commandSeq"] | (uint32_t)millis();
  frame.stateRevision = doc["stateRevision"] | (uint64_t)0;
  frame.associationRevision = doc["associationRevision"] | (uint32_t)0;
  frame.effectiveState = doc["effectiveState"] | (uint8_t)0;
  frame.normalToggleMs = doc["normalToggleMs"] | (uint16_t)500;
  frame.emergencyToggleMs = doc["emergencyToggleMs"] | (uint16_t)200;
  frame.colorPreset = constrain((int)(doc["colorPreset"] | 0), 0, 19);
  frame.animationPreset = constrain((int)(doc["animationPreset"] | 0), 0, 19);
  frame.soundPreset = constrain((int)(doc["soundPreset"] | 0), 0, 19);
  frame.audioEnabled = (bool)(doc["audioEnabled"] | true) ? 1 : 0;
  frame.brightness = constrain((int)(doc["brightness"] | 100), 1, 100);
  frame.buzzerVolume = constrain((int)(doc["buzzerVolume"] | 100), 0, 100);
  strncpy(frame.lampId, lampId, sizeof(frame.lampId) - 1);
  if (routes[idx].transport == DeviceTransport::LORA) {
    char line[LORA_LINE_MAX];
    snprintf(line, sizeof(line),
             "LAMP_STATE,%s,%lu,%llu,%lu,%u,%u,%u,%u,%u,%u,%u,%u,%u",
             lampId, (unsigned long)frame.commandSeq, (unsigned long long)frame.stateRevision,
             (unsigned long)frame.associationRevision, frame.effectiveState,
             frame.normalToggleMs, frame.emergencyToggleMs, frame.colorPreset,
             frame.animationPreset, frame.soundPreset, frame.audioEnabled,
             frame.brightness, frame.buzzerVolume);
    lora.sendLine(routes[idx].loraAddr, line);
    return;
  }
  esp_now_send(routes[idx].mac, (const uint8_t*)&frame, sizeof(frame));
}

void handleLampTestFromLocal(JsonDocument& doc) {
  const char* lampId = doc["lampId"] | "";
  int idx = findRouteById(lampId);
  if (idx < 0) return;

  LampTestFrame frame = {};
  frame.msgType = ESPNOW_MSG_LAMP_TEST;
  frame.commandSeq = doc["commandSeq"] | (uint32_t)millis();
  frame.testState = doc["testState"] | (uint8_t)1;
  frame.durationMs = doc["durationMs"] | (uint16_t)3000;
  frame.colorPreset = constrain((int)(doc["colorPreset"] | 0), 0, 19);
  frame.animationPreset = constrain((int)(doc["animationPreset"] | 0), 0, 19);
  frame.soundPreset = constrain((int)(doc["soundPreset"] | 0), 0, 19);
  frame.audioEnabled = (bool)(doc["audioEnabled"] | true) ? 1 : 0;
  frame.brightness = constrain((int)(doc["brightness"] | 100), 1, 100);
  frame.buzzerVolume = constrain((int)(doc["buzzerVolume"] | 100), 0, 100);
  strncpy(frame.lampId, lampId, sizeof(frame.lampId) - 1);
  if (routes[idx].transport == DeviceTransport::LORA) {
    char line[LORA_LINE_MAX];
    snprintf(line, sizeof(line),
             "LAMP_TEST,%s,%lu,%u,%u,%u,%u,%u,%u,%u,%u",
             lampId, (unsigned long)frame.commandSeq, frame.testState, frame.durationMs,
             frame.colorPreset, frame.animationPreset, frame.soundPreset,
             frame.audioEnabled, frame.brightness, frame.buzzerVolume);
    lora.sendLine(routes[idx].loraAddr, line);
    return;
  }
  esp_now_send(routes[idx].mac, (const uint8_t*)&frame, sizeof(frame));
}

void onEspNowSent(const uint8_t* mac_addr, esp_now_send_status_t status) {
  (void)mac_addr;
  (void)status;
}

uint8_t parseAckResult(const char* r) {
  if (!r) return 0;
  if (strcmp(r, "ok") == 0) return 1;
  if (strcmp(r, "duplicate") == 0) return 2;
  return 0;
}

bool hasJsonKey(const JsonVariantConst& obj, const char* key) {
  return !obj[key].isNull();
}

const char* firstStringByKeys(const JsonVariantConst& obj, const char* k1, const char* k2 = nullptr) {
  const char* v1 = obj[k1] | "";
  if (v1 && v1[0] != '\0') return v1;
  if (k2) {
    const char* v2 = obj[k2] | "";
    if (v2 && v2[0] != '\0') return v2;
  }
  return "";
}

void handleAckFromLocal(JsonDocument& doc) {
  const char* deviceId = doc["deviceId"] | "";
  uint32_t seq = doc["seq"] | 0;
  const char* result = doc["result"] | "invalid";
  uint8_t callActive = doc["callActive"] | (uint8_t)0;
  const char* callType = doc["callType"] | "normal";
  uint32_t callStartedAtS = doc["callStartedAtS"] | (uint32_t)0;
  uint16_t callCons = doc["callCons"] | (uint16_t)0;

  int idx = findRouteById(deviceId);
  if (idx < 0) {
    #if ENABLE_SERIAL_DEBUG
    Serial.print("DEBUG ack route missing deviceId=");
    Serial.println(deviceId);
    #endif
    return;
  }

  EspNowAckFrame ack = {};
  ack.msgType = ESPNOW_MSG_ACK;
  ack.seq = seq;
  ack.result = parseAckResult(result);
  ack.epochS = currentEpochS();
  ack.callActive = callActive;
  ack.callType = (strcmp(callType, "emergency") == 0) ? 1 : 0;
  ack.callStartedAtS = callStartedAtS;
  ack.callCons = callCons;
  ack.callStartSeq = doc["callStartSeq"] | (uint32_t)0;
  strncpy(ack.deviceId, deviceId, sizeof(ack.deviceId) - 1);
  ack.deviceId[12] = '\0';

  if (routes[idx].transport == DeviceTransport::LORA) {
    char line[LORA_LINE_MAX];
    snprintf(line, sizeof(line),
             "ACK,%s,%lu,%u,%u,%u,%lu,%u,%lu,%lu",
             deviceId, (unsigned long)seq, ack.result, callActive, ack.callType,
             (unsigned long)callStartedAtS, callCons,
             (unsigned long)ack.callStartSeq,
             (unsigned long)currentEpochS());
    lora.sendLine(routes[idx].loraAddr, line);
    return;
  }

  esp_now_send(routes[idx].mac, (const uint8_t*)&ack, sizeof(ack));
  #if ENABLE_SERIAL_DEBUG
  Serial.printf("DEBUG ack-tx deviceId=%s seq=%lu result=%s -> %s\n", deviceId, (unsigned long)seq, result, macToString(routes[idx].mac).c_str());
  #endif
}

void handleConfigFromLocal(JsonDocument& doc) {
  const char* deviceId = doc["deviceId"] | "";
  int idx = findRouteById(deviceId);
  if (idx < 0) {
    #if ENABLE_SERIAL_DEBUG
    Serial.print("DEBUG config route missing deviceId=");
    Serial.println(deviceId);
    #endif
    return;
  }

  JsonVariantConst cfg = doc["config"];
  if (!cfg.is<JsonObjectConst>()) {
    #if ENABLE_SERIAL_DEBUG
    Serial.print("DEBUG config inválida para deviceId=");
    Serial.println(deviceId);
    #endif
    return;
  }

  EspNowConfigFrame frame = {};
  frame.msgType = ESPNOW_MSG_CONFIG;
  frame.seq = doc["seq"] | (uint32_t)millis();
  strncpy(frame.deviceId, deviceId, sizeof(frame.deviceId) - 1);
  frame.deviceId[12] = '\0';

  const char* ssid = firstStringByKeys(cfg, "ssid", "wifiSsid");
  const char* password = firstStringByKeys(cfg, "password", "wifiPassword");

  bool hasUseStatic = hasJsonKey(cfg, "useStaticIP") || hasJsonKey(cfg, "useStaticIp");
  bool hasIp = hasJsonKey(cfg, "ip") || hasJsonKey(cfg, "staticIP");
  bool hasGw = hasJsonKey(cfg, "gateway") || hasJsonKey(cfg, "staticGateway");
  bool hasSubnet = hasJsonKey(cfg, "subnet") || hasJsonKey(cfg, "staticSubnet");
  bool hasDns1 = hasJsonKey(cfg, "dns1") || hasJsonKey(cfg, "staticDNS1");
  bool hasDns2 = hasJsonKey(cfg, "dns2") || hasJsonKey(cfg, "staticDNS2");

  bool wifiProvided =
      (ssid && ssid[0] != '\0') ||
      (password && password[0] != '\0') ||
      hasUseStatic || hasIp || hasGw || hasSubnet || hasDns1 || hasDns2;

  frame.applyWiFi = wifiProvided ? 1 : 0;
  bool useStatic = hasJsonKey(cfg, "useStaticIP") ? (bool)(cfg["useStaticIP"] | false) : (bool)(cfg["useStaticIp"] | false);
  frame.useStaticIP = useStatic ? 1 : 0;

  snprintf(frame.ssid, sizeof(frame.ssid), "%s", ssid);
  snprintf(frame.password, sizeof(frame.password), "%s", password);
  snprintf(frame.ip, sizeof(frame.ip), "%s", firstStringByKeys(cfg, "ip", "staticIP"));
  snprintf(frame.gateway, sizeof(frame.gateway), "%s", firstStringByKeys(cfg, "gateway", "staticGateway"));
  snprintf(frame.subnet, sizeof(frame.subnet), "%s", firstStringByKeys(cfg, "subnet", "staticSubnet"));
  snprintf(frame.dns1, sizeof(frame.dns1), "%s", firstStringByKeys(cfg, "dns1", "staticDNS1"));
  snprintf(frame.dns2, sizeof(frame.dns2), "%s", firstStringByKeys(cfg, "dns2", "staticDNS2"));

  bool hasBrightness = hasJsonKey(cfg, "brightness") || hasJsonKey(cfg, "brightnessLevel");
  int brightness = cfg["brightness"] | cfg["brightnessLevel"] | 0;
  frame.applyBrightness = hasBrightness ? 1 : 0;
  frame.brightness = (uint8_t)constrain(brightness, 0, 100);

  bool hasAudio = hasJsonKey(cfg, "audioAlert") || hasJsonKey(cfg, "connectionAudioAlertEnabled");
  bool audio = hasJsonKey(cfg, "audioAlert") ? (bool)(cfg["audioAlert"] | false) : (bool)(cfg["connectionAudioAlertEnabled"] | false);
  frame.applyAudioAlert = hasAudio ? 1 : 0;
  frame.audioAlertEnabled = audio ? 1 : 0;

  bool hasName = hasJsonKey(cfg, "name");
  const char* nameStr = cfg["name"] | "";
  frame.applyName = (hasName && nameStr[0] != '\0') ? 1 : 0;
  snprintf(frame.name, sizeof(frame.name), "%s", nameStr);
  frame.endCall = (bool)(cfg["endCall"] | false) ? 1 : 0;
  frame.targetCallSeq = cfg["targetCallSeq"] | (uint32_t)0;

  if (routes[idx].transport == DeviceTransport::LORA) {
    char line[LORA_LINE_MAX];
    snprintf(line, sizeof(line),
             "CFG,%s,%lu,%u,%u,%u,%u,%u,%s,%u,%lu",
             deviceId, (unsigned long)frame.seq, frame.applyBrightness, frame.brightness,
             frame.applyAudioAlert, frame.audioAlertEnabled, frame.applyName, frame.name,
             frame.endCall, (unsigned long)frame.targetCallSeq);
    lora.sendLine(routes[idx].loraAddr, line);
    return;
  }

  esp_now_send(routes[idx].mac, (const uint8_t*)&frame, sizeof(frame));

  #if ENABLE_SERIAL_DEBUG
  Serial.print("DEBUG config sent to deviceId=");
  Serial.println(deviceId);
  #endif
}

void processSerialLine(const String& line) {
  StaticJsonDocument<384> doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    #if ENABLE_SERIAL_DEBUG
    Serial.print("DEBUG bad json from local: ");
    Serial.println(line);
    #endif
    return;
  }

  const char* msgType = doc["msgType"] | "";
  if (strcmp(msgType, "ack") == 0) {
    handleAckFromLocal(doc);
    return;
  }

  if (strcmp(msgType, "config_update") == 0) {
    handleConfigFromLocal(doc);
    return;
  }

  if (strcmp(msgType, "lamp_state") == 0) {
    handleLampStateFromLocal(doc);
    return;
  }

  if (strcmp(msgType, "lamp_test") == 0) {
    handleLampTestFromLocal(doc);
    return;
  }

  if (strcmp(msgType, "time_sync") == 0) {
    uint32_t epochS = doc["epochS"] | 0;
    if (epochS > 0) {
      epochBaseS  = epochS;
      epochSyncMs = (uint32_t)millis();
      timeSynced  = true;
      #if LORA_ENABLED
      {
        char line[32];
        snprintf(line, sizeof(line), "TIME,%lu", (unsigned long)epochS);
        for (int i = 0; i < MAX_KNOWN_DEVICES; i++) {
          if (routes[i].used && routes[i].transport == DeviceTransport::LORA) {
            lora.sendLine(routes[i].loraAddr, line);
          }
        }
      }
      #endif
      #if ENABLE_SERIAL_DEBUG
      Serial.print("DEBUG time_sync epochS=");
      Serial.println(epochS);
      #endif
    }
    return;
  }
}

#if LORA_ENABLED
void handleLoraRegister(char* tokens[], int n, uint16_t srcAddr) {
  if (n < 2) return;
  uint32_t seq = (n >= 3) ? (uint32_t)strtoul(tokens[2], nullptr, 10) : 0;
  upsertLoraRoute(tokens[1], srcAddr);
  EspNowRegisterFrame reg = {};
  reg.msgType = ESPNOW_MSG_REGISTER;
  reg.seq = seq;
  reg.sentAtMs = millis();
  snprintf(reg.deviceId, sizeof(reg.deviceId), "%s", tokens[1]);
  uint8_t synth[6];
  loraSynthMac(srcAddr, synth);
  emitRegisterJson(reg, synth, "lora");
}

void handleLoraCall(char* tokens[], int n, uint16_t srcAddr, uint8_t msgType) {
  if (n < 2) return;
  EspNowCallFrame frame = {};
  frame.msgType = msgType;
  frame.seq = (n >= 3) ? (uint32_t)strtoul(tokens[2], nullptr, 10) : 0;
  frame.sentAtMs = millis();
  frame.cons = (n >= 4) ? (uint16_t)strtoul(tokens[3], nullptr, 10) : 0;
  frame.isEmergency = (n >= 5 && strcmp(tokens[4], "1") == 0) ? 1 : 0;
  snprintf(frame.deviceId, sizeof(frame.deviceId), "%s", tokens[1]);
  upsertLoraRoute(frame.deviceId, srcAddr);
  uint8_t synth[6];
  loraSynthMac(srcAddr, synth);
  emitUplinkJson(frame, synth, "lora");
}

void handleLoraHeartbeat(char* tokens[], int n, uint16_t srcAddr) {
  if (n < 2) return;
  upsertLoraRoute(tokens[1], srcAddr);
  StaticJsonDocument<192> doc;
  doc["msgType"] = "heartbeat";
  doc["deviceId"] = tokens[1];
  doc["seq"] = (n >= 3) ? (uint32_t)strtoul(tokens[2], nullptr, 10) : 0;
  doc["sentAtMs"] = millis();
  uint8_t synth[6];
  loraSynthMac(srcAddr, synth);
  doc["srcMac"] = macToString(synth);
  doc["source"] = "lora";
  String out;
  serializeJson(doc, out);
  Serial.println(out);
}

void handleLoraConfigAck(char* tokens[], int n, uint16_t srcAddr) {
  if (n < 3) return;
  upsertLoraRoute(tokens[1], srcAddr);
  StaticJsonDocument<192> doc;
  doc["msgType"] = "config_ack";
  doc["deviceId"] = tokens[1];
  doc["seq"] = (uint32_t)strtoul(tokens[2], nullptr, 10);
  doc["sentAtMs"] = millis();
  doc["configResult"] = (n >= 4 && strcmp(tokens[3], "1") == 0) ? 1 : 0;
  uint8_t synth[6];
  loraSynthMac(srcAddr, synth);
  doc["srcMac"] = macToString(synth);
  doc["source"] = "lora";
  String out;
  serializeJson(doc, out);
  Serial.println(out);
}

void handleLoraLampRegister(char* tokens[], int n, uint16_t srcAddr) {
  if (n < 7) return;
  upsertLoraRoute(tokens[1], srcAddr);
  StaticJsonDocument<320> doc;
  doc["msgType"] = "lamp_register";
  doc["lampId"] = tokens[1];
  doc["seq"] = (uint32_t)strtoul(tokens[2], nullptr, 10);
  doc["sentAtMs"] = (uint32_t)strtoul(tokens[3], nullptr, 10);
  doc["deviceType"] = tokens[4];
  doc["relayCapable"] = strcmp(tokens[5], "1") == 0;
  doc["protocolVersion"] = (uint8_t)atoi(tokens[6]);
  uint8_t synth[6];
  loraSynthMac(srcAddr, synth);
  doc["srcMac"] = macToString(synth);
  doc["source"] = "lora";
  String out;
  serializeJson(doc, out);
  Serial.println(out);
}

void handleLoraLampHeartbeat(char* tokens[], int n, uint16_t srcAddr) {
  if (n < 8) return;
  upsertLoraRoute(tokens[1], srcAddr);
  StaticJsonDocument<320> doc;
  doc["msgType"] = "lamp_heartbeat";
  doc["lampId"] = tokens[1];
  doc["seq"] = (uint32_t)strtoul(tokens[2], nullptr, 10);
  doc["sentAtMs"] = (uint32_t)strtoul(tokens[3], nullptr, 10);
  doc["appliedRevision"] = (uint64_t)strtoull(tokens[4], nullptr, 10);
  doc["appliedState"] = (uint8_t)atoi(tokens[5]);
  doc["relayCapable"] = strcmp(tokens[6], "1") == 0;
  doc["gatewayRssi"] = (int8_t)atoi(tokens[7]);
  uint8_t synth[6];
  loraSynthMac(srcAddr, synth);
  doc["srcMac"] = macToString(synth);
  doc["source"] = "lora";
  String out;
  serializeJson(doc, out);
  Serial.println(out);
}

void handleLoraLampSnapshot(char* tokens[], int n, uint16_t srcAddr) {
  if (n < 4) return;
  upsertLoraRoute(tokens[1], srcAddr);
  StaticJsonDocument<320> doc;
  doc["msgType"] = "lamp_snapshot_request";
  doc["lampId"] = tokens[1];
  doc["seq"] = (uint32_t)strtoul(tokens[2], nullptr, 10);
  doc["appliedRevision"] = (uint64_t)strtoull(tokens[3], nullptr, 10);
  uint8_t synth[6];
  loraSynthMac(srcAddr, synth);
  doc["srcMac"] = macToString(synth);
  doc["source"] = "lora";
  String out;
  serializeJson(doc, out);
  Serial.println(out);
}

void handleLoraLampAck(char* tokens[], int n, uint16_t srcAddr, bool isTest) {
  if (n < 6) return;
  upsertLoraRoute(tokens[1], srcAddr);
  StaticJsonDocument<320> doc;
  doc["msgType"] = isTest ? "lamp_test_ack" : "lamp_state_ack";
  doc["lampId"] = tokens[1];
  doc["commandSeq"] = (uint32_t)strtoul(tokens[2], nullptr, 10);
  doc["stateRevision"] = (uint64_t)strtoull(tokens[3], nullptr, 10);
  doc["appliedState"] = (uint8_t)atoi(tokens[4]);
  doc["result"] = (uint8_t)atoi(tokens[5]);
  uint8_t synth[6];
  loraSynthMac(srcAddr, synth);
  doc["srcMac"] = macToString(synth);
  doc["source"] = "lora";
  String out;
  serializeJson(doc, out);
  Serial.println(out);
}

void processLoraLine(const char* raw) {
  if (strncmp(raw, "+RCV=", 5) != 0) return; // lineas de estado del modulo

  char payload[LORA_LINE_MAX];
  uint16_t srcAddr = 0;
  if (!lora.parseRcv(raw, payload, sizeof(payload), &srcAddr)) return;

  char* tokens[16];
  int n = loraSplitTokens(payload, tokens, 16);
  if (n < 1) return;
  const char* type = tokens[0];

  if (strcmp(type, "REG") == 0) { handleLoraRegister(tokens, n, srcAddr); return; }
  if (strcmp(type, "CS") == 0) { handleLoraCall(tokens, n, srcAddr, ESPNOW_MSG_CALL_START); return; }
  if (strcmp(type, "CI") == 0) { handleLoraCall(tokens, n, srcAddr, ESPNOW_MSG_CALL_INSIST); return; }
  if (strcmp(type, "CE") == 0) { handleLoraCall(tokens, n, srcAddr, ESPNOW_MSG_CALL_END); return; }
  if (strcmp(type, "HB") == 0) { handleLoraHeartbeat(tokens, n, srcAddr); return; }
  if (strcmp(type, "CACK") == 0) { handleLoraConfigAck(tokens, n, srcAddr); return; }
  if (strcmp(type, "LAMP_REG") == 0) { handleLoraLampRegister(tokens, n, srcAddr); return; }
  if (strcmp(type, "LAMP_HB") == 0) { handleLoraLampHeartbeat(tokens, n, srcAddr); return; }
  if (strcmp(type, "LAMP_SNAP") == 0) { handleLoraLampSnapshot(tokens, n, srcAddr); return; }
  if (strcmp(type, "LAMP_ACK") == 0) { handleLoraLampAck(tokens, n, srcAddr, false); return; }
  if (strcmp(type, "TEST_ACK") == 0) { handleLoraLampAck(tokens, n, srcAddr, true); return; }
}
#endif

void setup() {
  Serial.setRxBufferSize(2048); // margen ante rafagas de lamp_state/config_update (ver bug JSON concatenado)
  Serial.begin(SERIAL_BAUD_RATE);
  delay(200);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR); // Long Range: ~4x mayor alcance
  if (esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
    Serial.println("ESP-NOW channel setup failed");
    while (true) delay(1000);
  }
  esp_wifi_set_max_tx_power(84); // 84 = 21dBm, maximo permitido en la mayoria de regiones

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
    while (true) {
      delay(1000);
    }
  }

  eventRxQueue = xQueueCreate(ESPNOW_EVENT_QUEUE_SIZE, sizeof(EspNowRxItem));
  heartbeatRxQueue = xQueueCreate(ESPNOW_HEARTBEAT_QUEUE_SIZE, sizeof(EspNowRxItem));
  if (!eventRxQueue || !heartbeatRxQueue) {
    Serial.println("ESP-NOW RX queue allocation failed");
    while (true) delay(1000);
  }

  esp_now_register_recv_cb(onEspNowRecv);
  esp_now_register_send_cb(onEspNowSent);

  memset(routes, 0, sizeof(routes));
  memset(dedupCache, 0, sizeof(dedupCache));
  serialLine.reserve(512);

  #if LORA_ENABLED
  loraCfg.rxPin = LORA_RX_PIN;
  loraCfg.txPin = LORA_TX_PIN;
  loraCfg.baud = LORA_UART_BAUD;
  loraCfg.address = LORA_GATEWAY_ADDRESS;
  loraCfg.frequencyHz = LORA_FREQ_HZ;
  loraCfg.sf = LORA_SF;
  loraCfg.bw = LORA_BW;
  loraCfg.cr = LORA_CR;
  loraCfg.preamble = LORA_PREAMBLE;
  loraCfg.crc = LORA_CRC;
  loraCfg.txPowerDbm = LORA_TX_POWER_DBM;
  lora.begin(LoraSerial, loraCfg);
  if (lora.configure()) {
    Serial.println("LoRa ready");
  } else {
    Serial.println("LoRa configure FAILED (check wiring/baud)");
  }
  #endif

  Serial.println("gateway ready");
}

void loop() {
  EspNowRxItem rxItem = {};
  // Vaciar primero todos los eventos clinicos; procesar como maximo cuatro
  // heartbeats por ciclo para conservar baja latencia en el puerto serial.
  while (xQueueReceive(eventRxQueue, &rxItem, 0) == pdTRUE) {
    processEspNowRxItem(rxItem);
  }
  for (int i = 0; i < 4 && xQueueReceive(heartbeatRxQueue, &rxItem, 0) == pdTRUE; i++) {
    processEspNowRxItem(rxItem);
  }

  static uint32_t lastDropReportMs = 0;
  if (millis() - lastDropReportMs >= 5000) {
    int knownRoutes = 0;
    for (int i = 0; i < MAX_KNOWN_DEVICES; i++) if (routes[i].used) knownRoutes++;
    Serial.printf("DEBUG status uptimeS=%lu routes=%d dropsEvent=%u dropsHeartbeat=%u dropsUnknown=%u heap=%lu\n",
                  (unsigned long)(millis() / 1000), knownRoutes, droppedEventFrames, droppedHeartbeatFrames,
                  droppedUnknownFrames, (unsigned long)ESP.getFreeHeap());
    lastDropReportMs = millis();
  }

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      String line = serialLine;
      serialLine = "";
      line.trim();
      if (line.length() > 0) processSerialLine(line);
    } else {
      if (serialLine.length() < 500) serialLine += c;
    }
  }

  #if LORA_ENABLED
  while (LoraSerial.available() > 0) {
    char c = (char)LoraSerial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (loraLine.length() > 0) {
        processLoraLine(loraLine.c_str());
        loraLine = "";
      }
    } else {
      if (loraLine.length() < LORA_LINE_MAX + 24) loraLine += c;
    }
  }
  #endif

  delay(2);
}

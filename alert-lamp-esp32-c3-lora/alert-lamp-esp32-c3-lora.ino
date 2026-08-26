#include <Adafruit_NeoPixel.h>
#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include "espnow_frames.h"
#include "iot_config.h"

#if USE_LORA_TRANSPORT
#include "lora_transport.h"
HardwareSerial& LoraSerial = Serial0;
LoraTransport lora;
LoraConfig loraCfg;
String loraLine;
#endif

static const uint8_t BROADCAST_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
static const uint32_t SEQ_RESERVATION_SIZE = 10000;
static const size_t MAX_FRAME_SIZE = 250;

struct RxItem { uint8_t srcMac[6]; int8_t rssi; uint8_t len; uint8_t data[MAX_FRAME_SIZE]; };
struct ReverseRoute { bool used; char deviceId[13]; uint8_t previousHop[6]; uint32_t lastSeenMs; };
struct DedupEntry { bool used; char deviceId[13]; uint32_t seq; uint32_t seenAtMs; };
struct __attribute__((packed)) EspNowRegisterFrame { uint8_t msgType; uint32_t seq; uint32_t sentAtMs; char deviceId[13]; };

Adafruit_NeoPixel ring(WS2812_LED_COUNT, WS2812_PIN, NEO_GRB + NEO_KHZ800);
Preferences preferences;
QueueHandle_t rxQueue = nullptr;
ReverseRoute reverseRoutes[ESPNOW_REVERSE_ROUTE_SIZE] = {};
DedupEntry dedupEntries[ESPNOW_DEDUP_SIZE] = {};

uint8_t gatewayMac[6] = {};
uint8_t ownMac[6] = {};
char lampId[13] = {};
LampEffectiveState authoritativeState = LAMP_STATE_OFF;
LampEffectiveState outputState = LAMP_STATE_OFF;
uint64_t appliedRevision = 0;
uint32_t sequenceCounter = 0;
uint32_t sequenceReservedUntil = 0;
uint32_t lastRegisterMs = 0;
uint32_t lastHeartbeatMs = 0;
uint32_t lastSnapshotRequestMs = 0;
uint32_t lastGatewayContactMs = 0;
uint32_t testEndsAtMs = 0;
uint8_t colorPreset = 0;
uint8_t animationPreset = 0;
uint8_t soundPreset = 0;
uint8_t brightness = 100;
uint8_t buzzerVolume = 100;
bool audioEnabled = true;
uint8_t savedColorPreset = 0, savedAnimationPreset = 0, savedSoundPreset = 0, savedBrightness = 100, savedBuzzerVolume = 100;
bool savedAudioEnabled = true; // valores reales respaldados mientras un LAMP_TEST los sobreescribe
bool gatewayRegistered = false;
bool hasAuthoritativeSnapshot = false;
bool testActive = false;
bool espNowReady = false;
bool buzzerActive = false; // buzzer activo: solo encendido/apagado, sin PWM de tono
int8_t lastGatewayRssi = -127;
uint32_t lastStatusPrintMs = 0;
bool wasGatewayRegistered = false;

const char* stateLabel(LampEffectiveState state) {
  if (state == LAMP_STATE_EMERGENCY) return "EMERGENCY";
  if (state == LAMP_STATE_NORMAL) return "NORMAL";
  return "OFF";
}

const uint8_t COLOR_PRESETS[20][3] = {
  {255, 0, 0}, {255, 70, 0}, {255, 150, 0}, {255, 220, 0}, {140, 255, 0},
  {0, 255, 40}, {0, 255, 140}, {0, 255, 220}, {0, 180, 255}, {0, 100, 255},
  {0, 40, 255}, {70, 0, 255}, {140, 0, 255}, {210, 0, 255}, {255, 0, 220},
  {255, 0, 130}, {255, 0, 60}, {225, 235, 245}, {225, 235, 245}, {255, 190, 40}
};

bool parseMac(const char* text, uint8_t mac[6]) {
  unsigned int values[6];
  if (sscanf(text, "%x:%x:%x:%x:%x:%x", &values[0], &values[1], &values[2], &values[3], &values[4], &values[5]) != 6) return false;
  for (int index = 0; index < 6; index++) mac[index] = (uint8_t)values[index];
  return true;
}

void addPeerIfNeeded(const uint8_t mac[6]) {
  if (esp_now_is_peer_exist(mac)) return;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  peer.channel = ESPNOW_CHANNEL;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
}

void reserveSequenceRange(uint32_t floor) {
  uint32_t until = floor + SEQ_RESERVATION_SIZE;
  if (until < floor) until = UINT32_MAX;
  preferences.begin("lamp", false);
  preferences.putUInt("seqNext", until);
  preferences.end();
  sequenceReservedUntil = until;
}

uint32_t nextSequence() {
  if (sequenceReservedUntil == 0 || sequenceCounter + 1 >= sequenceReservedUntil) reserveSequenceRange(sequenceCounter);
  return ++sequenceCounter;
}

uint32_t presetColor(uint8_t preset, uint8_t scale = 255) {
  const uint8_t* rgb = COLOR_PRESETS[preset % 20];
  return ring.Color((uint16_t)rgb[0] * scale / 255, (uint16_t)rgb[1] * scale / 255, (uint16_t)rgb[2] * scale / 255);
}

void setAll(uint32_t color) {
  for (uint16_t led = 0; led < WS2812_LED_COUNT; led++) ring.setPixelColor(led, color);
}

void renderAnimation() {
  if (outputState == LAMP_STATE_OFF) {
    ring.clear();
    ring.show();
    return;
  }

  uint32_t now = millis();
  uint8_t pattern = animationPreset % 20;
  uint16_t step = (now / (outputState == LAMP_STATE_EMERGENCY ? 55 : 90));
  uint8_t pulse = (uint8_t)(abs((int)(now / 5 % 510) - 255));
  ring.clear();

  if (pattern == 0) setAll(presetColor(colorPreset));
  else if (pattern == 1) setAll((step % 8) < 4 ? presetColor(colorPreset) : 0);
  else if (pattern == 2) setAll(presetColor(colorPreset, pulse));
  else if (pattern == 3 || pattern == 17) {
    uint16_t head = pattern == 3 ? step % WS2812_LED_COUNT : (WS2812_LED_COUNT - 1 - step % WS2812_LED_COUNT);
    for (uint8_t tail = 0; tail < 6; tail++) ring.setPixelColor((head + WS2812_LED_COUNT - tail) % WS2812_LED_COUNT, presetColor(colorPreset, 255 - tail * 38));
  } else if (pattern == 4) setAll((now % 500 < 70 || (now % 500 > 140 && now % 500 < 210)) ? presetColor(colorPreset) : 0);
  else if (pattern == 5) {
    uint16_t count = step % (WS2812_LED_COUNT + 1);
    for (uint16_t led = 0; led < count; led++) ring.setPixelColor(led, presetColor(colorPreset));
  } else if (pattern == 16) {
    // Sirena tipo ambulancia: mitades rojo/azul alternando, ignora colorPreset a proposito.
    uint16_t half = WS2812_LED_COUNT / 2;
    bool swapHalves = (now / 150) % 2 == 0;
    for (uint16_t led = 0; led < WS2812_LED_COUNT; led++) {
      bool firstHalf = led < half;
      bool redHalf = swapHalves ? firstHalf : !firstHalf;
      ring.setPixelColor(led, redHalf ? ring.Color(255, 0, 0) : ring.Color(0, 0, 255));
    }
  } else if (pattern == 6) {
    uint16_t head = step % WS2812_LED_COUNT;
    for (uint8_t tail = 0; tail < 10; tail++) ring.setPixelColor((head + WS2812_LED_COUNT - tail) % WS2812_LED_COUNT, presetColor(colorPreset, 255 - tail * 24));
  } else if (pattern == 7) {
    for (uint16_t led = 0; led < WS2812_LED_COUNT; led++) if ((led + step / 4) % 2 == 0) ring.setPixelColor(led, presetColor(colorPreset));
  } else if (pattern == 8 || pattern == 15) {
    for (uint8_t dot = 0; dot < 5; dot++) ring.setPixelColor((step * (dot + 3) + dot * 7) % WS2812_LED_COUNT, presetColor((colorPreset + dot) % 20));
  } else if (pattern == 9) {
    uint16_t span = WS2812_LED_COUNT * 2 - 2;
    uint16_t pos = step % span;
    if (pos >= WS2812_LED_COUNT) pos = span - pos;
    ring.setPixelColor(pos, presetColor(colorPreset));
  } else if (pattern == 10) {
    for (uint16_t led = 0; led < WS2812_LED_COUNT / 2; led++) ring.setPixelColor((led + (step / 4 % 2) * (WS2812_LED_COUNT / 2)) % WS2812_LED_COUNT, presetColor(colorPreset, pulse));
  } else if (pattern == 11 || pattern == 12) {
    uint8_t spacing = pattern == 11 ? 6 : 12;
    for (uint16_t led = step % spacing; led < WS2812_LED_COUNT; led += spacing) ring.setPixelColor(led, presetColor(colorPreset));
  } else if (pattern == 13) {
    for (uint16_t led = 0; led < WS2812_LED_COUNT; led++) ring.setPixelColor(led, presetColor(colorPreset, (sin((led + step) * 0.55f) + 1.0f) * 127));
  } else if (pattern == 14 || pattern == 18) {
    uint16_t phase = now % (pattern == 14 ? 1100 : 800);
    bool on = phase < 90 || (phase > 180 && phase < 290);
    setAll(on ? presetColor(colorPreset) : 0);
  } else {
    for (uint16_t led = 0; led < WS2812_LED_COUNT; led++) ring.setPixelColor(led, presetColor((colorPreset + led + step / 3) % 20));
  }
#if ENABLE_SERIAL_DEBUG
  static uint32_t lastRenderLogMs = 0;
  if (now - lastRenderLogMs >= 1000) {
    lastRenderLogMs = now;
    uint32_t c0 = ring.getPixelColor(0);
    Serial.printf("[RENDER] pattern=%u pixel0=R%uG%uB%u libBrightness=%u\n", pattern,
                  (c0 >> 16) & 0xFF, (c0 >> 8) & 0xFF, c0 & 0xFF, ring.getBrightness());
  }
#endif
  ring.show();
}

void renderSound() {
  if (outputState == LAMP_STATE_OFF || !audioEnabled) {
    if (buzzerActive) {
      ledcWrite(BUZZER_PIN, 0); buzzerActive = false;
#if ENABLE_SERIAL_DEBUG
      Serial.printf("[SOUND] t=%lu buzzer OFF (salida=%s audio=%d)\n", millis(), stateLabel(outputState), audioEnabled);
#endif
    }
    return;
  }
  uint8_t pattern = soundPreset % 20;
  uint32_t cycle = 500 + (pattern % 5) * 140;
  uint32_t phase = millis() % cycle;
  uint8_t pulses = 1 + pattern % 4;
  uint32_t slot = cycle / (pulses * 2 + 1);
  bool on = (phase / slot) < pulses * 2 && ((phase / slot) % 2 == 0);
  if (on == buzzerActive) return;
  buzzerActive = on;
  uint8_t duty = on ? (uint8_t)((uint16_t)buzzerVolume * 255 / 100) : 0;
  ledcWrite(BUZZER_PIN, duty);
#if ENABLE_SERIAL_DEBUG
  Serial.printf("[SOUND] t=%lu buzzer %s vol=%u%% (salida=%s sonido=%u)\n", millis(), on ? "ON" : "OFF", buzzerVolume, stateLabel(outputState), soundPreset);
#endif
}

void applyOutputState(LampEffectiveState state) {
  outputState = state;
  if (state == LAMP_STATE_OFF) { ring.clear(); ring.show(); ledcWrite(BUZZER_PIN, 0); buzzerActive = false; }
}

bool isDuplicate(const char* deviceId, uint32_t seq) {
  uint32_t now = millis();
  for (int index = 0; index < ESPNOW_DEDUP_SIZE; index++) {
    if (!dedupEntries[index].used) continue;
    if (now - dedupEntries[index].seenAtMs > 30000) { dedupEntries[index].used = false; continue; }
    if (dedupEntries[index].seq == seq && strncmp(dedupEntries[index].deviceId, deviceId, 12) == 0) return true;
  }
  return false;
}

void markSeen(const char* deviceId, uint32_t seq) {
  int slot = 0; uint32_t oldest = UINT32_MAX;
  for (int index = 0; index < ESPNOW_DEDUP_SIZE; index++) {
    if (!dedupEntries[index].used) { slot = index; break; }
    if (dedupEntries[index].seenAtMs < oldest) { oldest = dedupEntries[index].seenAtMs; slot = index; }
  }
  dedupEntries[slot].used = true; dedupEntries[slot].seq = seq; dedupEntries[slot].seenAtMs = millis();
  snprintf(dedupEntries[slot].deviceId, sizeof(dedupEntries[slot].deviceId), "%s", deviceId);
}

void rememberReverseRoute(const char* deviceId, const uint8_t previousHop[6]) {
  int slot = -1; uint32_t oldest = UINT32_MAX;
  for (int index = 0; index < ESPNOW_REVERSE_ROUTE_SIZE; index++) {
    if (reverseRoutes[index].used && strncmp(reverseRoutes[index].deviceId, deviceId, 12) == 0) { slot = index; break; }
    if (!reverseRoutes[index].used && slot < 0) slot = index;
    if (slot < 0 && reverseRoutes[index].lastSeenMs < oldest) { oldest = reverseRoutes[index].lastSeenMs; slot = index; }
  }
  reverseRoutes[slot].used = true; reverseRoutes[slot].lastSeenMs = millis();
  snprintf(reverseRoutes[slot].deviceId, sizeof(reverseRoutes[slot].deviceId), "%s", deviceId);
  memcpy(reverseRoutes[slot].previousHop, previousHop, 6); addPeerIfNeeded(previousHop);
}

bool forwardToOrigin(const char* deviceId, const uint8_t* data, size_t len) {
  for (int index = 0; index < ESPNOW_REVERSE_ROUTE_SIZE; index++) {
    ReverseRoute& route = reverseRoutes[index];
    if (route.used && millis() - route.lastSeenMs < ESPNOW_ROUTE_STALE_MS && strncmp(route.deviceId, deviceId, 12) == 0) {
      addPeerIfNeeded(route.previousHop);
      return esp_now_send(route.previousHop, data, len) == ESP_OK;
    }
  }
  return false;
}

void sendLampStateAck(const LampStateFrame& frame, LampApplyResult result) {
  LampStateAckFrame ack = {};
  ack.msgType = ESPNOW_MSG_LAMP_STATE_ACK; ack.commandSeq = frame.commandSeq; ack.stateRevision = appliedRevision;
  ack.appliedState = authoritativeState; ack.result = result;
  snprintf(ack.lampId, sizeof(ack.lampId), "%s", lampId);
#if USE_LORA_TRANSPORT
  char line[LORA_LINE_MAX];
  snprintf(line, sizeof(line), "LAMP_ACK,%s,%lu,%llu,%u,%u",
           lampId, (unsigned long)ack.commandSeq, (unsigned long long)ack.stateRevision,
           ack.appliedState, ack.result);
  lora.sendLine(LORA_GATEWAY_ADDRESS, line);
#else
  esp_now_send(gatewayMac, reinterpret_cast<const uint8_t*>(&ack), sizeof(ack));
#endif
}

void processLampState(const LampStateFrame& frame, const uint8_t sourceMac[6]) {
  if (memcmp(sourceMac, gatewayMac, 6) != 0 || strncmp(frame.lampId, lampId, 12) != 0 || frame.effectiveState > LAMP_STATE_EMERGENCY) {
#if ENABLE_SERIAL_DEBUG
    Serial.printf("[LAMP_STATE] RECHAZADO origen/lampId/estado invalido lampId=%s effectiveState=%u\n", frame.lampId, frame.effectiveState);
#endif
    return;
  }
  lastGatewayContactMs = millis(); gatewayRegistered = true;
  if (frame.stateRevision < appliedRevision) {
#if ENABLE_SERIAL_DEBUG
    Serial.printf("[LAMP_STATE] revision antigua rev=%llu < aplicada=%llu -> ACK OLD_REVISION\n", (unsigned long long)frame.stateRevision, (unsigned long long)appliedRevision);
#endif
    sendLampStateAck(frame, LAMP_RESULT_OLD_REVISION); return;
  }
  if (frame.stateRevision == appliedRevision && hasAuthoritativeSnapshot) {
#if ENABLE_SERIAL_DEBUG
    Serial.printf("[LAMP_STATE] duplicado rev=%llu -> ACK DUPLICATE\n", (unsigned long long)frame.stateRevision);
#endif
    sendLampStateAck(frame, LAMP_RESULT_DUPLICATE); return;
  }
  authoritativeState = (LampEffectiveState)frame.effectiveState;
  appliedRevision = frame.stateRevision; colorPreset = frame.colorPreset % 20; animationPreset = frame.animationPreset % 20;
  soundPreset = frame.soundPreset % 20; audioEnabled = frame.audioEnabled != 0; brightness = constrain(frame.brightness, 1, 100);
  buzzerVolume = constrain(frame.buzzerVolume, 0, 100);
  ring.setBrightness((uint8_t)((uint16_t)brightness * 255 / 100));
  hasAuthoritativeSnapshot = true; testActive = false; applyOutputState(authoritativeState);
  preferences.begin("lamp", false); preferences.putULong64("revision", appliedRevision); preferences.end();
  sendLampStateAck(frame, LAMP_RESULT_APPLIED);
#if ENABLE_SERIAL_DEBUG
  Serial.printf("[LAMP_STATE] APLICADO rev=%llu estado=%s color=%u anim=%u sonido=%u audio=%d brillo=%u%%\n",
                (unsigned long long)appliedRevision, stateLabel(authoritativeState), colorPreset, animationPreset,
                soundPreset, audioEnabled, brightness);
#endif
}

void processLampTest(const LampTestFrame& frame, const uint8_t sourceMac[6]) {
  if (memcmp(sourceMac, gatewayMac, 6) != 0 || strncmp(frame.lampId, lampId, 12) != 0 || frame.testState > LAMP_STATE_EMERGENCY) return;
  if (!testActive) {
    // Respaldar el estado real solo al iniciar un test nuevo (no en cada reenvio del mismo test)
    savedColorPreset = colorPreset; savedAnimationPreset = animationPreset; savedSoundPreset = soundPreset;
    savedAudioEnabled = audioEnabled; savedBrightness = brightness; savedBuzzerVolume = buzzerVolume;
  }
  testActive = true; testEndsAtMs = millis() + constrain((uint32_t)frame.durationMs, (uint32_t)100, (uint32_t)30000);
  colorPreset = frame.colorPreset % 20; animationPreset = frame.animationPreset % 20; soundPreset = frame.soundPreset % 20;
  audioEnabled = frame.audioEnabled != 0; brightness = constrain(frame.brightness, 1, 100);
  buzzerVolume = constrain(frame.buzzerVolume, 0, 100);
  ring.setBrightness((uint8_t)((uint16_t)brightness * 255 / 100));
  applyOutputState((LampEffectiveState)frame.testState);
  LampStateAckFrame ack = {};
  ack.msgType = ESPNOW_MSG_LAMP_TEST_ACK; ack.commandSeq = frame.commandSeq; ack.stateRevision = appliedRevision;
  ack.appliedState = outputState; ack.result = LAMP_RESULT_APPLIED; snprintf(ack.lampId, sizeof(ack.lampId), "%s", lampId);
#if USE_LORA_TRANSPORT
  char line[LORA_LINE_MAX];
  snprintf(line, sizeof(line), "TEST_ACK,%s,%lu,%llu,%u,%u",
           lampId, (unsigned long)ack.commandSeq, (unsigned long long)ack.stateRevision,
           ack.appliedState, ack.result);
  lora.sendLine(LORA_GATEWAY_ADDRESS, line);
#else
  esp_now_send(gatewayMac, reinterpret_cast<const uint8_t*>(&ack), sizeof(ack));
#endif
#if ENABLE_SERIAL_DEBUG
  Serial.printf("[LAMP_TEST] estado=%s duracionMs=%u color=%u anim=%u sonido=%u\n", stateLabel((LampEffectiveState)frame.testState), frame.durationMs,
                colorPreset, animationPreset, soundPreset);
#endif
}

void processRelayRequest(const EspNowRelayReqFrame& request) {
  if (request.ttl == 0 || memcmp(request.origMac, ownMac, 6) == 0 || isDuplicate(request.deviceId, request.origSeq)) {
#if ENABLE_SERIAL_DEBUG
    Serial.printf("[RELAY] descartado deviceId=%s ttl=%u (ttl0/origenPropio/duplicado)\n", request.deviceId, request.ttl);
#endif
    return;
  }
  uint8_t embeddedType = request.embedded.msgType;
  if (!((embeddedType >= ESPNOW_MSG_CALL_START && embeddedType <= ESPNOW_MSG_HEARTBEAT) || embeddedType == ESPNOW_MSG_REGISTER)) return;
  rememberReverseRoute(request.deviceId, request.prevHopMac); markSeen(request.deviceId, request.origSeq);
  size_t frameSize = embeddedType == ESPNOW_MSG_REGISTER ? sizeof(EspNowRegisterFrame) : sizeof(EspNowCallFrame);
  bool sentOk = esp_now_send(gatewayMac, reinterpret_cast<const uint8_t*>(&request.embedded), frameSize) == ESP_OK;
#if ENABLE_SERIAL_DEBUG
  Serial.printf("[RELAY] deviceId=%s origSeq=%lu msgType=%u -> gateway %s\n", request.deviceId,
                (unsigned long)request.origSeq, embeddedType, sentOk ? "OK" : "FALLO");
#endif
  if (!sentOk) {
    EspNowRelayConfirmFrame nack = {};
    nack.msgType = ESPNOW_MSG_RELAY_CONFIRM; nack.origSeq = request.origSeq; nack.result = 0;
    snprintf(nack.deviceId, sizeof(nack.deviceId), "%s", request.deviceId);
    esp_now_send(request.prevHopMac, reinterpret_cast<const uint8_t*>(&nack), sizeof(nack));
  }
}

void processRxItem(const RxItem& item) {
  uint8_t msgType = item.data[0];
  if (msgType == ESPNOW_MSG_LAMP_STATE && item.len == sizeof(LampStateFrame)) {
    LampStateFrame frame = {}; memcpy(&frame, item.data, sizeof(frame)); frame.lampId[12] = '\0'; processLampState(frame, item.srcMac);
  } else if (msgType == ESPNOW_MSG_LAMP_TEST && item.len == sizeof(LampTestFrame)) {
    LampTestFrame frame = {}; memcpy(&frame, item.data, sizeof(frame)); frame.lampId[12] = '\0'; processLampTest(frame, item.srcMac);
  } else if (msgType == ESPNOW_MSG_RELAY_REQ && item.len == sizeof(EspNowRelayReqFrame)) {
    EspNowRelayReqFrame frame = {}; memcpy(&frame, item.data, sizeof(frame)); frame.deviceId[12] = '\0'; processRelayRequest(frame);
  } else if (msgType == ESPNOW_MSG_ACK && item.len == sizeof(EspNowAckFrame)) {
    EspNowAckFrame frame = {}; memcpy(&frame, item.data, sizeof(frame)); frame.deviceId[12] = '\0';
    if (strncmp(frame.deviceId, lampId, 12) == 0) { gatewayRegistered = frame.result == 1 || frame.result == 2; lastGatewayContactMs = millis(); }
    else forwardToOrigin(frame.deviceId, item.data, item.len);
  } else if (msgType == ESPNOW_MSG_CONFIG && item.len == sizeof(EspNowConfigFrame)) {
    EspNowConfigFrame frame = {}; memcpy(&frame, item.data, sizeof(frame)); frame.deviceId[12] = '\0';
    if (strncmp(frame.deviceId, lampId, 12) != 0) forwardToOrigin(frame.deviceId, item.data, item.len);
  }
}

void onEspNowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  if (!info || !data || len <= 0 || len > (int)MAX_FRAME_SIZE || !rxQueue) return;
  RxItem item = {}; memcpy(item.srcMac, info->src_addr, 6); item.rssi = info->rx_ctrl ? info->rx_ctrl->rssi : -127;
  item.len = (uint8_t)len; memcpy(item.data, data, len);
  if (memcmp(info->src_addr, gatewayMac, 6) == 0) lastGatewayRssi = item.rssi;
  xQueueSend(rxQueue, &item, 0);
}

void onEspNowSent(const wifi_tx_info_t* info, esp_now_send_status_t status) { (void)info; (void)status; }

void sendRegister() {
  LampRegisterFrame frame = {};
  frame.msgType = ESPNOW_MSG_LAMP_REGISTER; frame.seq = nextSequence(); frame.sentAtMs = millis(); frame.relayCapable = 1; frame.protocolVersion = 2;
  snprintf(frame.lampId, sizeof(frame.lampId), "%s", lampId); snprintf(frame.deviceType, sizeof(frame.deviceType), "%s", DEVICE_TYPE);
#if USE_LORA_TRANSPORT
  char line[LORA_LINE_MAX];
  snprintf(line, sizeof(line), "LAMP_REG,%s,%lu,%lu,%s,%u,%u",
           lampId, (unsigned long)frame.seq, (unsigned long)frame.sentAtMs,
           frame.deviceType, frame.relayCapable, frame.protocolVersion);
  lora.sendLine(LORA_GATEWAY_ADDRESS, line);
#else
  esp_now_send(gatewayMac, reinterpret_cast<const uint8_t*>(&frame), sizeof(frame));
#endif
  lastRegisterMs = millis();
#if ENABLE_SERIAL_DEBUG
  Serial.printf("[REGISTER] -> gateway seq=%lu lampId=%s\n", (unsigned long)frame.seq, lampId);
#endif
}

void sendHeartbeat() {
  LampHeartbeatFrame frame = {};
  frame.msgType = ESPNOW_MSG_LAMP_HEARTBEAT; frame.seq = nextSequence(); frame.sentAtMs = millis(); frame.appliedRevision = appliedRevision;
  frame.appliedState = authoritativeState; frame.relayCapable = 1; frame.gatewayRssi = lastGatewayRssi; snprintf(frame.lampId, sizeof(frame.lampId), "%s", lampId);
#if USE_LORA_TRANSPORT
  char line[LORA_LINE_MAX];
  snprintf(line, sizeof(line), "LAMP_HB,%s,%lu,%lu,%llu,%u,%u,%d",
           lampId, (unsigned long)frame.seq, (unsigned long)frame.sentAtMs,
           (unsigned long long)frame.appliedRevision, frame.appliedState,
           frame.relayCapable, frame.gatewayRssi);
  lora.sendLine(LORA_GATEWAY_ADDRESS, line);
  // Sin broadcast de presencia en modo LoRa: la lampara no participa en relays ESP-NOW.
#else
  esp_now_send(gatewayMac, reinterpret_cast<const uint8_t*>(&frame), sizeof(frame));
  EspNowCallFrame presence = {};
  presence.msgType = ESPNOW_MSG_HEARTBEAT; presence.seq = nextSequence(); presence.sentAtMs = millis();
  presence.cons = gatewayRegistered && millis() - lastGatewayContactMs < ESPNOW_GATEWAY_STALE_MS ? 0 : 99;
  snprintf(presence.deviceId, sizeof(presence.deviceId), "%s", lampId);
  esp_now_send(BROADCAST_MAC, reinterpret_cast<const uint8_t*>(&presence), sizeof(presence));
#endif
  lastHeartbeatMs = millis();
#if ENABLE_SERIAL_DEBUG
  Serial.printf("[HEARTBEAT] seq=%lu estadoAplicado=%s revision=%llu gatewayRegistrado=%d\n",
                (unsigned long)frame.seq, stateLabel(authoritativeState), (unsigned long long)appliedRevision, gatewayRegistered);
#endif
}

void requestSnapshot() {
  LampSnapshotRequestFrame frame = {};
  frame.msgType = ESPNOW_MSG_LAMP_SNAPSHOT_REQUEST; frame.seq = nextSequence(); frame.appliedRevision = appliedRevision;
  snprintf(frame.lampId, sizeof(frame.lampId), "%s", lampId);
#if USE_LORA_TRANSPORT
  char line[LORA_LINE_MAX];
  snprintf(line, sizeof(line), "LAMP_SNAP,%s,%lu,%llu",
           lampId, (unsigned long)frame.seq, (unsigned long long)frame.appliedRevision);
  lora.sendLine(LORA_GATEWAY_ADDRESS, line);
#else
  esp_now_send(gatewayMac, reinterpret_cast<const uint8_t*>(&frame), sizeof(frame));
#endif
  lastSnapshotRequestMs = millis();
#if ENABLE_SERIAL_DEBUG
  Serial.printf("[SNAPSHOT] solicitado seq=%lu appliedRevision=%llu\n", (unsigned long)frame.seq, (unsigned long long)frame.appliedRevision);
#endif
}

bool initializeEspNow() {
  WiFi.mode(WIFI_STA); delay(20);
  if (esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR) != ESP_OK || esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE) != ESP_OK) return false;
  esp_wifi_set_max_tx_power(84); WiFi.macAddress(ownMac);
  if (!parseMac(ESPNOW_GATEWAY_MAC, gatewayMac) || esp_now_init() != ESP_OK) return false;
  esp_now_register_send_cb(onEspNowSent); esp_now_register_recv_cb(onEspNowRecv); addPeerIfNeeded(gatewayMac); addPeerIfNeeded(BROADCAST_MAC);
  return true;
}

void setup() {
  // Forzar el buzzer a un estado seguro lo antes posible dentro de setup(); el guard-window
  // previo (entre power-on y esta linea) es del bootloader/ROM y no lo controla el firmware.
  digitalWrite(BUZZER_PIN, LOW); pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);
  Serial.begin(SERIAL_BAUD_RATE);
  ledcAttach(BUZZER_PIN, BUZZER_PWM_FREQ_HZ, BUZZER_PWM_RES_BITS); ledcWrite(BUZZER_PIN, 0);
  ring.begin(); ring.setBrightness(255); ring.clear(); ring.show();
  uint64_t chipMac = ESP.getEfuseMac();
  snprintf(lampId, sizeof(lampId), "%02X%02X%02X%02X%02X%02X", (uint8_t)(chipMac & 0xFF), (uint8_t)(chipMac >> 8),
           (uint8_t)(chipMac >> 16), (uint8_t)(chipMac >> 24), (uint8_t)(chipMac >> 32), (uint8_t)(chipMac >> 40));
  preferences.begin("lamp", true); appliedRevision = preferences.getULong64("revision", 0); sequenceCounter = preferences.getUInt("seqNext", 0); preferences.end();
  reserveSequenceRange(sequenceCounter); rxQueue = xQueueCreate(ESPNOW_RX_QUEUE_SIZE, sizeof(RxItem));
  #if USE_LORA_TRANSPORT
  loraCfg.rxPin = LORA_RX_PIN;
  loraCfg.txPin = LORA_TX_PIN;
  loraCfg.baud = LORA_UART_BAUD;
  loraCfg.address = LORA_LAMP_ADDRESS;
  loraCfg.frequencyHz = LORA_FREQ_HZ;
  loraCfg.sf = LORA_SF;
  loraCfg.bw = LORA_BW;
  loraCfg.cr = LORA_CR;
  loraCfg.preamble = LORA_PREAMBLE;
  loraCfg.crc = LORA_CRC;
  loraCfg.txPowerDbm = LORA_TX_POWER_DBM;
  lora.begin(LoraSerial, loraCfg);
  espNowReady = lora.configure();
#else
  espNowReady = rxQueue && initializeEspNow();
#endif
  if (!espNowReady) { Serial.println("FATAL: radio initialization failed; outputs remain OFF"); return; }
  Serial.printf("Lamp %s type=%s leds=%d channel=%d\n", lampId, DEVICE_TYPE, WS2812_LED_COUNT, ESPNOW_CHANNEL);
  sendRegister(); requestSnapshot();
}

#if ENABLE_SERIAL_DEBUG
void printStatusLine(uint32_t now) {
  Serial.printf("[STATUS] t=%lus lampId=%s gateway=%s rssi=%d estado=%s(salida=%s) rev=%llu color=%u anim=%u sonido=%u audio=%d brillo=%u%% volumen=%u%% test=%d heap=%lu\n",
                (unsigned long)(now / 1000), lampId, gatewayRegistered ? "CONECTADO" : "SIN_CONTACTO", lastGatewayRssi,
                stateLabel(authoritativeState), stateLabel(outputState), (unsigned long long)appliedRevision,
                colorPreset, animationPreset, soundPreset, audioEnabled, brightness, buzzerVolume, testActive, (unsigned long)ESP.getFreeHeap());
}
#endif

#if USE_LORA_TRANSPORT
void processLoraLine(const char* raw) {
  if (strncmp(raw, "+RCV=", 5) != 0) return;
  char payload[LORA_LINE_MAX];
  uint16_t srcAddr = 0;
  if (!lora.parseRcv(raw, payload, sizeof(payload), &srcAddr)) return;
  char* tokens[16];
  int n = loraSplitTokens(payload, tokens, 16);
  if (n < 2) return;
  if (strcmp(tokens[0], "LAMP_STATE") == 0 && n >= 14) {
    if (strncmp(tokens[1], lampId, 12) != 0) return;
    LampStateFrame frame = {};
    frame.msgType = ESPNOW_MSG_LAMP_STATE;
    frame.commandSeq = (uint32_t)strtoul(tokens[2], nullptr, 10);
    frame.stateRevision = (uint64_t)strtoull(tokens[3], nullptr, 10);
    frame.associationRevision = (uint32_t)strtoul(tokens[4], nullptr, 10);
    frame.effectiveState = (uint8_t)atoi(tokens[5]);
    frame.normalToggleMs = (uint16_t)strtoul(tokens[6], nullptr, 10);
    frame.emergencyToggleMs = (uint16_t)strtoul(tokens[7], nullptr, 10);
    frame.colorPreset = (uint8_t)atoi(tokens[8]);
    frame.animationPreset = (uint8_t)atoi(tokens[9]);
    frame.soundPreset = (uint8_t)atoi(tokens[10]);
    frame.audioEnabled = (uint8_t)atoi(tokens[11]);
    frame.brightness = (uint8_t)atoi(tokens[12]);
    frame.buzzerVolume = (uint8_t)atoi(tokens[13]);
    snprintf(frame.lampId, sizeof(frame.lampId), "%s", lampId);
    processLampState(frame, gatewayMac);
    return;
  }
  if (strcmp(tokens[0], "LAMP_TEST") == 0 && n >= 11) {
    if (strncmp(tokens[1], lampId, 12) != 0) return;
    LampTestFrame frame = {};
    frame.msgType = ESPNOW_MSG_LAMP_TEST;
    frame.commandSeq = (uint32_t)strtoul(tokens[2], nullptr, 10);
    frame.testState = (uint8_t)atoi(tokens[3]);
    frame.durationMs = (uint16_t)strtoul(tokens[4], nullptr, 10);
    frame.colorPreset = (uint8_t)atoi(tokens[5]);
    frame.animationPreset = (uint8_t)atoi(tokens[6]);
    frame.soundPreset = (uint8_t)atoi(tokens[7]);
    frame.audioEnabled = (uint8_t)atoi(tokens[8]);
    frame.brightness = (uint8_t)atoi(tokens[9]);
    frame.buzzerVolume = (uint8_t)atoi(tokens[10]);
    snprintf(frame.lampId, sizeof(frame.lampId), "%s", lampId);
    processLampTest(frame, gatewayMac);
    return;
  }
  if (strcmp(tokens[0], "ACK") == 0 && n >= 5) {
    if (strncmp(tokens[1], lampId, 12) != 0) return;
    int result = atoi(tokens[3]);
    gatewayRegistered = result == 1 || result == 2;
    lastGatewayContactMs = millis();
    return;
  }
}
#endif

void loop() {
  if (testActive && (int32_t)(millis() - testEndsAtMs) >= 0) {
    testActive = false;
    colorPreset = savedColorPreset; animationPreset = savedAnimationPreset; soundPreset = savedSoundPreset;
    audioEnabled = savedAudioEnabled; brightness = savedBrightness; buzzerVolume = savedBuzzerVolume;
    ring.setBrightness((uint8_t)((uint16_t)brightness * 255 / 100));
    applyOutputState(authoritativeState);
  }
  renderAnimation(); renderSound();
  if (!espNowReady) { delay(100); return; }
  RxItem item = {};
  for (int processed = 0; processed < 8 && xQueueReceive(rxQueue, &item, 0) == pdTRUE; processed++) processRxItem(item);
#if USE_LORA_TRANSPORT
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
  uint32_t now = millis();
  if (!gatewayRegistered && now - lastRegisterMs >= ESPNOW_REGISTER_INTERVAL_MS) sendRegister();
  if (now - lastHeartbeatMs >= ESPNOW_HEARTBEAT_INTERVAL_MS) sendHeartbeat();
  if (now - lastSnapshotRequestMs >= ESPNOW_SNAPSHOT_RETRY_MS && (!hasAuthoritativeSnapshot || now - lastGatewayContactMs >= ESPNOW_GATEWAY_STALE_MS)) requestSnapshot();
  if (lastGatewayContactMs != 0 && now - lastGatewayContactMs >= ESPNOW_GATEWAY_STALE_MS) gatewayRegistered = false;
#if ENABLE_SERIAL_DEBUG
  if (wasGatewayRegistered && !gatewayRegistered) Serial.println("[GATEWAY] contacto perdido (stale)");
  if (!wasGatewayRegistered && gatewayRegistered) Serial.println("[GATEWAY] contacto restablecido");
  wasGatewayRegistered = gatewayRegistered;
  if (now - lastStatusPrintMs >= 2000) { printStatusLine(now); lastStatusPrintMs = now; }
#endif
  delay(10);
}

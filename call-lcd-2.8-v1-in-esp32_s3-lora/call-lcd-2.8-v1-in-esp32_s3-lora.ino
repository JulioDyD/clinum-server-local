// Integración LVGL con drivers de hardware locales (ST7701 + GT911)
#include "gtx-driver.h"

// ========================================
// Librerías Incluidas
// ========================================
#include <lvgl.h>
#include "Display_ST7701.h"
#include "Touch_GT911.h"
#include "TCA9554PWR.h"
#include "I2C_Driver.h"
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_now.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include "iot_config.h"

#include <time.h>
#include "ui.h"
#include "espnow_frames.h"

#if USE_LORA_TRANSPORT
#include "lora_transport.h"
HardwareSerial LoraSerial(1);
LoraTransport lora;
LoraConfig loraCfg;
String loraLine;
bool loraBridgeReady = false;
#endif

// ========================================
// Variables Globales de Configuración (Screen6)
// ========================================
bool monitorSerialEnabled = false;
bool connectionAudioAlertEnabled = ENABLE_CONNECTION_AUDIO_ALERT;
uint8_t currentBrightnessLevel = DEFAULT_BRIGHTNESS_LEVEL;

// ========================================
// Referencias externas de UI
// ========================================
struct BootRow;
extern lv_obj_t * ui_LabelHora;
extern lv_obj_t * ui_LabelAMPM;
extern lv_obj_t * ui_cronometro;
extern lv_obj_t * ui_LabelHora2;
extern lv_obj_t * ui_LabelAMPM2;
extern lv_obj_t * ui_LabelCons1;
extern lv_obj_t * ui_LabelIp;
extern lv_obj_t * ui_LabelMac;
extern lv_obj_t * ui_Labelssid;
extern lv_obj_t * ui_Labelgatenway;
extern lv_obj_t * ui_Labelversion;
extern lv_obj_t * ui_Labelrssi;
extern lv_obj_t * ui_LabelNombre;
extern lv_obj_t * ui_LabelNombre1;
extern lv_obj_t * ui_LabelNombre2;
extern lv_obj_t * ui_namepaciente;
extern lv_obj_t * ui_namepaciente1;
extern lv_obj_t * ui_InfoPaciente;
extern lv_obj_t * ui_Screen1;
extern lv_obj_t * ui_Screen2;
extern lv_obj_t * ui_calls1;
void ui_Screen2_screen_init(void);
extern lv_obj_t * uic_led_green;
extern lv_obj_t * uic_led_red;
extern lv_obj_t * uic_call;
extern lv_obj_t * uic_finish;
extern lv_obj_t * ui_RESET;
extern lv_obj_t * ui_Screen3;
extern lv_obj_t * ui_Screen4;
extern lv_obj_t * ui_LabelNombrePaciente4;
extern lv_obj_t * ui_LabelEdadPaciente4;
extern lv_obj_t * ui_LabelIngresoFecha4;
extern lv_obj_t * ui_LabelNotasPaciente4;
extern lv_obj_t * ui_inicio2;
void ui_Screen4_screen_init(void);
extern lv_obj_t * ui_Screen5;
extern lv_obj_t * ui_LabelRelaypeer;
extern lv_obj_t * ui_Screen6;
extern lv_obj_t * ui_Switchtms;
extern lv_obj_t * ui_Sliderbrillo;
extern lv_obj_t * ui_Labelmonitorserial;
void ui_Screen6_screen_init(void);

// ========================================
// Declaraciones C/C++
// ========================================
extern "C" {
    void clearScreen4State();
}
extern bool isCalling;

// ========================================
// Smart Home Navigation
// ========================================
void custom_home_event_handler(lv_event_t * e) {
    if (lv_event_get_code(e) == LV_EVENT_CLICKED) {
        if (isCalling)
            _ui_screen_change(&ui_Screen2, LV_SCR_LOAD_ANIM_NONE, 0, 0, &ui_Screen2_screen_init);
        else
            _ui_screen_change(&ui_Screen1, LV_SCR_LOAD_ANIM_NONE, 0, 0, &ui_Screen1_screen_init);
    }
}

void hookHomeButtons() {
    if (ui_inicio)  { lv_obj_remove_event_cb(ui_inicio,  ui_event_inicio);  lv_obj_add_event_cb(ui_inicio,  custom_home_event_handler, LV_EVENT_CLICKED, NULL); }
    if (ui_inicio1) { lv_obj_remove_event_cb(ui_inicio1, ui_event_inicio1); lv_obj_add_event_cb(ui_inicio1, custom_home_event_handler, LV_EVENT_CLICKED, NULL); }
    if (ui_inicio2) { lv_obj_remove_event_cb(ui_inicio2, ui_event_inicio2); lv_obj_add_event_cb(ui_inicio2, custom_home_event_handler, LV_EVENT_CLICKED, NULL); }
    if (ui_inicio3) { lv_obj_remove_event_cb(ui_inicio3, ui_event_inicio3); lv_obj_add_event_cb(ui_inicio3, custom_home_event_handler, LV_EVENT_CLICKED, NULL); }
    debugPrintln("Hooks de navegacion instalados");
}

void playFinishSound();
void reconnectGateway(); // reconexion en caliente cuando se pierde el gateway
void sendRemoteConfigAck(uint32_t commandSeq, uint8_t result);
static inline void markEnterScreen4();
extern "C" void prepareEspNowConfigUi(void);
extern "C" void saveEspNowConfigFromUi(const char* gatewayMac, uint8_t channel);
// Prototipos explicitos de setup/loop: evitan que el preprocesador de Arduino
// genere "extern \"C\" void setup();" al inicio del .ino.cpp (conflictos de linkage)
void setup();
void loop();

// ========================================
// Variables Globales
// ========================================
String deviceId;
String deviceName = "Dispositivo";
Preferences preferences;
String configuredGatewayMac = ESPNOW_GATEWAY_MAC;
uint8_t configuredEspNowChannel = ESPNOW_CHANNEL;

bool isCalling = false;
bool isEmergencyCall = false;
int  currentConsecutive = 0;

unsigned long lastBlinkTime = 0;
bool ledGreenState = false;
bool ledRedState = false;

unsigned long cancelLedStartTime = 0;
bool cancelLedActive = false;

bool callButtonLongPress = false;
unsigned long callButtonPressStartTime = 0;
bool emergencyActivated = false;

bool calls1ButtonLongPress = false;
unsigned long calls1ButtonPressStartTime = 0;
bool calls1EmergencyActivated = false;

unsigned long callStartTime = 0;
bool chronoActive = false;
unsigned long chronoElapsedTime = 0;
unsigned long chronoRestoredBase = 0;
bool chronoRestored = false;
uint32_t currentCallStartSeq = 0;

int pendingConsecutiveValue = 0;
bool hasPendingConsecutive = false;

bool lastBotonAereoState = false;
bool botonAereoState = false;
unsigned long lastBotonAereoDebounceTime = 0;

unsigned long lastInsistTime = 0;
const unsigned long INSIST_COOLDOWN_MS = 2000;

bool patientNameTouched = false;
unsigned long patientNameTouchStartTime = 0;
int patientNameTouchCount = 0;

static inline void buzzer_on()  { Set_EXIO(BUZZER_EXIO_PIN, High); }
static inline void buzzer_off() { Set_EXIO(BUZZER_EXIO_PIN, Low);  }

bool buzzerActive = false;
unsigned long buzzerStartTime = 0;
int buzzerStep = 0;
int soundType = 0;

unsigned long lastTimeUpdate = 0;
unsigned long lastNetworkUpdate = 0;

unsigned long lastEmergencyBeepTime = 0;

bool remoteTerminationEffectActive = false;
int remoteTerminationEffectStep = 0;
unsigned long remoteTerminationEffectStartTime = 0;

bool emergencyEffectActive = false;
int emergencyEffectStep = 0;
unsigned long lastEmergencyEffectTime = 0;

bool inScreen3 = false; unsigned long screen3EnterTime = 0;
bool inScreen4 = false; unsigned long screen4EnterTime = 0;
bool inScreen5 = false; unsigned long screen5EnterTime = 0;
bool inScreen6 = false; unsigned long screen6EnterTime = 0;

String patientFullName = "";
String patientAge = "";
String patientAdmissionDate = "";
String patientNotes = "";

unsigned long lastHeartbeatTime = 0;

// ========================================
// Transporte ESP-LORA
// ========================================
enum EspNowMsgType : uint8_t {
    ESPNOW_MSG_CALL_START    = 1,
    ESPNOW_MSG_CALL_INSIST   = 2,
    ESPNOW_MSG_CALL_END      = 3,
    ESPNOW_MSG_HEARTBEAT     = 4,
    ESPNOW_MSG_ACK           = 5,
    ESPNOW_MSG_CONFIG        = 6,
    ESPNOW_MSG_REGISTER      = 7,
    ESPNOW_MSG_RELAY_REQ     = 8,  // Broadcast: solicita relay a nodo intermedio
    ESPNOW_MSG_RELAY_CONFIRM = 9,  // Unicast: confirmacion del nodo relay al emisor
    ESPNOW_MSG_CONFIG_ACK    = 10,
};

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
    uint8_t result;
    char deviceId[13];
    uint32_t epochS;         // epoch segundos del servidor (0=no sincronizado)
    uint8_t  callActive;     // 1 = hay llamado activo que el terminal debe retomar
    uint8_t  callType;       // 0=normal, 1=emergency
    uint32_t callStartedAtS; // epoch segundos cuando inicio el llamado
    uint16_t callCons;       // consecutivos acumulados del llamado
    uint32_t callStartSeq;   // secuencia estable del inicio de la llamada activa
};

uint8_t espnowGatewayMac[6] = {0};
bool espnowBridgeReady = false;
bool espnowServerSynced = false;
bool isReconnecting     = false;  // true mientras proceso de reconexion activo
volatile bool espnowAckReceived = false;
volatile uint32_t espnowAckSeq = 0;
volatile uint8_t espnowAckResult = 0;
volatile uint32_t espnowExpectedAckSeq = 0;
volatile bool espnowConfigPending = false;
EspNowConfigFrame espnowPendingConfig = {};
uint32_t espnowSeqCounter = 0;
uint32_t espnowSeqReservedUntil = 0;
volatile uint32_t espnowLastAckEpochS = 0;
unsigned long lastGatewayAckMs = 0;  // Timestamp del ultimo ACK/confirm recibido del gateway (directo O via relay)
unsigned long lastDirectGatewayAckMs = 0;  // Timestamp del ultimo ACK recibido SIN pasar por relay (para saber si en verdad hay ruta directa)

static const uint32_t ESPNOW_SEQ_RESERVATION_SIZE = 100000UL;

// Margen de asentamiento de flash tras una escritura NVS (Preferences) antes de que
// el llamador reanude lv_timer_handler(): ver memoria de proyecto (bug StoreProhibited/
// 0xbad00bad) - una escritura NVS seguida de inmediato por codigo LVGL residente en
// flash puede corromper el fetch de instrucciones si no se da este margen sin renderizado.
static void settleFlashAfterNvsWrite() {
    for (int i = 0; i < 5; i++) { esp_task_wdt_reset(); delay(10); }
}

void reserveEspNowSeqRange(uint32_t floor) {
    uint32_t reservedUntil = floor + ESPNOW_SEQ_RESERVATION_SIZE;
    if (reservedUntil < floor) reservedUntil = UINT32_MAX;
    preferences.begin("sys_cfg", false);
    preferences.putUInt("espSeqNext", reservedUntil);
    preferences.end();
    espnowSeqReservedUntil = reservedUntil;
    settleFlashAfterNvsWrite();
}

void initializeEspNowSeqCounter() {
    preferences.begin("sys_cfg", true);
    espnowSeqCounter = preferences.getUInt("espSeqNext", 0);
    preferences.end();
    if (espnowSeqCounter > 0) reserveEspNowSeqRange(espnowSeqCounter);
}

void syncEspNowSeqCounterFromServer() {
    uint32_t serverFloor = espnowLastAckEpochS;
    if (serverFloor > espnowSeqCounter) espnowSeqCounter = serverFloor;
    if (espnowSeqReservedUntil <= espnowSeqCounter + 1) {
        reserveEspNowSeqRange(espnowSeqCounter);
    }
}

uint32_t nextEspNowSeq() {
    if (espnowSeqReservedUntil != 0 && espnowSeqCounter + 1 >= espnowSeqReservedUntil) {
        reserveEspNowSeqRange(espnowSeqCounter);
    }
    return ++espnowSeqCounter;
}

// ---- Restauracion de llamado activo tras reboot ----
struct RestoreCallInfo {
    uint8_t  callType;       // 0=normal, 1=emergency
    uint32_t callStartedAtS; // epoch cuando inicio el llamado
    uint32_t epochS;         // epoch del servidor al momento del ACK
    uint16_t callCons;       // consecutivos acumulados
    uint32_t callStartSeq;   // identidad estable de la llamada restaurada
};
RestoreCallInfo espnowRestoreCallInfo = {};
volatile bool espnowPendingRestoreCall  = false;
volatile bool espnowCallFrameFailed     = false; // frame de llamado descartado definitivamente por TX

// ---- MAC broadcast ----
static const uint8_t ESPNOW_BROADCAST_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
uint8_t ownMacBytes[6] = {0}; // MAC propia cacheada (se llena en initEspNowBridge)

// ---- TX Queue no bloqueante ----
enum EspNowTxState : uint8_t {
    TX_IDLE           = 0,
    TX_AWAITING_ACK   = 1,  // Frame enviado al gateway, esperando ACK directo
    TX_AWAITING_RELAY = 2,  // RELAY_REQ enviado, esperando RELAY_CONFIRM
};

struct EspNowTxItem {
    bool          active;
    uint8_t       frame[sizeof(EspNowCallFrame)];
    size_t        frameLen;
    uint32_t      seq;
    uint8_t       retries;
    unsigned long sentAtMs;
};

EspNowTxItem  espnowTxQueue[ESPNOW_TX_QUEUE_SIZE];
int           txQueueHead  = 0;
int           txQueueTail  = 0;
EspNowTxState espnowTxState = TX_IDLE;

// ---- Relay peer table ----
struct RelayPeer {
    bool          active;
    uint8_t       mac[6];
    unsigned long lastSeenMs;
    int8_t        rssi;          // RSSI del ultimo heartbeat recibido (cruda)
    float         smoothedRssi;  // Promedio movil exponencial (suaviza ruido de +-10-15dB visto en campo)
    uint8_t       gatewayMetric; // 0=gateway directo, N=N saltos relay, 99=sin ruta
    bool          eligible;      // false si smoothedRssi < RELAY_RSSI_MIN_THRESHOLD
    unsigned long blacklistedUntilMs; // != 0 y aun no vencido = send FAIL reciente, evitar como candidato
};
RelayPeer relayPeers[ESPNOW_RELAY_PEER_MAX];

// ---- Relay actualmente en uso (para histeresis: evita cambiar de relay por mejoras marginales) ----
uint8_t currentRelayMac[6] = {0};
bool    hasCurrentRelay    = false;

// ---- Relay confirm (senalado desde recv callback) ----
volatile bool     relayConfirmReceived   = false; // true SOLO si el confirm fue result=1 (exito)
volatile bool     relayConfirmAnyReceived = false; // true con CUALQUIER confirm (exito o NACK) -> permite salir del timeout antes
volatile uint32_t relayConfirmSeq      = 0;
uint8_t           relayConfirmMac[6]   = {0}; // MAC del nodo relay que confirmo (para log de ruta)

// ---- Relay REQ cola (hasta 3 requests pendientes, procesados en loop) ----
#define ESPNOW_RELAY_REQ_QUEUE_SIZE 3
EspNowRelayReqFrame espnowRelayReqQueue[ESPNOW_RELAY_REQ_QUEUE_SIZE];
volatile int        espnowRelayReqQHead = 0;
volatile int        espnowRelayReqQTail = 0;

// ---- Cache del ultimo RELAY_REQ enviado para una llamada (permite reenviar una vez si el
//      enlace es marginal y no llega respuesta a mitad de la ventana de espera) ----
EspNowRelayReqFrame lastCallRelayReq        = {};
uint8_t             lastCallRelayTargetMac[6] = {0};
bool                lastCallRelayResent      = false;
bool                lastCallRelayBroadcastFallbackSent = false;

// ---- Hop table multi-salto: nodos intermedios esperan confirm de su sub-relay ----
#define RELAY_HOP_TABLE_SIZE 4
struct RelayHopEntry {
    volatile bool     active;
    volatile uint32_t origSeq;
    uint8_t           prevHopMac[6]; // a quien reenviar el RELAY_CONFIRM cuando llegue
    unsigned long     createdAt;
};
RelayHopEntry relayHopTable[RELAY_HOP_TABLE_SIZE];

// Ruta inversa aprendida al recibir RELAY_REQ. Permite devolver ACK/CONFIG del
// servidor al dispositivo original a traves de la misma cadena de nodos.
struct RelayReverseRoute {
    bool          active;
    char          deviceId[13];
    uint8_t       prevHopMac[6];
    unsigned long lastSeenMs;
};
RelayReverseRoute relayReverseRoutes[ESPNOW_RELAY_PEER_MAX];

// ---- Forward confirm pendiente (del recv callback WiFi al loop) ----
struct RelayForwardPending {
    bool     active;
    uint32_t origSeq;
    uint8_t  targetMac[6];
    uint8_t  result;
    char     deviceId[13];
    uint32_t epochS; // hora epoch del relay que genero/recibio este confirm (0 = no disponible)
};
volatile bool       relayFwdPending = false;
RelayForwardPending relayFwdReq     = {};

// ---- Heartbeat de peer pendiente (procesado en loop) ----
volatile bool espnowPeerMacPending = false;
uint8_t       espnowPendingPeerMac[6] = {0};
volatile int8_t espnowPendingPeerRssi = -100; // RSSI del heartbeat pendiente

volatile int8_t gatewayRssi = -100;       // RSSI del ultimo ACK del gateway
uint8_t         myGatewayMetric = 99;     // Metrica propia: 0=directo, 1-4=saltos, 99=sin ruta
volatile uint8_t espnowPendingPeerMetric = 99; // Metrica del peer pendiente (ISR→loop)
unsigned long   lastMetricUpdateMs = 0;

unsigned long lastPresenceBroadcastTime = 0;

// Prueba controlada: este llamador envia eventos de llamada SOLO por el nodo fijo.
void rememberRelayReverseRoute(const char* targetDeviceId, const uint8_t prevHopMac[6]) {
    int slot = -1;
    unsigned long oldest = ULONG_MAX;
    int oldestIdx = 0;
    for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
        if (relayReverseRoutes[i].active &&
            strncmp(relayReverseRoutes[i].deviceId, targetDeviceId, 12) == 0) {
            slot = i;
            break;
        }
        if (!relayReverseRoutes[i].active && slot < 0) slot = i;
        if (relayReverseRoutes[i].active && relayReverseRoutes[i].lastSeenMs < oldest) {
            oldest = relayReverseRoutes[i].lastSeenMs;
            oldestIdx = i;
        }
    }
    if (slot < 0) slot = oldestIdx;
    relayReverseRoutes[slot].active = true;
    strncpy(relayReverseRoutes[slot].deviceId, targetDeviceId, 12);
    relayReverseRoutes[slot].deviceId[12] = '\0';
    memcpy(relayReverseRoutes[slot].prevHopMac, prevHopMac, 6);
    relayReverseRoutes[slot].lastSeenMs = millis();
}

bool forwardToRelayOrigin(const char* targetDeviceId, const uint8_t* data, size_t len) {
    for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
        if (!relayReverseRoutes[i].active) continue;
        if ((millis() - relayReverseRoutes[i].lastSeenMs) >= ESPNOW_RELAY_STALE_MS) continue;
        if (strncmp(relayReverseRoutes[i].deviceId, targetDeviceId, 12) != 0) continue;
        const uint8_t* targetMac = relayReverseRoutes[i].prevHopMac;
        if (!esp_now_is_peer_exist(targetMac)) {
            esp_now_peer_info_t peer = {};
            memcpy(peer.peer_addr, targetMac, 6);
            peer.channel = configuredEspNowChannel;
            peer.encrypt = false;
            if (esp_now_add_peer(&peer) != ESP_OK) return false;
        }
        return esp_now_send(targetMac, data, len) == ESP_OK;
    }
    return false;
}

bool parseMacString(const char* macStr, uint8_t out[6]) {
    unsigned int b[6] = {0};
    if (sscanf(macStr, "%02x:%02x:%02x:%02x:%02x:%02x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) != 6)
        return false;
    for (int i = 0; i < 6; ++i) out[i] = (uint8_t)b[i];
    return true;
}

bool isValidGatewayMac(const String& mac, uint8_t parsed[6]) {
    if (mac.length() != 17) return false;
    for (int i = 0; i < 17; i++) {
        bool separator = (i == 2 || i == 5 || i == 8 || i == 11 || i == 14);
        char value = mac.charAt(i);
        if (separator ? value != ':' : !((value >= '0' && value <= '9') ||
                                         (value >= 'A' && value <= 'F') ||
                                         (value >= 'a' && value <= 'f'))) return false;
    }
    if (!parseMacString(mac.c_str(), parsed)) return false;
    if ((parsed[0] & 0x01) != 0) return false;
    bool allZero = true;
    for (int i = 0; i < 6; i++) {
        if (parsed[i] != 0) { allZero = false; break; }
    }
    return !allZero;
}

void loadEspNowConfig() {
    preferences.begin("sys_cfg", true);
    String savedMac = preferences.getString("gwMac", ESPNOW_GATEWAY_MAC);
    uint8_t savedChannel = preferences.getUChar("espCh", ESPNOW_CHANNEL);
    preferences.end();

    savedMac.trim();
    savedMac.toUpperCase();
    uint8_t parsed[6] = {0};
    if (!isValidGatewayMac(savedMac, parsed)) savedMac = ESPNOW_GATEWAY_MAC;
    if (savedChannel < 1 || savedChannel > 13) savedChannel = ESPNOW_CHANNEL;
    configuredGatewayMac = savedMac;
    configuredEspNowChannel = savedChannel;
}

extern "C" void prepareEspNowConfigUi(void) {
    ui_show_espnow_config(configuredGatewayMac.c_str(), configuredEspNowChannel);
}

extern "C" void saveEspNowConfigFromUi(const char* gatewayMac, uint8_t channel) {
    String normalizedMac = gatewayMac ? String(gatewayMac) : String();
    normalizedMac.trim();
    normalizedMac.toUpperCase();
    uint8_t parsed[6] = {0};

    if (!isValidGatewayMac(normalizedMac, parsed)) {
        if (ui_EspNowConfigStatus)
            lv_label_set_text(ui_EspNowConfigStatus, "MAC invalida: AA:BB:CC:DD:EE:FF");
        return;
    }
    if (channel < 1 || channel > 13) {
        if (ui_EspNowConfigStatus) lv_label_set_text(ui_EspNowConfigStatus, "Canal invalido (1-13)");
        return;
    }

    preferences.begin("sys_cfg", false);
    size_t macWritten = preferences.putString("gwMac", normalizedMac);
    size_t channelWritten = preferences.putUChar("espCh", channel);
    preferences.end();
    settleFlashAfterNvsWrite();
    if (macWritten == 0 || channelWritten == 0) {
        if (ui_EspNowConfigStatus) lv_label_set_text(ui_EspNowConfigStatus, "Error guardando en memoria");
        return;
    }

    configuredGatewayMac = normalizedMac;
    configuredEspNowChannel = channel;
    if (ui_EspNowConfigStatus) lv_label_set_text(ui_EspNowConfigStatus, "Guardado. Reiniciando...");
    lv_timer_handler();
    delay(350);
    ESP.restart();
}

void onEspNowSent(const uint8_t* mac_addr, esp_now_send_status_t status) {
    #if ENABLE_SERIAL_DEBUG
    if (mac_addr) {
        Serial.printf("ESP-LORA sent %s -> %02X:%02X:%02X:%02X:%02X:%02X\n",
                      status == ESP_NOW_SEND_SUCCESS ? "OK" : "FAIL",
                      mac_addr[0], mac_addr[1], mac_addr[2], mac_addr[3], mac_addr[4], mac_addr[5]);
    } else {
        Serial.println(status == ESP_NOW_SEND_SUCCESS ? "ESP-LORA sent OK" : "ESP-LORA sent FAIL");
    }
    #endif
#if ESPNOW_RELAY_ENABLED
    if (status != ESP_NOW_SEND_SUCCESS && mac_addr &&
        memcmp(mac_addr, espnowGatewayMac, 6) == 0) {
        // El siguiente RELAY_REQ debe usar la ruta de nodos conocida, no volver a
        // asumir que existe un enlace directo que acaba de fallar a nivel MAC.
        lastDirectGatewayAckMs = 0;
    }
    // Un envio con status FAIL confirma (a nivel MAC/802.11) que el peer NO respondio ACK de
    // radio: si ese peer es un candidato relay conocido, marcarlo temporalmente no disponible
    // para que selectBestRelayPeer() elija otro candidato en vez de seguir insistiendole al mismo
    // que acaba de fallar (antes se reintentaba ciegamente 2-3 veces al MISMO peer ya inalcanzable).
    if (status != ESP_NOW_SEND_SUCCESS && mac_addr) {
        for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
            if (relayPeers[i].active && memcmp(relayPeers[i].mac, mac_addr, 6) == 0) {
                relayPeers[i].blacklistedUntilMs = millis() + RELAY_BLACKLIST_MS;
                break;
            }
        }
    }
#endif
}

void applyEspNowConfig(const struct EspNowConfigFrame& cfg) {
    if (strncmp(cfg.deviceId, deviceId.c_str(), 12) != 0) return;
    if (cfg.applyBrightness) {
        uint8_t nb = cfg.brightness;
        if (nb < MIN_BRIGHTNESS_LEVEL) nb = MIN_BRIGHTNESS_LEVEL;
        if (nb > MAX_BRIGHTNESS_LEVEL) nb = MAX_BRIGHTNESS_LEVEL;
        currentBrightnessLevel = nb;
        Set_Backlight(currentBrightnessLevel);
        preferences.begin("sys_cfg", false);
        preferences.putUInt("brightness", currentBrightnessLevel);
        preferences.end();
        settleFlashAfterNvsWrite();
        debugPrintln("ESP-LORA config: brillo=" + String(currentBrightnessLevel) + "%");
    }
    if (cfg.applyAudioAlert) {
        connectionAudioAlertEnabled = (cfg.audioAlertEnabled == 1);
        preferences.begin("sys_cfg", false);
        preferences.putBool("audioAlert", connectionAudioAlertEnabled);
        preferences.end();
        settleFlashAfterNvsWrite();
        debugPrintln(String("ESP-LORA config: audioAlert=") + (connectionAudioAlertEnabled ? "true" : "false"));
    }
    if (cfg.applyWiFi) debugPrintln("ESP-LORA config: bloque WiFi ignorado (modo ESP-LORA puro)");
    if (cfg.applyName && cfg.name[0] != '\0') {
        String newName = String(cfg.name);
        newName.trim();
        if (newName.length() > 0) {
            deviceName = newName;
            preferences.begin("sys_cfg", false);
            preferences.putString("devName", deviceName);
            preferences.end();
            settleFlashAfterNvsWrite();
            updateDeviceNameDisplay(deviceName);
            debugPrintln("Nombre recibido: " + deviceName);
        }
    }
    if (cfg.endCall) {
        if (!isCalling) {
            sendRemoteConfigAck(cfg.seq, 1);
        } else {
            bool matchesCurrentCall = cfg.targetCallSeq == 0 || cfg.targetCallSeq == currentCallStartSeq;
            if (matchesCurrentCall) {
                handleRemoteCallTermination();
                sendRemoteConfigAck(cfg.seq, 1);
            } else {
                debugPrintln("Cierre remoto ignorado: corresponde a otra llamada");
                sendRemoteConfigAck(cfg.seq, 0);
            }
        }
    }
}

void onEspNowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
    if (!info || !data || len <= 0) return;
    if (deviceId.length() < 12) return;
    uint8_t msgType = data[0];

    // ---- ACK del gateway: senaliza al TX state machine ----
    if (msgType == ESPNOW_MSG_ACK) {
        if (len < (int)sizeof(EspNowAckFrame)) return;
        EspNowAckFrame ack;
        memcpy(&ack, data, sizeof(EspNowAckFrame));
        ack.deviceId[12] = '\0';
        if (strncmp(ack.deviceId, deviceId.c_str(), 12) != 0) {
            forwardToRelayOrigin(ack.deviceId, data, sizeof(EspNowAckFrame));
            return;
        }
        // Sincronizar reloj del sistema con la hora del servidor
        if (ack.epochS > 0) {
            espnowLastAckEpochS = ack.epochS;
            struct timeval tv = { .tv_sec = (time_t)ack.epochS, .tv_usec = 0 };
            settimeofday(&tv, nullptr);
        }
        // Cualquier ACK valido del gateway actualiza timestamp de conectividad
        if (ack.result == 1 || ack.result == 2) {
            lastGatewayAckMs       = millis();
            if (memcmp(info->src_addr, espnowGatewayMac, 6) == 0) {
                lastDirectGatewayAckMs = millis();
            }
            espnowServerSynced     = true;
        }
        // Senal de llamado activo: el servidor indica que hay que retomar un llamado
        if (ack.callActive == 1 && (!isCalling || isReconnecting)) {
            espnowRestoreCallInfo.callType       = ack.callType;
            espnowRestoreCallInfo.callStartedAtS = ack.callStartedAtS;
            espnowRestoreCallInfo.epochS         = ack.epochS;
            espnowRestoreCallInfo.callCons       = ack.callCons;
            espnowRestoreCallInfo.callStartSeq   = ack.callStartSeq;
            espnowPendingRestoreCall = true;  // volatile: setear al final
        }
        // Heartbeats tambien reciben ACK. No deben sobrescribir el ACK de una
        // llamada o registro que la maquina de estados esta esperando.
        if (espnowExpectedAckSeq != 0 && ack.seq == espnowExpectedAckSeq) {
            espnowAckSeq      = ack.seq;
            espnowAckResult   = ack.result;
            espnowAckReceived = true;
        }
        if (memcmp(info->src_addr, espnowGatewayMac, 6) == 0) {
            gatewayRssi = info->rx_ctrl->rssi;
        }
        return;
    }

    // ---- CONFIG remota (procesada en loop) ----
    if (msgType == ESPNOW_MSG_CONFIG) {
        if (len < (int)sizeof(EspNowConfigFrame)) return;
        EspNowConfigFrame cfg = {};
        memcpy(&cfg, data, sizeof(EspNowConfigFrame));
        cfg.deviceId[12] = '\0'; cfg.ssid[32] = '\0'; cfg.password[64] = '\0';
        cfg.ip[15] = '\0'; cfg.gateway[15] = '\0'; cfg.subnet[15] = '\0';
        cfg.dns1[15] = '\0'; cfg.dns2[15] = '\0';
        if (strncmp(cfg.deviceId, deviceId.c_str(), 12) != 0) {
            forwardToRelayOrigin(cfg.deviceId, data, sizeof(EspNowConfigFrame));
            return;
        }
        noInterrupts();
        memcpy(&espnowPendingConfig, &cfg, sizeof(EspNowConfigFrame));
        espnowConfigPending = true;
        interrupts();
        return;
    }

#if ESPNOW_RELAY_ENABLED
    // ---- HEARTBEAT de otro terminal → candidato relay (procesado en loop) ----
    if (msgType == ESPNOW_MSG_HEARTBEAT) {
        if (len < (int)sizeof(EspNowCallFrame)) return;
        EspNowCallFrame hb = {};
        memcpy(&hb, data, sizeof(EspNowCallFrame));
        hb.deviceId[12] = '\0';
        // Ignorar nuestro propio broadcast rebotado
        if (strncmp(hb.deviceId, deviceId.c_str(), 12) == 0) return;
        // Guardar MAC y RSSI para actualizar la tabla de relay en loop()
        noInterrupts();
        memcpy(espnowPendingPeerMac, info->src_addr, 6);
        espnowPendingPeerRssi   = info->rx_ctrl->rssi;
        espnowPendingPeerMetric = (uint8_t)(hb.cons <= 4 ? hb.cons : 99); // cons en HB = gatewayMetric
        espnowPeerMacPending = true;
        interrupts();
        return;
    }

    // ---- RELAY_REQ → somos nodo intermedio, procesar en loop() ----
    if (msgType == ESPNOW_MSG_RELAY_REQ) {
        // Log inmediato: alguien esta intentando usarnos como relay (se imprime SIEMPRE que
        // llega el paquete, antes de cualquier validacion, para poder ver en el serial de ESTE
        // dispositivo si el RELAY_REQ realmente esta llegando por radio o no)
        Serial.printf("[RELAY-NODE] RELAY_REQ recibido de %02X:%02X:%02X:%02X:%02X:%02X (rssi=%d, len=%d)\n",
                      info->src_addr[0], info->src_addr[1], info->src_addr[2],
                      info->src_addr[3], info->src_addr[4], info->src_addr[5],
                      info->rx_ctrl->rssi, len);
        if (len < (int)sizeof(EspNowRelayReqFrame)) {
            Serial.printf("[RELAY-NODE] RELAY_REQ RECHAZADO (tamano invalido: %d < %d)\n",
                          len, (int)sizeof(EspNowRelayReqFrame));
            return;
        }
        const EspNowRelayReqFrame* r = (const EspNowRelayReqFrame*)data;
        // Anti-loop: ignorar frames donde somos el emisor original
        if (memcmp(r->origMac, ownMacBytes, 6) == 0) {
            Serial.println("[RELAY-NODE] RELAY_REQ ignorado (yo soy el emisor original, anti-loop)");
            return;
        }

        rememberRelayReverseRoute(r->deviceId, r->prevHopMac);

        // Helper local: responder de inmediato con NACK (result=0) en vez de dejar al
        // solicitante esperando ciegamente el timeout completo (ESPNOW_RELAY_CONFIRM_TIMEOUT_MS*3).
        // Antes esta funcion simplemente hacia "return" en silencio en estos casos, lo que hacia
        // indistinguible "no puedo ayudarte" de "tu paquete se perdio en el aire".
        auto sendFastNack = [&](const char* motivo) {
            Serial.printf("[RELAY-NODE] RELAY_REQ RECHAZADO (%s) seq=%u de %02X:%02X:%02X:%02X:%02X:%02X -> NACK\n",
                          motivo, r->origSeq,
                          info->src_addr[0], info->src_addr[1], info->src_addr[2],
                          info->src_addr[3], info->src_addr[4], info->src_addr[5]);
            EspNowRelayConfirmFrame nack = {};
            nack.msgType = ESPNOW_MSG_RELAY_CONFIRM;
            nack.origSeq = r->origSeq;
            nack.result  = 0;
            strncpy(nack.deviceId, r->deviceId, 12);
            nack.deviceId[12] = '\0';
            if (!esp_now_is_peer_exist(r->prevHopMac)) {
                esp_now_peer_info_t p = {};
                memcpy(p.peer_addr, r->prevHopMac, 6);
                p.channel = configuredEspNowChannel;
                p.encrypt = false;
                esp_now_add_peer(&p);
            }
            esp_now_send(r->prevHopMac, (const uint8_t*)&nack, sizeof(nack));
        };

        // Solo aceptar si tenemos conectividad activa reciente con el gateway
        if (!espnowServerSynced) { sendFastNack("yo no estoy sincronizado con el gateway"); return; }
        if ((millis() - lastGatewayAckMs) > ESPNOW_RELAY_STALE_MS) { sendFastNack("mi conexion con el gateway esta obsoleta"); return; }
        // Encolar en ring buffer (descarta si llena)
        noInterrupts();
        int nextTail = (espnowRelayReqQTail + 1) % ESPNOW_RELAY_REQ_QUEUE_SIZE;
        bool queued = (nextTail != espnowRelayReqQHead);
        if (queued) {
            memcpy(&espnowRelayReqQueue[espnowRelayReqQTail], data, sizeof(EspNowRelayReqFrame));
            espnowRelayReqQTail = nextTail;
        }
        interrupts();
        if (!queued) sendFastNack("mi cola de RELAY_REQ esta llena");
        else Serial.printf("[RELAY-NODE] RELAY_REQ seq=%u encolado OK, se procesara en el loop()\n", r->origSeq);
        return;
    }

    // ---- RELAY_CONFIRM → relay entrego el frame (o somos nodo intermedio en la cadena) ----
    if (msgType == ESPNOW_MSG_RELAY_CONFIRM) {
        if (len < (int)sizeof(EspNowRelayConfirmFrame)) return;
        EspNowRelayConfirmFrame conf = {};
        memcpy(&conf, data, sizeof(EspNowRelayConfirmFrame));
        conf.deviceId[12] = '\0';
        // Primero verificar si somos un nodo intermedio (hop table)
        bool isHopForward = false;
        for (int i = 0; i < RELAY_HOP_TABLE_SIZE; i++) {
            if (relayHopTable[i].active && relayHopTable[i].origSeq == conf.origSeq) {
                // Somos intermediario: encolar reenvio de confirm al hop previo
                noInterrupts();
                relayFwdReq.active  = true;
                relayFwdReq.origSeq = conf.origSeq;
                relayFwdReq.result  = conf.result;
                relayFwdReq.epochS  = conf.epochS;
                memcpy(relayFwdReq.targetMac, relayHopTable[i].prevHopMac, 6);
                strncpy(relayFwdReq.deviceId, conf.deviceId, 12);
                relayFwdReq.deviceId[12] = '\0';
                relayFwdPending          = true;
                relayHopTable[i].active  = false;
                interrupts();
                isHopForward = true;
                break;
            }
        }
        if (!isHopForward) {
            // Es el confirm final para nosotros como emisor original
            if (strncmp(conf.deviceId, deviceId.c_str(), 12) != 0) return;
            memcpy(relayConfirmMac, info->src_addr, 6);
            relayConfirmSeq        = conf.origSeq;
            relayConfirmReceived   = (conf.result == 1);
            relayConfirmAnyReceived = true; // exito O nack: de cualquier forma ya no hay que seguir esperando a ciegas
            if (conf.result == 1) {
                lastGatewayAckMs   = millis();
                espnowServerSynced = true;
            }
            // El nodo relay adjunta su propia hora (si la tiene sincronizada): usarla para ajustar
            // nuestro reloj, ya que registrados/conectados via relay NUNCA vemos el ACK real del
            // gateway (ese llega directo al relay, no a nosotros).
            if (conf.epochS > 0) {
                struct timeval tv = { .tv_sec = (time_t)conf.epochS, .tv_usec = 0 };
                settimeofday(&tv, nullptr);
            }
            Serial.printf("[RELAY-TX] Confirm seq=%u relay=%02X:%02X:%02X:%02X:%02X:%02X result=%s\n",
                          conf.origSeq,
                          info->src_addr[0], info->src_addr[1], info->src_addr[2],
                          info->src_addr[3], info->src_addr[4], info->src_addr[5],
                          conf.result == 1 ? "OK" : "FALLO");
        }
        return;
    }
#endif
}

bool initEspNowBridge() {
#if USE_LORA_TRANSPORT
    loraCfg.rxPin = LORA_RX_PIN;
    loraCfg.txPin = LORA_TX_PIN;
    loraCfg.baud = LORA_UART_BAUD;
    loraCfg.address = LORA_CALLER_ADDRESS;
    loraCfg.frequencyHz = LORA_FREQ_HZ;
    loraCfg.sf = LORA_SF;
    loraCfg.bw = LORA_BW;
    loraCfg.cr = LORA_CR;
    loraCfg.preamble = LORA_PREAMBLE;
    loraCfg.crc = LORA_CRC;
    loraCfg.txPowerDbm = LORA_TX_POWER_DBM;
    lora.begin(LoraSerial, loraCfg);
    if (!lora.configure()) {
        debugPrintln("LoRa init fallo");
        return false;
    }
    memset(espnowTxQueue, 0, sizeof(espnowTxQueue));
    txQueueHead = 0;
    txQueueTail = 0;
    espnowTxState = TX_IDLE;
    lastGatewayAckMs = 0;
    lastDirectGatewayAckMs = 0;
    myGatewayMetric = 0;
    espnowBridgeReady = true;
    loraBridgeReady = true;
    debugPrintln("LoRa bridge listo");
    return true;
#else
    WiFi.mode(WIFI_STA);
    delay(20);
    esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR); // Long Range: ~4x mayor alcance
    if (esp_wifi_set_channel(configuredEspNowChannel, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
        debugPrintln("ESP-LORA no pudo fijar el canal configurado");
        return false;
    }
    esp_wifi_set_max_tx_power(84); // 84 = 21dBm, maximo permitido en la mayoria de regiones
    WiFi.macAddress(ownMacBytes); // Cachear MAC propia para uso en recv callback (anti-loop)
    if (!parseMacString(configuredGatewayMac.c_str(), espnowGatewayMac)) {
        debugPrintln("ESP-LORA MAC gateway configurada invalida");
        return false;
    }
    if (esp_now_init() != ESP_OK) {
        debugPrintln("ESP-LORA init fallo");
        return false;
    }
    esp_now_register_send_cb(onEspNowSent);
    esp_now_register_recv_cb(onEspNowRecv);

    // Peer unicast: gateway
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, espnowGatewayMac, 6);
    peerInfo.channel = configuredEspNowChannel;
    peerInfo.encrypt = false;
    if (!esp_now_is_peer_exist(espnowGatewayMac)) {
        if (esp_now_add_peer(&peerInfo) != ESP_OK) {
            debugPrintln("ESP-LORA add_peer gateway fallo");
            return false;
        }
    }

#if ESPNOW_RELAY_ENABLED
    // Peer broadcast: para relay discovery y RELAY_REQ
    if (!esp_now_is_peer_exist(ESPNOW_BROADCAST_MAC)) {
        esp_now_peer_info_t bcast = {};
        memcpy(bcast.peer_addr, ESPNOW_BROADCAST_MAC, 6);
        bcast.channel = configuredEspNowChannel;
        bcast.encrypt = false;
        esp_now_add_peer(&bcast);
    }
    memset(relayPeers, 0, sizeof(relayPeers));
    memset(relayHopTable, 0, sizeof(relayHopTable));
    memset(relayReverseRoutes, 0, sizeof(relayReverseRoutes));
    relayFwdPending = false;
#endif

    // Inicializar TX queue
    memset(espnowTxQueue, 0, sizeof(espnowTxQueue));
    txQueueHead  = 0;
    txQueueTail  = 0;
    espnowTxState = TX_IDLE;
    lastGatewayAckMs       = 0;
    lastDirectGatewayAckMs = 0;

    espnowBridgeReady = true;
    debugPrintln("ESP-LORA bridge listo (relay=" + String(ESPNOW_RELAY_ENABLED) + ")");
    return true;
#endif
}

#if USE_LORA_TRANSPORT
void processLoraLine(const char* raw) {
    if (strncmp(raw, "+RCV=", 5) != 0) return;
    char payload[LORA_LINE_MAX];
    uint16_t srcAddr = 0;
    if (!lora.parseRcv(raw, payload, sizeof(payload), &srcAddr)) return;
    char* tokens[16];
    int n = loraSplitTokens(payload, tokens, 16);
    if (n < 2) return;

    if (strcmp(tokens[0], "ACK") == 0 && n >= 10) {
        if (strncmp(tokens[1], deviceId.c_str(), 12) != 0) return;
        EspNowAckFrame ack = {};
        ack.msgType = ESPNOW_MSG_ACK;
        ack.seq = (uint32_t)strtoul(tokens[2], nullptr, 10);
        ack.result = (uint8_t)atoi(tokens[3]);
        ack.callActive = (uint8_t)atoi(tokens[4]);
        ack.callType = (uint8_t)atoi(tokens[5]);
        ack.callStartedAtS = (uint32_t)strtoul(tokens[6], nullptr, 10);
        ack.callCons = (uint16_t)strtoul(tokens[7], nullptr, 10);
        ack.callStartSeq = (uint32_t)strtoul(tokens[8], nullptr, 10);
        ack.epochS = (uint32_t)strtoul(tokens[9], nullptr, 10);
        snprintf(ack.deviceId, sizeof(ack.deviceId), "%s", deviceId.c_str());

        // Sincronizar reloj del sistema con la hora del servidor
        if (ack.epochS > 0) {
            espnowLastAckEpochS = ack.epochS;
            struct timeval tv = { .tv_sec = (time_t)ack.epochS, .tv_usec = 0 };
            settimeofday(&tv, nullptr);
        }
        // Cualquier ACK valido actualiza conectividad (LoRa no distingue directo/relay)
        if (ack.result == 1 || ack.result == 2) {
            lastGatewayAckMs = millis();
            lastDirectGatewayAckMs = millis();
            espnowServerSynced = true;
        }
        // Senal de llamado activo: el servidor indica que hay que retomar un llamado
        if (ack.callActive == 1 && (!isCalling || isReconnecting)) {
            espnowRestoreCallInfo.callType = ack.callType;
            espnowRestoreCallInfo.callStartedAtS = ack.callStartedAtS;
            espnowRestoreCallInfo.epochS = ack.epochS;
            espnowRestoreCallInfo.callCons = ack.callCons;
            espnowRestoreCallInfo.callStartSeq = ack.callStartSeq;
            espnowPendingRestoreCall = true;
        }
        // Heartbeats tambien reciben ACK. No deben sobrescribir el ACK de una
        // llamada o registro que la maquina de estados esta esperando.
        if (espnowExpectedAckSeq != 0 && ack.seq == espnowExpectedAckSeq) {
            espnowAckSeq = ack.seq;
            espnowAckResult = ack.result;
            espnowAckReceived = true;
        }
        Serial.printf("[LORA-ACK] seq=%u result=%u callActive=%u\n",
                      (unsigned)ack.seq, ack.result, ack.callActive);
        return;
    }

    if (strcmp(tokens[0], "CFG") == 0 && n >= 11) {
        if (strncmp(tokens[1], deviceId.c_str(), 12) != 0) return;
        EspNowConfigFrame cfg = {};
        cfg.msgType = ESPNOW_MSG_CONFIG;
        cfg.seq = (uint32_t)strtoul(tokens[2], nullptr, 10);
        cfg.applyBrightness = (uint8_t)atoi(tokens[3]);
        cfg.brightness = (uint8_t)atoi(tokens[4]);
        cfg.applyAudioAlert = (uint8_t)atoi(tokens[5]);
        cfg.audioAlertEnabled = (uint8_t)atoi(tokens[6]);
        cfg.applyName = (uint8_t)atoi(tokens[7]);
        snprintf(cfg.name, sizeof(cfg.name), "%s", tokens[8]);
        cfg.endCall = (uint8_t)atoi(tokens[9]);
        cfg.targetCallSeq = (uint32_t)strtoul(tokens[10], nullptr, 10);
        snprintf(cfg.deviceId, sizeof(cfg.deviceId), "%s", deviceId.c_str());
        noInterrupts();
        memcpy(&espnowPendingConfig, &cfg, sizeof(EspNowConfigFrame));
        espnowConfigPending = true;
        interrupts();
        return;
    }

    if (strcmp(tokens[0], "TIME") == 0 && n >= 2) {
        uint32_t epochS = (uint32_t)strtoul(tokens[1], nullptr, 10);
        if (epochS > 0) {
            espnowLastAckEpochS = epochS;
            struct timeval tv = { .tv_sec = (time_t)epochS, .tv_usec = 0 };
            settimeofday(&tv, nullptr);
        }
        return;
    }
}

void pollLora() {
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
}

bool sendCallFrameOverLora(const EspNowCallFrame& frame) {
    if (!loraBridgeReady) return false;
    char line[LORA_LINE_MAX];
    if (frame.msgType == ESPNOW_MSG_CALL_START)
        snprintf(line, sizeof(line), "CS,%s,%lu,%u,%u", frame.deviceId,
                 (unsigned long)frame.seq, frame.cons, frame.isEmergency);
    else if (frame.msgType == ESPNOW_MSG_CALL_INSIST)
        snprintf(line, sizeof(line), "CI,%s,%lu,%u,%u", frame.deviceId,
                 (unsigned long)frame.seq, frame.cons, frame.isEmergency);
    else
        snprintf(line, sizeof(line), "CE,%s,%lu", frame.deviceId,
                 (unsigned long)frame.seq);
    return lora.sendLine(LORA_GATEWAY_ADDRESS, line);
}
#endif

// Registrar con el gateway a traves de un nodo relay conocido (fallback cuando no hay alcance directo)
bool tryRegisterViaRelay() {
#if ESPNOW_RELAY_ENABLED
    // Buscar mejor peer relay elegible (filtro RSSI + histeresis + menor metrica)
    int curIdx = selectBestRelayPeer(nullptr);
    if (curIdx < 0) return false;

    // Construir RELAY_REQ con REGISTER embebido
    EspNowRelayReqFrame relayReq = {};
    relayReq.msgType  = ESPNOW_MSG_RELAY_REQ;
    relayReq.relaySeq = nextEspNowSeq();
    relayReq.origSeq  = nextEspNowSeq();
    relayReq.ttl      = ESPNOW_RELAY_TTL;
    memcpy(relayReq.origMac,    ownMacBytes, 6);
    memcpy(relayReq.prevHopMac, ownMacBytes, 6);
    snprintf(relayReq.deviceId, sizeof(relayReq.deviceId), "%s", deviceId.c_str());

    // EspNowRegisterFrame (22 bytes) cabe dentro de EspNowCallFrameEmbed (25 bytes)
    EspNowRegisterFrame reg = {};
    reg.msgType  = ESPNOW_MSG_REGISTER;
    reg.seq      = relayReq.origSeq;
    reg.sentAtMs = (uint32_t)millis();
    snprintf(reg.deviceId, sizeof(reg.deviceId), "%s", deviceId.c_str());
    memset(&relayReq.embedded, 0, sizeof(relayReq.embedded));
    memcpy(&relayReq.embedded, &reg, sizeof(reg));

    relayConfirmReceived    = false;
    relayConfirmAnyReceived = false;
    relayConfirmSeq         = 0;
    espnowAckReceived       = false;
    espnowExpectedAckSeq    = relayReq.origSeq;

    // Envia el RELAY_REQ actual al candidato senalado por curIdx (agrega el peer ESP-LORA si hace falta)
    auto sendToCandidate = [&](int idx) {
        const uint8_t* peerMac = relayPeers[idx].mac;
        if (!esp_now_is_peer_exist(peerMac)) {
            esp_now_peer_info_t p = {};
            memcpy(p.peer_addr, peerMac, 6);
            p.channel = configuredEspNowChannel;
            p.encrypt = false;
            esp_now_add_peer(&p);
        }
        memcpy(currentRelayMac, peerMac, 6);
        hasCurrentRelay = true;
        char peerStr[18];
        snprintf(peerStr, sizeof(peerStr), "%02X:%02X:%02X:%02X:%02X:%02X",
                 peerMac[0],peerMac[1],peerMac[2],peerMac[3],peerMac[4],peerMac[5]);
        debugPrintln("Registro via relay: " + String(peerStr) + " metric=" + String(relayPeers[idx].gatewayMetric));
        esp_err_t sendErr = esp_now_send(peerMac, (const uint8_t*)&relayReq, sizeof(relayReq));
            Serial.printf("[AZUL/ORIGEN][RELAY-REG] RELAY_REQ registro -> %s len=%d seq=%u dev=%s sendErr=%d\n",
                      peerStr, (int)sizeof(relayReq), relayReq.origSeq, relayReq.deviceId, (int)sendErr);
    };

    sendToCandidate(curIdx);

    // Esperar RELAY_CONFIRM (el relay node lo envia tras reenviar al gateway con exito).
    // En enlaces marginales (senal debil, cerca del limite de cobertura) un solo intento de
    // ida+vuelta (RELAY_REQ -> relay -> RELAY_CONFIRM) tiene alta probabilidad de perderse por RF,
    // no por logica de codigo. Por eso se reintenta el envio del MISMO RELAY_REQ (mismo origSeq)
    // varias veces dentro de la ventana de espera, en vez de un unico intento silencioso.
    unsigned long t0 = millis();
    unsigned long lastResendMs = t0;
    int resendCount = 0;
    bool broadcastFallbackSent = false;
    while (millis() - t0 < (unsigned long)(ESPNOW_RELAY_CONFIRM_TIMEOUT_MS * 3)) {
        if (espnowAckReceived && espnowAckSeq == relayReq.origSeq &&
            (espnowAckResult == 1 || espnowAckResult == 2)) {
            syncEspNowSeqCounterFromServer();
            espnowServerSynced = true;
            lastGatewayAckMs   = millis();
            espnowExpectedAckSeq = 0;
            return true;
        }
        // NACK explicito del relay (no pudo/no quiso ayudar) -> no seguir esperando a ciegas
        if (relayConfirmAnyReceived && relayConfirmSeq == relayReq.origSeq) {
            debugPrintln("Relay rechazo la solicitud (NACK), abortando espera");
            espnowExpectedAckSeq = 0;
            return false;
        }
        // Si el candidato actual quedo marcado como no disponible (send FAIL confirmado a nivel
        // MAC/802.11 en el callback onEspNowSent), no insistirle: probar otro candidato de inmediato
        // en vez de agotar los 2-3 reintentos contra un peer que ya sabemos que no responde.
        bool currentBlacklisted = (relayPeers[curIdx].blacklistedUntilMs != 0 &&
                                   millis() < relayPeers[curIdx].blacklistedUntilMs);
        if (currentBlacklisted) {
            int nextIdx = selectBestRelayPeer(relayPeers[curIdx].mac);
            if (nextIdx >= 0 && nextIdx != curIdx) {
                debugPrintln("Relay anterior no responde (send FAIL), probando otro candidato...");
                curIdx = nextIdx;
                sendToCandidate(curIdx);
                lastResendMs = millis();
                resendCount = 0;
            } else if (!broadcastFallbackSent) {
                esp_err_t broadcastErr = esp_now_send(ESPNOW_BROADCAST_MAC, (const uint8_t*)&relayReq, sizeof(relayReq));
                hasCurrentRelay = false;
                broadcastFallbackSent = true;
                lastResendMs = millis();
                resendCount = 0;
                Serial.printf("[AZUL/ORIGEN][RELAY-REG] Unicast al nodo fallo; fallback BROADCAST seq=%u sendErr=%d\n",
                              relayReq.origSeq, (int)broadcastErr);
            }
        } else if (resendCount < 2 && (millis() - lastResendMs) >= (unsigned long)ESPNOW_RELAY_CONFIRM_TIMEOUT_MS) {
            // Reintentar envio del RELAY_REQ periodicamente (compensa perdida de paquete por RF
            // en enlaces marginales) mientras aun no hay ninguna respuesta
            const uint8_t* resendTarget = broadcastFallbackSent ? ESPNOW_BROADCAST_MAC : relayPeers[curIdx].mac;
            esp_err_t resendErr = esp_now_send(resendTarget, (const uint8_t*)&relayReq, sizeof(relayReq));
            lastResendMs = millis();
            resendCount++;
            Serial.printf("[AZUL/ORIGEN][RELAY-REG] Reenviando RELAY_REQ registro intento=%d seq=%u destino=%s sendErr=%d\n",
                          resendCount + 1, relayReq.origSeq,
                          broadcastFallbackSent ? "BROADCAST" : "UNICAST", (int)resendErr);
        }
        // Procesar nuevos peers durante la espera
        if (espnowPeerMacPending) {
            uint8_t mac[6]; int8_t rssi; uint8_t metric;
            noInterrupts();
            memcpy(mac, espnowPendingPeerMac, 6);
            rssi   = espnowPendingPeerRssi;
            metric = espnowPendingPeerMetric;
            espnowPeerMacPending = false;
            interrupts();
            updateRelayPeer(mac, rssi, metric);
        }
        delay(10);
    }
    debugPrintln("Timeout esperando RELAY_CONFIRM para registro");
    espnowExpectedAckSeq = 0;
    return false;
#else
    return false;
#endif
}

bool sendRegisterEspNow() {
    if (!espnowBridgeReady) return false;
    EspNowRegisterFrame reg = {};
    reg.msgType  = ESPNOW_MSG_REGISTER;
    reg.seq      = nextEspNowSeq();
    reg.sentAtMs = millis();
    snprintf(reg.deviceId, sizeof(reg.deviceId), "%s", deviceId.c_str());
    espnowAckReceived = false; espnowAckSeq = 0; espnowAckResult = 0;
    espnowExpectedAckSeq = reg.seq;
#if USE_LORA_TRANSPORT
    char regLine[LORA_LINE_MAX];
    snprintf(regLine, sizeof(regLine), "REG,%s,%lu", reg.deviceId, (unsigned long)reg.seq);
    lora.sendLine(LORA_GATEWAY_ADDRESS, regLine);
    unsigned long t0 = millis();
    while (millis() - t0 < ESPNOW_ACK_TIMEOUT_MS) {
        pollLora();
        if (espnowAckReceived && espnowAckSeq == reg.seq) {
            bool ok = (espnowAckResult == 1 || espnowAckResult == 2);
            debugPrintln(ok ? "Registro LoRa confirmado" : "Registro LoRa rechazado");
            espnowServerSynced = ok;
            if (ok) {
                syncEspNowSeqCounterFromServer();
                lastGatewayAckMs = millis();
                lastDirectGatewayAckMs = millis();
            }
            espnowExpectedAckSeq = 0;
            return ok;
        }
        delay(5);
    }
    debugPrintln("Timeout esperando ACK de registro LoRa");
    espnowServerSynced = false;
    espnowExpectedAckSeq = 0;
    return false;
#else
    if (esp_now_send(espnowGatewayMac, (const uint8_t*)&reg, sizeof(reg)) != ESP_OK) {
        debugPrintln("ESP-LORA register send fallo");
        espnowExpectedAckSeq = 0;
        return false;
    }
    unsigned long t0 = millis();
    while (millis() - t0 < ESPNOW_ACK_TIMEOUT_MS) {
        if (espnowAckReceived && espnowAckSeq == reg.seq) {
            bool ok = (espnowAckResult == 1 || espnowAckResult == 2);
            debugPrintln(ok ? "Registro ESP-LORA confirmado" : "Registro ESP-LORA rechazado");
            espnowServerSynced = ok;
            if (ok) {
                syncEspNowSeqCounterFromServer();
                lastGatewayAckMs = millis();
                lastDirectGatewayAckMs = millis();
            } // Registro directo (no via relay)
            espnowExpectedAckSeq = 0;
            return ok;
        }
        delay(5);
    }
    debugPrintln("Timeout esperando ACK de registro ESP-LORA");
    espnowServerSynced = false;
    espnowExpectedAckSeq = 0;
    return false;
#endif
}

// ---- Actualizar tabla de peers relay ----
void updateRelayPeer(const uint8_t mac[6], int8_t rssi, uint8_t metric) {
    // Buscar entrada existente
    for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
        if (relayPeers[i].active && memcmp(relayPeers[i].mac, mac, 6) == 0) {
            relayPeers[i].lastSeenMs = millis();
            relayPeers[i].rssi       = rssi;
            // Promedio movil exponencial: suaviza el ruido de +-10-15dB visto en campo
            relayPeers[i].smoothedRssi = (relayPeers[i].smoothedRssi == 0.0f)
                ? (float)rssi
                : (RELAY_RSSI_SMOOTH_ALPHA * rssi + (1.0f - RELAY_RSSI_SMOOTH_ALPHA) * relayPeers[i].smoothedRssi);
            relayPeers[i].gatewayMetric = metric;
            relayPeers[i].eligible      = (relayPeers[i].smoothedRssi >= RELAY_RSSI_MIN_THRESHOLD);
            return;
        }
    }
    // Buscar slot libre; si no hay, reemplazar el mas antiguo
    int slot = -1;
    unsigned long oldest = ULONG_MAX;
    int oldestIdx = 0;
    for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
        if (!relayPeers[i].active) { slot = i; break; }
        if (relayPeers[i].lastSeenMs < oldest) { oldest = relayPeers[i].lastSeenMs; oldestIdx = i; }
    }
    if (slot < 0) slot = oldestIdx;
    relayPeers[slot].active        = true;
    relayPeers[slot].lastSeenMs    = millis();
    relayPeers[slot].rssi          = rssi;
    relayPeers[slot].smoothedRssi  = (float)rssi; // primera lectura, sin historial
    relayPeers[slot].gatewayMetric = metric;
    relayPeers[slot].eligible      = (rssi >= RELAY_RSSI_MIN_THRESHOLD);
    relayPeers[slot].blacklistedUntilMs = 0; // slot reciclado para un peer nuevo: sin historial de fallos
    memcpy(relayPeers[slot].mac, mac, 6);
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    debugPrintln("Relay peer: " + String(macStr) + " metric=" + String(metric) +
                 " rssi=" + String(rssi) + " eligible=" + String(relayPeers[slot].eligible));
}

// Devuelve el indice del mejor peer relay elegible, o -1 si no hay ninguno.
// excludeMac: para no volver atras en cadenas multi-salto (pasa nullptr si no aplica)
int selectBestRelayPeer(const uint8_t* excludeMac) {
    int     bestIdx  = -1;
    uint8_t bestMet  = 99;
    float   bestRssi = -127.0f;
    unsigned long now = millis();

    for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
        if (!relayPeers[i].active) continue;
        if ((now - relayPeers[i].lastSeenMs) >= (unsigned long)ESPNOW_RELAY_STALE_MS) continue;
        if (relayPeers[i].blacklistedUntilMs != 0 && now < relayPeers[i].blacklistedUntilMs) continue; // send FAIL reciente
        if (!relayPeers[i].eligible) continue; // Filtro: descarta senal debil ANTES de mirar metric
        if (excludeMac && memcmp(relayPeers[i].mac, excludeMac, 6) == 0) continue;

        // Entre los elegibles, prioriza metric; RSSI suavizado desempata
        if (relayPeers[i].gatewayMetric < bestMet ||
            (relayPeers[i].gatewayMetric == bestMet && relayPeers[i].smoothedRssi > bestRssi)) {
            bestMet  = relayPeers[i].gatewayMetric;
            bestRssi = relayPeers[i].smoothedRssi;
            bestIdx  = i;
        }
    }

    // Fallback: si NINGUN peer paso el filtro de elegibilidad (senal >= RELAY_RSSI_MIN_THRESHOLD),
    // no dejar al terminal totalmente sin ruta. Es preferible una ruta con senal debil que ninguna
    // ruta (esto es exactamente el caso de un terminal en el borde de cobertura, que es cuando MAS
    // necesita el relay). Se repite la busqueda sin el filtro "eligible", solo exigiendo que el
    // peer tenga una ruta valida conocida (gatewayMetric < 99).
    if (bestIdx < 0) {
        for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
            if (!relayPeers[i].active) continue;
            if ((now - relayPeers[i].lastSeenMs) >= (unsigned long)ESPNOW_RELAY_STALE_MS) continue;
            if (relayPeers[i].blacklistedUntilMs != 0 && now < relayPeers[i].blacklistedUntilMs) continue; // send FAIL reciente
            if (relayPeers[i].gatewayMetric >= 99) continue; // sin ruta conocida, no sirve ni de fallback
            if (excludeMac && memcmp(relayPeers[i].mac, excludeMac, 6) == 0) continue;

            if (relayPeers[i].gatewayMetric < bestMet ||
                (relayPeers[i].gatewayMetric == bestMet && relayPeers[i].smoothedRssi > bestRssi)) {
                bestMet  = relayPeers[i].gatewayMetric;
                bestRssi = relayPeers[i].smoothedRssi;
                bestIdx  = i;
            }
        }
        if (bestIdx >= 0) {
            Serial.printf("[RELAY] Sin candidato con senal fuerte (>= %ddBm); usando fallback debil %02X:%02X:%02X:%02X:%02X:%02X rssi=%.1f metric=%d\n",
                          RELAY_RSSI_MIN_THRESHOLD,
                          relayPeers[bestIdx].mac[0], relayPeers[bestIdx].mac[1], relayPeers[bestIdx].mac[2],
                          relayPeers[bestIdx].mac[3], relayPeers[bestIdx].mac[4], relayPeers[bestIdx].mac[5],
                          relayPeers[bestIdx].smoothedRssi, relayPeers[bestIdx].gatewayMetric);
        }
    }

    // Histeresis: si ya hay un relay activo y sigue siendo valido, solo cambiar
    // si el nuevo candidato es CLARAMENTE mejor (evita oscilar entre 2 candidatos similares)
    if (hasCurrentRelay && bestIdx >= 0) {
        for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
            if (relayPeers[i].active && memcmp(relayPeers[i].mac, currentRelayMac, 6) == 0
                && relayPeers[i].eligible
                && (now - relayPeers[i].lastSeenMs) < (unsigned long)ESPNOW_RELAY_STALE_MS
                && !(relayPeers[i].blacklistedUntilMs != 0 && now < relayPeers[i].blacklistedUntilMs)) {

                bool metricMuchBetter = (relayPeers[bestIdx].gatewayMetric + RELAY_METRIC_HYSTERESIS) < relayPeers[i].gatewayMetric;
                bool rssiMuchBetter   = (relayPeers[bestIdx].gatewayMetric == relayPeers[i].gatewayMetric) &&
                                         (relayPeers[bestIdx].smoothedRssi > relayPeers[i].smoothedRssi + RELAY_RSSI_HYSTERESIS_DB);

                if (!metricMuchBetter && !rssiMuchBetter) {
                    return i; // Quedarse con el relay actual, la mejora no es suficiente
                }
                break;
            }
        }
    }

    return bestIdx;
}

// Devuelve una etiqueta corta y legible de la ruta actual hacia el gateway,
// para usar en los logs de serial (ej. "DIRECTO" o "RELAY->AA:BB metric=2").
String currentRouteLabel() {
    if (myGatewayMetric == 0) return "DIRECTO->gateway";
    if (hasCurrentRelay) {
        char buf[40];
        snprintf(buf, sizeof(buf), "RELAY->%02X:%02X:%02X:%02X:%02X:%02X (metric=%d)",
                 currentRelayMac[0], currentRelayMac[1], currentRelayMac[2],
                 currentRelayMac[3], currentRelayMac[4], currentRelayMac[5], myGatewayMetric);
        return String(buf);
    }
    if (myGatewayMetric < 99) return "RELAY (metric=" + String(myGatewayMetric) + ", nodo aun no confirmado)";
    return "SIN RUTA (ni directo ni relay disponible)";
}

// Recomputa la metrica propia hacia el gateway (Bellman-Ford: min(vecino)+1)
void computeAndUpdateMyMetric() {
    uint8_t previousMetric = myGatewayMetric;

    // IMPORTANTE: usar lastDirectGatewayAckMs (NO lastGatewayAckMs) aqui. lastGatewayAckMs se
    // actualiza tambien cuando el gateway se alcanza VIA RELAY, y si usaramos ese valor aqui,
    // justo despues de un envio exitoso por relay esta funcion concluiria erroneamente que hay
    // ruta DIRECTA (metric=0), haciendo que el siguiente envio intente ir directo, falle por
    // timeout/reintentos, y recien despues vuelva a caer a relay: un ciclo de oscilacion que
    // desperdicia tiempo y hace parecer que el relay "no funciona".
    if (lastDirectGatewayAckMs > 0 && (millis() - lastDirectGatewayAckMs) < (unsigned long)GATEWAY_LOST_TIMEOUT_MS) {
        myGatewayMetric = 0;
        if (previousMetric != 0) {
            hasCurrentRelay = false; // Volvimos a ruta directa: el relay anterior ya no aplica
            Serial.printf("[RUTA] Cambio de ruta: ahora DIRECTO->gateway (antes metric=%d)\n", previousMetric);
        }
        return;
    }
    uint8_t best = 99;
    unsigned long now = millis();
    for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
        if (!relayPeers[i].active) continue;
        if (!relayPeers[i].eligible) continue; // No contar vecinos con senal debil en la metrica
        if ((now - relayPeers[i].lastSeenMs) >= (unsigned long)ESPNOW_RELAY_STALE_MS) continue;
        if (relayPeers[i].gatewayMetric < best) best = relayPeers[i].gatewayMetric;
    }
    myGatewayMetric = (best < 99) ? (uint8_t)(best + 1) : 99;

    if (myGatewayMetric != previousMetric) {
        if (myGatewayMetric >= 99) {
            Serial.println("[RUTA] Cambio de ruta: SIN RUTA (ni directo ni relay disponible)");
        } else {
            Serial.printf("[RUTA] Cambio de ruta: metric %d -> %d (%s)\n",
                          previousMetric, myGatewayMetric,
                          hasCurrentRelay ? currentRouteLabel().c_str() : "buscando nodo relay...");
        }
    }
}

// ---- Procesar RELAY_REQ pendiente (llamado desde loop, seguro para esp_now_send) ----
void processRelayReq(const EspNowRelayReqFrame& req) {
    if (req.ttl == 0) return;

    // Reconstruir call frame desde embedded
    EspNowCallFrame fwd = {};
    memcpy(&fwd, &req.embedded, sizeof(EspNowCallFrameEmbed));

    Serial.printf("[ROJO/NODO][RELAY-NODE] Procesando seq=%u dev=%s embeddedType=%u TTL=%d\n",
                  req.origSeq, req.deviceId, fwd.msgType, req.ttl);

    const char* relayCallEvent = nullptr;
    if (fwd.msgType == ESPNOW_MSG_CALL_START) relayCallEvent = "INICIO";
    else if (fwd.msgType == ESPNOW_MSG_CALL_INSIST) relayCallEvent = "INSISTENCIA";
    else if (fwd.msgType == ESPNOW_MSG_CALL_END) relayCallEvent = "FIN";

    if (relayCallEvent != nullptr) {
        char relayNotice[80];
        snprintf(relayNotice, sizeof(relayNotice),
                 "[RELAY] %s | MAC: %02X:%02X:%02X:%02X:%02X:%02X | Seq: %u",
                 relayCallEvent,
                 req.origMac[0], req.origMac[1], req.origMac[2],
                 req.origMac[3], req.origMac[4], req.origMac[5], req.origSeq);
        debugPrintln(String(relayNotice));
    }

    // Helper: agregar peer temporal si no existe
    auto addPeerIfNeeded = [](const uint8_t* mac) {
        if (!esp_now_is_peer_exist(mac)) {
            esp_now_peer_info_t p = {};
            memcpy(p.peer_addr, mac, 6);
            p.channel = configuredEspNowChannel;
            p.encrypt = false;
            esp_now_add_peer(&p);
        }
    };

    bool directRouteFresh = myGatewayMetric == 0 && lastDirectGatewayAckMs != 0 &&
                            (millis() - lastDirectGatewayAckMs) < ESPNOW_RELAY_STALE_MS;
    esp_err_t sendErr = ESP_FAIL;
    if (directRouteFresh) {
        sendErr = esp_now_send(espnowGatewayMac, (const uint8_t*)&fwd, sizeof(EspNowCallFrame));
        Serial.printf("[ROJO/NODO][RELAY-NODE] Forward gateway seq=%u sendErr=%d\n", req.origSeq, (int)sendErr);
    }

    if (directRouteFresh && sendErr == ESP_OK) {
        // No confirmar aqui: ESP_OK solo significa que el driver encolo el frame.
        // El ACK definitivo lo genera el servidor local despues de persistir el evento
        // y vuelve al origen mediante relayReverseRoutes.
        Serial.printf("[ROJO/NODO][RELAY-NODE] Encolado hacia gateway seq=%u; esperando ACK servidor\n", req.origSeq);
    } else if (req.ttl > 1) {
        // Sin ruta directa confirmada (o fallo inmediato) y TTL permite otro salto:
        // reenviar al mejor vecino que anuncie una metrica menor.
        // (filtro RSSI + histeresis + menor metrica), excluyendo prevHop para no volver atras
        int bestIdx = selectBestRelayPeer(req.prevHopMac);
        uint8_t nextHop[6];
        if (bestIdx >= 0) {
            memcpy(nextHop, relayPeers[bestIdx].mac, 6);
            addPeerIfNeeded(nextHop);
            Serial.printf("[RELAY-NODE] Re-relay unicast→%02X:%02X metric=%d TTL=%d→%d seq=%u\n",
                          nextHop[4], nextHop[5], relayPeers[bestIdx].gatewayMetric, req.ttl, req.ttl - 1, req.origSeq);
        } else {
            memcpy(nextHop, ESPNOW_BROADCAST_MAC, 6);
            Serial.printf("[RELAY-NODE] Re-relay broadcast (sin peer elegible con ruta) TTL=%d seq=%u\n",
                          req.ttl, req.origSeq);
        }
        // Guardar en hop table para reenviar el confirm cuando llegue
        int slot = -1;
        unsigned long oldest = ULONG_MAX;
        int oldestIdx = 0;
        for (int i = 0; i < RELAY_HOP_TABLE_SIZE; i++) {
            if (!relayHopTable[i].active) { slot = i; break; }
            if (relayHopTable[i].createdAt < oldest) { oldest = relayHopTable[i].createdAt; oldestIdx = i; }
        }
        if (slot < 0) { relayHopTable[oldestIdx].active = false; slot = oldestIdx; }
        relayHopTable[slot].active    = true;
        relayHopTable[slot].origSeq   = req.origSeq;
        relayHopTable[slot].createdAt = millis();
        memcpy(relayHopTable[slot].prevHopMac, req.prevHopMac, 6);
        // Re-enviar con TTL-1 y mi MAC como nuevo prevHopMac
        EspNowRelayReqFrame subReq = req;
        subReq.ttl      = req.ttl - 1;
        subReq.relaySeq = nextEspNowSeq();
        memcpy(subReq.prevHopMac, ownMacBytes, 6);
        esp_now_send(nextHop, (const uint8_t*)&subReq, sizeof(subReq));

    } else {
        // TTL=1 y sin gateway → confirm de fallo al hop previo
        Serial.printf("[RELAY-NODE] TTL agotado, sin gateway, seq=%u\n", req.origSeq);
        EspNowRelayConfirmFrame confirm = {};
        confirm.msgType = ESPNOW_MSG_RELAY_CONFIRM;
        confirm.origSeq = req.origSeq;
        confirm.result  = 0;
        strncpy(confirm.deviceId, req.deviceId, 12);
        confirm.deviceId[12] = '\0';
        addPeerIfNeeded(req.prevHopMac);
        esp_now_send(req.prevHopMac, (const uint8_t*)&confirm, sizeof(confirm));
    }
}

// ---- Encolar frame de llamada (no bloqueante — retorna inmediatamente) ----
bool enqueueEspNowFrame(bool active, int consecutive, const char* call_type) {
    if (!espnowBridgeReady) { debugPrintln("ESP-LORA bridge no listo"); return false; }
    int nextTail = (txQueueTail + 1) % ESPNOW_TX_QUEUE_SIZE;
    if (nextTail == txQueueHead) {
        debugPrintln("TX queue llena, descartando frame");
        return false;
    }
    EspNowCallFrame frame = {};
    frame.msgType     = active ? (consecutive <= 1 ? ESPNOW_MSG_CALL_START : ESPNOW_MSG_CALL_INSIST)
                                : ESPNOW_MSG_CALL_END;
    frame.seq         = nextEspNowSeq();
    frame.sentAtMs    = millis();
    frame.cons        = (uint16_t)max(consecutive, 0);
    frame.isEmergency = (strcmp(call_type, CALL_TYPE_EMERGENCY) == 0) ? 1 : 0;
    snprintf(frame.deviceId, sizeof(frame.deviceId), "%s", deviceId.c_str());
    if (frame.msgType == ESPNOW_MSG_CALL_START) currentCallStartSeq = frame.seq;

    EspNowTxItem& slot = espnowTxQueue[txQueueTail];
    slot.active   = true;
    slot.seq      = frame.seq;
    slot.retries  = 0;
    slot.sentAtMs = 0;
    slot.frameLen = sizeof(EspNowCallFrame);
    memcpy(slot.frame, &frame, sizeof(EspNowCallFrame));
    txQueueTail = nextTail;
    debugPrintln("TX encolado seq=" + String(frame.seq) +
                 " tipo=" + String(frame.msgType));
    return true;  // Encolado OK; entrega confirmada de forma asincrona
}

// ---- Intentar relay para el item actual de la cola ----
void tryRelayForCurrentItem() {
#if ESPNOW_RELAY_ENABLED
    if (txQueueHead == txQueueTail) { espnowTxState = TX_IDLE; return; }
    EspNowTxItem& item = espnowTxQueue[txQueueHead];

    // Log: mostrar candidatos relay conocidos
    int knownPeers = 0;
    unsigned long now = millis();
    for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
        if (relayPeers[i].active &&
            (now - relayPeers[i].lastSeenMs) < ESPNOW_RELAY_STALE_MS) {
            knownPeers++;
            Serial.printf("[RELAY-TX] Candidato relay #%d: %02X:%02X:%02X:%02X:%02X:%02X (visto hace %lums)\n",
                          knownPeers,
                          relayPeers[i].mac[0], relayPeers[i].mac[1], relayPeers[i].mac[2],
                          relayPeers[i].mac[3], relayPeers[i].mac[4], relayPeers[i].mac[5],
                          now - relayPeers[i].lastSeenMs);
        }
    }
    if (knownPeers == 0) {
        Serial.println("[RELAY-TX] Sin candidatos relay conocidos, broadcasteando igual");
    } else {
        Serial.printf("[RELAY-TX] Buscando nodo relay para seq=%u (%d candidatos conocidos)\n",
                      item.seq, knownPeers);
    }

    EspNowRelayReqFrame relayReq = {};
    relayReq.msgType  = ESPNOW_MSG_RELAY_REQ;
    relayReq.relaySeq = nextEspNowSeq();
    relayReq.origSeq  = item.seq;
    relayReq.ttl      = ESPNOW_RELAY_TTL;
    WiFi.macAddress(relayReq.origMac);
    memcpy(relayReq.prevHopMac, ownMacBytes, 6); // Primer salto: yo soy el prevHop
    snprintf(relayReq.deviceId, sizeof(relayReq.deviceId), "%s", deviceId.c_str());
    // Copiar frame embebido (mismo layout que EspNowCallFrameEmbed)
    memcpy(&relayReq.embedded, item.frame, sizeof(EspNowCallFrameEmbed));
    relayConfirmReceived    = false;
    relayConfirmAnyReceived = false;
    relayConfirmSeq         = 0;
    espnowAckReceived       = false;
    espnowExpectedAckSeq    = item.seq;

    // Grafo de ruta: elegir mejor peer elegible (filtro RSSI + histeresis + menor metrica)
    int bestPeerIdx = selectBestRelayPeer(nullptr);
    uint8_t targetMac[6];
    if (bestPeerIdx >= 0) {
        memcpy(targetMac, relayPeers[bestPeerIdx].mac, 6);
        if (!esp_now_is_peer_exist(targetMac)) {
            esp_now_peer_info_t p = {};
            memcpy(p.peer_addr, targetMac, 6);
            p.channel = configuredEspNowChannel;
            p.encrypt = false;
            esp_now_add_peer(&p);
        }
        memcpy(currentRelayMac, targetMac, 6);
        hasCurrentRelay = true;
        Serial.printf("[RELAY-TX] Unicast (1 solo nodo) →%02X:%02X:%02X:%02X:%02X:%02X metric=%d rssi=%.1f seq=%u\n",
                      targetMac[0], targetMac[1], targetMac[2], targetMac[3], targetMac[4], targetMac[5],
                      relayPeers[bestPeerIdx].gatewayMetric,
                      relayPeers[bestPeerIdx].smoothedRssi, item.seq);
    } else {
        memcpy(targetMac, ESPNOW_BROADCAST_MAC, 6);
        hasCurrentRelay = false;
        Serial.printf("[RELAY-TX] Sin peer elegible con ruta conocida → BROADCAST (puede recibirlo mas de 1 nodo, el primero en confirmar via gateway gana) seq=%u\n", item.seq);
    }

    if (esp_now_send(targetMac, (const uint8_t*)&relayReq, sizeof(relayReq)) == ESP_OK) {
        item.sentAtMs = millis();
        espnowTxState = TX_AWAITING_RELAY;
        lastCallRelayReq   = relayReq;
        memcpy(lastCallRelayTargetMac, targetMac, 6);
        lastCallRelayResent = false;
        lastCallRelayBroadcastFallbackSent = false;
        Serial.printf("[RELAY-TX] RELAY_REQ enviado seq=%u, esperando confirm...\n", item.seq);
    } else {
        Serial.printf("[RELAY-TX] RELAY_REQ FALLO seq=%u; conservado para reintento\n", item.seq);
        espnowCallFrameFailed = true;
        item.retries = 0;
        espnowExpectedAckSeq = 0;
        espnowTxState = TX_IDLE;
    }
#else
    // Relay desactivado: descartar item
    if (espnowTxQueue[txQueueHead].frame[0] == ESPNOW_MSG_CALL_START ||
        espnowTxQueue[txQueueHead].frame[0] == ESPNOW_MSG_CALL_INSIST)
        espnowCallFrameFailed = true;
    espnowTxQueue[txQueueHead].active = false;
    espnowExpectedAckSeq = 0;
    txQueueHead  = (txQueueHead + 1) % ESPNOW_TX_QUEUE_SIZE;
    espnowTxState = TX_IDLE;
    debugPrintln("TX fallo definitivo (relay desactivado)");
#endif
}

// ---- State machine TX: llamar cada iteracion de loop() ----
void processEspNowTx() {
    if (!espnowBridgeReady) return;

    switch (espnowTxState) {

        case TX_IDLE: {
            if (txQueueHead == txQueueTail) return;  // Cola vacia
            EspNowTxItem& item = espnowTxQueue[txQueueHead];
            if (!item.active) {
                txQueueHead = (txQueueHead + 1) % ESPNOW_TX_QUEUE_SIZE;
                return;
            }

            // Si ya sabemos por heartbeat/metrica que el gateway esta lejos o su
            // ultimo RSSI directo fue debil, saltar directo a relay sin agotar
            // reintentos directos (evita perder tiempo contra un enlace que ya sabemos que falla)
            bool gatewayLikelyUnreachable =
                (myGatewayMetric > 0) ||
                (gatewayRssi != -100 && gatewayRssi < RELAY_RSSI_MIN_THRESHOLD);

            if (gatewayLikelyUnreachable) {
                debugPrintln("Gateway lejano/debil (metric=" + String(myGatewayMetric) +
                             " rssi=" + String(gatewayRssi) + "), saltando a relay directamente");
                tryRelayForCurrentItem();
                return;
            }

            espnowAckReceived = false;
            espnowExpectedAckSeq = item.seq;
#if USE_LORA_TRANSPORT
            EspNowCallFrame f = {};
            memcpy(&f, item.frame, sizeof(f));
            if (sendCallFrameOverLora(f)) {
#else
            if (esp_now_send(espnowGatewayMac, item.frame, item.frameLen) == ESP_OK) {
#endif
                item.sentAtMs = millis();
                espnowTxState = TX_AWAITING_ACK;
                Serial.printf("[TX] Enviando seq=%u retry=%d via DIRECTO->gateway\n",
                              item.seq, item.retries);
            } else {
                item.retries++;
                if (item.retries >= ESPNOW_MAX_RETRIES) tryRelayForCurrentItem();
                // Si hay reintentos disponibles se intenta en la proxima iteracion
            }
            break;
        }

        case TX_AWAITING_ACK: {
            if (txQueueHead == txQueueTail) { espnowTxState = TX_IDLE; return; }
            EspNowTxItem& item = espnowTxQueue[txQueueHead];
            // ACK recibido y coincide con el seq esperado
            if (espnowAckReceived && espnowAckSeq == item.seq) {
                bool ok = (espnowAckResult == 1 || espnowAckResult == 2);
                if (ok) {
                    lastGatewayAckMs       = millis();
                    lastDirectGatewayAckMs = millis(); // ACK directo confirmado (sin relay)
                    espnowServerSynced     = true;
                    Serial.printf("[TX] ACK %s seq=%u vía DIRECTO->gateway (1 solo salto, sin nodos intermedios)\n",
                                  espnowAckResult == 2 ? "DUPLICATE" : "OK", item.seq);
                } else {
                    debugPrintln("TX ACK invalido seq=" + String(item.seq));
                }
                item.active   = false;
                espnowExpectedAckSeq = 0;
                txQueueHead   = (txQueueHead + 1) % ESPNOW_TX_QUEUE_SIZE;
                espnowTxState = TX_IDLE;
                return;
            }
            // Timeout de ACK
            if (millis() - item.sentAtMs >= ESPNOW_ACK_TIMEOUT_MS) {
                item.retries++;
                if (item.retries < ESPNOW_MAX_RETRIES) {
                    // Reintento directo
                    espnowAckReceived = false;
#if USE_LORA_TRANSPORT
                    EspNowCallFrame f2 = {};
                    memcpy(&f2, item.frame, sizeof(f2));
                    if (sendCallFrameOverLora(f2)) {
#else
                    if (esp_now_send(espnowGatewayMac, item.frame, item.frameLen) == ESP_OK) {
#endif
                        item.sentAtMs = millis();
                        debugPrintln("TX reintento " + String(item.retries) +
                                     " seq=" + String(item.seq));
                    }
                    // Si falla el send, se volvera a intentar en la proxima iteracion
                } else {
                    // Reintentos directos agotados → intentar relay
                    tryRelayForCurrentItem();
                }
            }
            break;
        }

        case TX_AWAITING_RELAY: {
            if (txQueueHead == txQueueTail) { espnowTxState = TX_IDLE; return; }
            EspNowTxItem& item = espnowTxQueue[txQueueHead];
            if (espnowAckReceived && espnowAckSeq == item.seq &&
                (espnowAckResult == 1 || espnowAckResult == 2)) {
                Serial.printf("[RELAY-TX] RUTA OK (~%d salto/s) seq=%u : yo(%s) -> relay(%02X:%02X:%02X:%02X:%02X:%02X) -> ... -> gateway\n",
                              myGatewayMetric, item.seq, deviceId.c_str(),
                              relayConfirmMac[0], relayConfirmMac[1], relayConfirmMac[2],
                              relayConfirmMac[3], relayConfirmMac[4], relayConfirmMac[5]);
                // RELAY_CONFIRM exitoso: el gateway recibio el frame via relay → actualizar conectividad
                lastGatewayAckMs   = millis();
                espnowServerSynced = true;
                espnowAckReceived      = false;
                relayConfirmReceived   = false;
                relayConfirmAnyReceived = false;
                item.active   = false;
                espnowExpectedAckSeq = 0;
                txQueueHead   = (txQueueHead + 1) % ESPNOW_TX_QUEUE_SIZE;
                espnowTxState = TX_IDLE;
                return;
            }
            // NACK explicito (el nodo relay no pudo/no quiso ayudar) -> no esperar el timeout completo
            if (relayConfirmAnyReceived && relayConfirmSeq == item.seq) {
                Serial.printf("[RELAY-TX] Relay rechazo seq=%u; conservado para reintento directo\n", item.seq);
                espnowCallFrameFailed = true;
                relayConfirmAnyReceived = false;
                item.retries = 0;
                espnowExpectedAckSeq = 0;
                espnowTxState = TX_IDLE;
                return;
            }
            // Reenviar una vez el mismo RELAY_REQ a mitad de la ventana si aun no hay respuesta
            // (compensa perdida de paquete por RF en enlaces marginales, en vez de agotar el
            // timeout completo con un unico intento de ida+vuelta)
            bool unicastTargetFailed =
                memcmp(lastCallRelayTargetMac, ESPNOW_BROADCAST_MAC, 6) != 0 &&
                hasCurrentRelay;
            if (unicastTargetFailed) {
                for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
                    if (relayPeers[i].active && memcmp(relayPeers[i].mac, lastCallRelayTargetMac, 6) == 0) {
                        unicastTargetFailed = (relayPeers[i].blacklistedUntilMs != 0 && millis() < relayPeers[i].blacklistedUntilMs);
                        break;
                    }
                }
            }
            if (unicastTargetFailed && !lastCallRelayBroadcastFallbackSent) {
                esp_err_t broadcastErr = esp_now_send(ESPNOW_BROADCAST_MAC, (const uint8_t*)&lastCallRelayReq, sizeof(lastCallRelayReq));
                memcpy(lastCallRelayTargetMac, ESPNOW_BROADCAST_MAC, 6);
                hasCurrentRelay = false;
                Serial.printf("[RELAY-TX] Unicast al nodo fallo; fallback BROADCAST seq=%u sendErr=%d\n",
                              item.seq, (int)broadcastErr);
                lastCallRelayBroadcastFallbackSent = true;
                lastCallRelayResent = false;
                item.sentAtMs = millis();
                break;
            }
            if (!lastCallRelayResent &&
                lastCallRelayReq.origSeq == item.seq &&
                (millis() - item.sentAtMs) >= (unsigned long)(ESPNOW_RELAY_CONFIRM_TIMEOUT_MS / 2)) {
                esp_now_send(lastCallRelayTargetMac, (const uint8_t*)&lastCallRelayReq, sizeof(lastCallRelayReq));
                lastCallRelayResent = true;
                Serial.printf("[RELAY-TX] Reenviando RELAY_REQ seq=%u (sin respuesta aun)\n", item.seq);
            }
            if (millis() - item.sentAtMs >= ESPNOW_RELAY_CONFIRM_TIMEOUT_MS) {
                Serial.printf("[RELAY-TX] Timeout relay seq=%u; evento conservado para reintento\n", item.seq);
                espnowCallFrameFailed = true;
                relayConfirmReceived    = false;
                relayConfirmAnyReceived = false;
                item.retries = 0;
                espnowExpectedAckSeq = 0;
                espnowTxState = TX_IDLE;
            }
            break;
        }
    }
}

bool updateCall(bool active, int consecutive = 0, const char* call_type = CALL_TYPE_NORMAL, bool updateTimestamp = true) {
    (void)updateTimestamp;
    debugPrintln(String(active ? "ACTIVAR" : "FINALIZAR") + " llamada -> ESP-LORA queue");
    return enqueueEspNowFrame(active, consecutive, call_type);
}

void sendHeartbeatEspNow() {
    if (!espnowBridgeReady) return;
    EspNowCallFrame frame = {};
    frame.msgType  = ESPNOW_MSG_HEARTBEAT;
    frame.seq      = nextEspNowSeq();
    frame.sentAtMs = millis();
    frame.cons     = (uint16_t)myGatewayMetric; // Propagar metrica de ruta a vecinos
    frame.isEmergency = 0;
    snprintf(frame.deviceId, sizeof(frame.deviceId), "%s", deviceId.c_str());
#if USE_LORA_TRANSPORT
    char line[LORA_LINE_MAX];
    snprintf(line, sizeof(line), "HB,%s,%lu", frame.deviceId, (unsigned long)frame.seq);
    lora.sendLine(LORA_GATEWAY_ADDRESS, line);
#else
    bool directRouteFresh = myGatewayMetric == 0 && lastDirectGatewayAckMs != 0 &&
                            (millis() - lastDirectGatewayAckMs) < ESPNOW_RELAY_STALE_MS;
    if (directRouteFresh) {
        esp_now_send(espnowGatewayMac, (const uint8_t*)&frame, sizeof(frame));
    }
#if ESPNOW_RELAY_ENABLED
    else {
        int relayIdx = selectBestRelayPeer(nullptr);
        if (relayIdx >= 0) {
            const uint8_t* relayMac = relayPeers[relayIdx].mac;
            if (!esp_now_is_peer_exist(relayMac)) {
                esp_now_peer_info_t peer = {};
                memcpy(peer.peer_addr, relayMac, 6);
                peer.channel = configuredEspNowChannel;
                peer.encrypt = false;
                esp_now_add_peer(&peer);
            }
            EspNowRelayReqFrame relayReq = {};
            relayReq.msgType  = ESPNOW_MSG_RELAY_REQ;
            relayReq.relaySeq = nextEspNowSeq();
            relayReq.origSeq  = frame.seq;
            relayReq.ttl      = ESPNOW_RELAY_TTL;
            memcpy(relayReq.origMac, ownMacBytes, 6);
            memcpy(relayReq.prevHopMac, ownMacBytes, 6);
            snprintf(relayReq.deviceId, sizeof(relayReq.deviceId), "%s", deviceId.c_str());
            memcpy(&relayReq.embedded, &frame, sizeof(EspNowCallFrameEmbed));
            esp_now_send(relayMac, (const uint8_t*)&relayReq, sizeof(relayReq));
        }
    }
#endif
#if ESPNOW_RELAY_ENABLED
    // Broadcast para que otros terminales nos descubran como candidato relay
    esp_now_send(ESPNOW_BROADCAST_MAC, (const uint8_t*)&frame, sizeof(frame));
#endif
#endif
    Serial.printf("[HEARTBEAT] seq=%u ruta actual: %s\n", frame.seq, currentRouteLabel().c_str());
}

void sendRemoteConfigAck(uint32_t commandSeq, uint8_t result) {
    if (!espnowBridgeReady || commandSeq == 0) return;

    EspNowCallFrame frame = {};
    frame.msgType = ESPNOW_MSG_CONFIG_ACK;
    frame.seq = commandSeq;
    frame.sentAtMs = millis();
    frame.cons = result;
    snprintf(frame.deviceId, sizeof(frame.deviceId), "%s", deviceId.c_str());

#if USE_LORA_TRANSPORT
    char line[LORA_LINE_MAX];
    snprintf(line, sizeof(line), "CACK,%s,%lu,%u", frame.deviceId, (unsigned long)commandSeq, result);
    lora.sendLine(LORA_GATEWAY_ADDRESS, line);
    return;
#else
    bool directRouteFresh = myGatewayMetric == 0 && lastDirectGatewayAckMs != 0 &&
                            (millis() - lastDirectGatewayAckMs) < ESPNOW_RELAY_STALE_MS;
    if (directRouteFresh) {
        esp_now_send(espnowGatewayMac, (const uint8_t*)&frame, sizeof(frame));
        return;
    }

#if ESPNOW_RELAY_ENABLED
    int relayIdx = selectBestRelayPeer(nullptr);
    if (relayIdx < 0) return;
    const uint8_t* relayMac = relayPeers[relayIdx].mac;
    if (!esp_now_is_peer_exist(relayMac)) {
        esp_now_peer_info_t peer = {};
        memcpy(peer.peer_addr, relayMac, 6);
        peer.channel = configuredEspNowChannel;
        peer.encrypt = false;
        if (esp_now_add_peer(&peer) != ESP_OK) return;
    }

    EspNowRelayReqFrame relayReq = {};
    relayReq.msgType = ESPNOW_MSG_RELAY_REQ;
    relayReq.relaySeq = nextEspNowSeq();
    relayReq.origSeq = commandSeq;
    relayReq.ttl = ESPNOW_RELAY_TTL;
    memcpy(relayReq.origMac, ownMacBytes, 6);
    memcpy(relayReq.prevHopMac, ownMacBytes, 6);
    snprintf(relayReq.deviceId, sizeof(relayReq.deviceId), "%s", deviceId.c_str());
    memcpy(&relayReq.embedded, &frame, sizeof(EspNowCallFrameEmbed));
    esp_now_send(relayMac, (const uint8_t*)&relayReq, sizeof(relayReq));
#endif
#endif
}

// ========================================
// Funciones de Utilidad / Debug
// ========================================
String getISOTimestamp() {
    struct tm timeinfo;
    if (!getLocalTime(&timeinfo, 10)) return "";
    char buf[30];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S-05:00", &timeinfo);
    return String(buf);
}

void debugPrintln(String message) {
    #if ENABLE_SERIAL_DEBUG
    Serial.println(message);
    #endif
    if (monitorSerialEnabled && ui_Labelmonitorserial != NULL) {
        const char* cur = lv_label_get_text(ui_Labelmonitorserial);
        if (cur != NULL && strlen(cur) > 1500) lv_label_set_text(ui_Labelmonitorserial, "");
        String msg = message + "\n";
        lv_label_ins_text(ui_Labelmonitorserial, 0, msg.c_str());
    }
}

void debugPrint(String message) {
    #if ENABLE_SERIAL_DEBUG
    Serial.print(message);
    #endif
}

// ========================================
// Funciones de Display
// ========================================
void setPendingConsecutive(int consecutive) {
    pendingConsecutiveValue = consecutive;
    hasPendingConsecutive = true;
}

void applyPendingConsecutive() {
    if (hasPendingConsecutive && lv_scr_act() == ui_Screen2) {
        updateConsecutiveDisplay(pendingConsecutiveValue);
        hasPendingConsecutive = false;
    }
}

void updateChronometerDisplay() {
    if (chronoActive && ui_cronometro != NULL) {
        unsigned long cur = millis();
        if (chronoRestored && chronoRestoredBase > 0)
            chronoElapsedTime = chronoRestoredBase + (cur - callStartTime);
        else
            chronoElapsedTime = cur - callStartTime;
        unsigned long total = chronoElapsedTime / 1000;
        unsigned long h = total / ONE_HOUR_SECONDS;
        unsigned long m = (total % ONE_HOUR_SECONDS) / 60;
        unsigned long s = total % 60;
        char buf[9];
        snprintf(buf, sizeof(buf), "%02lu:%02lu:%02lu", h, m, s);
        lv_label_set_text(ui_cronometro, buf);
    }
}

void startChronometer() {
    if (!chronoActive) {
        callStartTime = millis(); chronoActive = true;
        chronoRestored = false; chronoRestoredBase = 0;
        chronoElapsedTime = 0;
        if (ui_cronometro != NULL) lv_label_set_text(ui_cronometro, "00:00:00");
        debugPrintln("Cronometro iniciado");
    }
}

void stopChronometer() {
    if (chronoActive) {
        chronoActive = false; chronoElapsedTime = 0;
        chronoRestored = false; chronoRestoredBase = 0;
        if (ui_cronometro != NULL) lv_label_set_text(ui_cronometro, "00:00:00");
        debugPrintln("Cronometro detenido");
    }
}

void updateTimeDisplay() {
    struct tm timeinfo;
    // Timeout de 10ms: si RTC/NTP no tiene hora valida, retorna rapido
    // (el default de 5000ms bloquea todo el loop 5 segundos cada segundo)
    if (getLocalTime(&timeinfo, 10)) {
        char timePart[9], ampm[3];
        strftime(timePart, sizeof(timePart), "%I:%M:%S", &timeinfo);
        strftime(ampm, sizeof(ampm), "%p", &timeinfo);
        if (ui_LabelHora)  lv_label_set_text(ui_LabelHora, timePart);
        if (ui_LabelAMPM)  lv_label_set_text(ui_LabelAMPM, ampm);
        if (ui_LabelHora2) lv_label_set_text(ui_LabelHora2, timePart);
        if (ui_LabelAMPM2) lv_label_set_text(ui_LabelAMPM2, ampm);
    }
}

static const char* rssiQuality(int8_t r) {
    if (r >= -50) return "Excelente";
    if (r >= -70) return "Buena";
    if (r >= -85) return "Aceptable";
    return "Debil";
}

void updateNetworkInfo() {
    String gw   = configuredGatewayMac;
    if (ui_LabelIp)       lv_label_set_text(ui_LabelIp,       "ESP-LORA");
    if (ui_LabelMac)      lv_label_set_text(ui_LabelMac,      deviceId.c_str());
    if (ui_Labelssid)     lv_label_set_text(ui_Labelssid,     "ESP-LORA-MESH");
    if (ui_Labelgatenway) lv_label_set_text(ui_Labelgatenway, gw.c_str());
    if (ui_Labelversion)  lv_label_set_text(ui_Labelversion,  FIRMWARE_VERSION);
    if (ui_Labelrssi) {
        char rssiStr[32];
        if (gatewayRssi == -100) {
            lv_label_set_text(ui_Labelrssi, "Sin señal");
        } else {
            snprintf(rssiStr, sizeof(rssiStr), "%d dBm  %s",
                     (int)gatewayRssi, rssiQuality(gatewayRssi));
            lv_label_set_text(ui_Labelrssi, rssiStr);
        }
    }
    if (ui_LabelRelaypeer) {
        unsigned long now = millis();
        // Primera linea: ruta EN USO ahora mismo (no solo vecinos escuchados)
        String peers = "Ruta: " + currentRouteLabel();
        for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++) {
            if (relayPeers[i].active && (now - relayPeers[i].lastSeenMs) < ESPNOW_RELAY_STALE_MS) {
                bool esElActivo = hasCurrentRelay && memcmp(relayPeers[i].mac, currentRelayMac, 6) == 0;
                char entry[48];
                snprintf(entry, sizeof(entry), "%s%02X:%02X:%02X:%02X:%02X:%02X %ddBm%s",
                    esElActivo ? "> " : "  ",
                    relayPeers[i].mac[0], relayPeers[i].mac[1], relayPeers[i].mac[2],
                    relayPeers[i].mac[3], relayPeers[i].mac[4], relayPeers[i].mac[5],
                    (int)relayPeers[i].rssi,
                    relayPeers[i].eligible ? "" : " (debil)");
                peers += "\n";
                peers += String(entry);
            }
        }
        lv_label_set_text(ui_LabelRelaypeer, peers.c_str());
    }
}

void updateConsecutiveDisplay(int consecutive) {
    char buf[4];
    snprintf(buf, sizeof(buf), "%d", consecutive);
    if (ui_LabelCons1 != NULL) {
        lv_label_set_text(ui_LabelCons1, buf);
        lv_obj_invalidate(ui_LabelCons1);
        lv_timer_handler();
        debugPrintln("Consecutivos: " + String(consecutive));
    }
}

void updateDeviceNameDisplay(String name) {
    if (ui_LabelNombre)  lv_label_set_text(ui_LabelNombre,  name.c_str());
    if (ui_LabelNombre1) lv_label_set_text(ui_LabelNombre1, name.c_str());
    if (ui_LabelNombre2) lv_label_set_text(ui_LabelNombre2, name.c_str());
}

String formatAdmissionDate(String iso) {
    if (iso.length() == 0) return "";
    int t = iso.indexOf('T');
    if (t == -1) return iso;
    String d = iso.substring(0, t);
    String ti = iso.substring(t + 1);
    int z = ti.indexOf('+'); if (z == -1) z = ti.indexOf('-');
    if (z != -1) ti = ti.substring(0, z);
    int dot = ti.indexOf('.'); if (dot != -1) ti = ti.substring(0, dot);
    if (ti.length() > 5) ti = ti.substring(0, 5);
    return d + "  " + ti;
}

void updatePatientInfoDisplay() {
    String display = "";
    if (patientFullName.length() > 0) {
        int s1 = patientFullName.indexOf(' ');
        if (s1 != -1) {
            int s2 = patientFullName.indexOf(' ', s1 + 1);
            if (s2 != -1) {
                int s3 = patientFullName.indexOf(' ', s2 + 1);
                display = patientFullName.substring(0, s1) + " " +
                          (s3 != -1 ? patientFullName.substring(s2+1, s3) : patientFullName.substring(s2+1));
            } else display = patientFullName;
        } else display = patientFullName;
    }
    if (ui_namepaciente)  lv_label_set_text(ui_namepaciente,  display.c_str());
    if (ui_namepaciente1) lv_label_set_text(ui_namepaciente1, display.c_str());
    if (ui_LabelNombrePaciente4) lv_label_set_text(ui_LabelNombrePaciente4, patientFullName.c_str());
    if (ui_LabelEdadPaciente4) {
        String age = (patientAge.length() > 0 && patientAge != "0") ? patientAge + " anos" : "";
        lv_label_set_text(ui_LabelEdadPaciente4, age.c_str());
    }
    if (ui_LabelIngresoFecha4)
        lv_label_set_text(ui_LabelIngresoFecha4, formatAdmissionDate(patientAdmissionDate).c_str());
    if (ui_LabelNotasPaciente4) {
        String notes = patientNotes;
        if (notes.length() > 120) notes = notes.substring(0, 117) + "...";
        lv_label_set_text(ui_LabelNotasPaciente4, notes.c_str());
    }
}

void clearPatientInfo() {
    patientFullName = ""; patientAge = ""; patientAdmissionDate = ""; patientNotes = "";
    updatePatientInfoDisplay();
    debugPrintln("Informacion paciente limpiada");
}

void handleRemoteCallTermination() {
    debugPrintln("LLAMADA FINALIZADA remotamente (ESP-LORA gateway)");
    isCalling = false; isEmergencyCall = false;
    stopChronometer();
    currentConsecutive = 0;
    updateConsecutiveDisplay(0);
    remoteTerminationEffectActive = true;
    remoteTerminationEffectStep = 0;
    remoteTerminationEffectStartTime = millis();
    playFinishSound();
    lv_obj_set_style_opa(uic_led_green, LV_OPA_TRANSP, 0);
    lv_obj_set_style_opa(uic_led_red,   LV_OPA_TRANSP, 0);
    lv_timer_handler();
    if (lv_scr_act() == ui_Screen2)
        _ui_screen_change(&ui_Screen1, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, NULL);
}

// ========================================
// Boot Screen (Screen0)
// ========================================
enum BootResult { BR_PENDING, BR_OK, BR_ERROR };
struct BootRow {
    lv_obj_t *labelName   = nullptr;
    lv_obj_t *labelStatus = nullptr;
    BootResult result      = BR_PENDING;
};
static BootRow boot_create_row(lv_obj_t *parent, const char *name);
static lv_obj_t *scrBoot = nullptr;
static lv_obj_t *bootStatusGlobal = nullptr;
static lv_obj_t *bootProgress = nullptr;
static lv_style_t styleRowName, styleStatusPending, styleStatusOK, styleStatusError;
static bool bootStylesInited = false;
static BootRow bootRowSystem, bootRowWifi, bootRowNTP, bootRowFirebase, bootRowRestore;
static int bootOkCount = 0;
static bool bootFinished = false;
static bool bootTechnicalConfigRequested = false;

static void boot_technical_access_event(lv_event_t *e) {
    static unsigned long pressStartedAt = 0;
    static bool requestSent = false;
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_PRESSED) {
        pressStartedAt = millis();
        requestSent = false;
    } else if (code == LV_EVENT_PRESSING && !requestSent && millis() - pressStartedAt >= 3000) {
        requestSent = true;
        bootTechnicalConfigRequested = true;
    } else if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
        pressStartedAt = 0;
        requestSent = false;
    }
}

static void boot_init_styles() {
    if (bootStylesInited) return;
    bootStylesInited = true;
    lv_style_init(&styleRowName);       lv_style_set_text_font(&styleRowName,       &lv_font_montserrat_24); lv_style_set_text_color(&styleRowName,       lv_color_hex(0xFFFFFF));
    lv_style_init(&styleStatusPending); lv_style_set_text_font(&styleStatusPending, &lv_font_montserrat_24); lv_style_set_text_color(&styleStatusPending, lv_color_hex(0xFFB300));
    lv_style_init(&styleStatusOK);      lv_style_set_text_font(&styleStatusOK,      &lv_font_montserrat_24); lv_style_set_text_color(&styleStatusOK,      lv_color_hex(0x3CC35A));
    lv_style_init(&styleStatusError);   lv_style_set_text_font(&styleStatusError,   &lv_font_montserrat_24); lv_style_set_text_color(&styleStatusError,   lv_color_hex(0xE84747));
}

static BootRow boot_create_row(lv_obj_t *parent, const char *name) {
    BootRow row;
    lv_obj_t *cont = lv_obj_create(parent);
    lv_obj_set_width(cont, lv_pct(100)); lv_obj_set_height(cont, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_all(cont, 4, 0); lv_obj_set_style_bg_opa(cont, LV_OPA_0, 0);
    lv_obj_set_flex_flow(cont, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(cont, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    row.labelName = lv_label_create(cont);
    lv_obj_add_style(row.labelName, &styleRowName, 0);
    lv_label_set_text(row.labelName, name);
    row.labelStatus = lv_label_create(cont);
    lv_label_set_text(row.labelStatus, "...");
    lv_obj_add_style(row.labelStatus, &styleStatusPending, 0);
    lv_obj_set_style_pad_left(row.labelStatus, 12, 0);
    return row;
}

static void boot_update_progress() {
    if (bootProgress) lv_bar_set_value(bootProgress, (bootOkCount * 100) / 4, LV_ANIM_ON);
}

static void boot_set_row_result(BootRow &row, BootResult r, const char *textOverride = nullptr) {
    BootResult prev = row.result;
    row.result = r;
    if (!row.labelStatus) return;
    const char *txt = textOverride ? textOverride : (r == BR_OK ? "OK" : (r == BR_ERROR ? "Fallo" : "..."));
    lv_label_set_text(row.labelStatus, txt);
    lv_obj_remove_style_all(row.labelStatus);
    if (r == BR_OK)         lv_obj_add_style(row.labelStatus, &styleStatusOK, 0);
    else if (r == BR_ERROR) lv_obj_add_style(row.labelStatus, &styleStatusError, 0);
    else                    lv_obj_add_style(row.labelStatus, &styleStatusPending, 0);
    if (r == BR_OK && prev != BR_OK) { bootOkCount++; boot_update_progress(); }
}

static void boot_reset_button_event(lv_event_t *e) {
    if (lv_event_get_code(e) == LV_EVENT_CLICKED) {
        unsigned long t = millis();
        while (millis() - t < 100) lv_timer_handler();
        ESP.restart();
    }
}

static void createBootScreen() {
    boot_init_styles();
    scrBoot = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scrBoot, lv_color_hex(0x20252B), 0);
    lv_obj_set_style_bg_opa(scrBoot, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(scrBoot, 12, 0);
    lv_obj_set_flex_flow(scrBoot, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(scrBoot, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
    lv_obj_t *title = lv_label_create(scrBoot);
    lv_label_set_text(title, "Inicializando ....");
    lv_obj_set_style_text_color(title, lv_color_hex(0xFFFFFF), 0);
    lv_obj_set_style_pad_bottom(title, 6, 0);
    bootRowSystem  = boot_create_row(scrBoot, "Sistema");
    bootRowWifi    = boot_create_row(scrBoot, "Hora");
    bootRowNTP     = boot_create_row(scrBoot, "Gateway");
    bootRowFirebase = boot_create_row(scrBoot, "Server");
    bootRowRestore = boot_create_row(scrBoot, "Modo");
    bootProgress = lv_bar_create(scrBoot);
    lv_obj_set_width(bootProgress, lv_pct(100));
    lv_bar_set_range(bootProgress, 0, 100);
    lv_bar_set_value(bootProgress, 0, LV_ANIM_OFF);
    lv_obj_set_style_pad_top(bootProgress, 8, 0);
    bootStatusGlobal = lv_label_create(scrBoot);
    lv_label_set_text(bootStatusGlobal, "Preparando sistema...");
    lv_obj_set_style_text_color(bootStatusGlobal, lv_color_hex(0xA0A7AF), 0);
    lv_obj_set_style_pad_top(bootStatusGlobal, 6, 0);
    lv_obj_t *spacer = lv_obj_create(scrBoot);
    lv_obj_set_height(spacer, LV_SIZE_CONTENT);
    lv_obj_set_style_flex_grow(spacer, 1, 0);
    lv_obj_set_style_bg_opa(spacer, LV_OPA_0, 0);
    lv_obj_t *resetBtn = lv_btn_create(scrBoot);
    lv_obj_set_width(resetBtn, 185); lv_obj_set_height(resetBtn, 100);
    lv_obj_set_style_bg_color(resetBtn, lv_color_hex(0x433D3D), LV_PART_MAIN | LV_STATE_DEFAULT);
    lv_obj_set_style_bg_opa(resetBtn, 255, LV_PART_MAIN | LV_STATE_DEFAULT);
    lv_obj_set_style_pad_top(resetBtn, 12, 0);
    lv_obj_t *resetLabel = lv_label_create(resetBtn);
    lv_label_set_text(resetLabel, "RESET");
    lv_obj_set_style_text_font(resetLabel, &lv_font_montserrat_24, LV_PART_MAIN | LV_STATE_DEFAULT);
    lv_obj_center(resetLabel);
    lv_obj_add_event_cb(resetBtn, boot_reset_button_event, LV_EVENT_ALL, NULL);

    lv_obj_t *technicalAccess = lv_btn_create(scrBoot);
    lv_obj_set_size(technicalAccess, 100, 100);
    lv_obj_align(technicalAccess, LV_ALIGN_TOP_RIGHT, 0, 0);
    lv_obj_add_flag(technicalAccess, LV_OBJ_FLAG_FLOATING);
    lv_obj_set_style_bg_opa(technicalAccess, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(technicalAccess, 0, 0);
    lv_obj_set_style_shadow_width(technicalAccess, 0, 0);
    lv_obj_add_event_cb(technicalAccess, boot_technical_access_event, LV_EVENT_ALL, NULL);

    lv_scr_load(scrBoot);
    bootOkCount = 0; bootFinished = false;
}

static void boot_set_global_status(const char *txt) {
    if (bootStatusGlobal) lv_label_set_text(bootStatusGlobal, txt);
}

static void boot_process_ui_tick() {
    lv_timer_handler();
    if (bootTechnicalConfigRequested) {
        bootTechnicalConfigRequested = false;
        prepareEspNowConfigUi();
        while (ui_EspNowConfigPanel &&
               !lv_obj_has_flag(ui_EspNowConfigPanel, LV_OBJ_FLAG_HIDDEN)) {
        lv_timer_handler();
        esp_task_wdt_reset();
delay(5);
    }
}
    delay(5);
}

static void boot_wait_before_restart(unsigned long waitMs) {
    unsigned long startedAt = millis();
    while (millis() - startedAt < waitMs) {
        boot_process_ui_tick();
        esp_task_wdt_reset();
    }
}

static void boot_finish(bool activeCallFound) {
    if (bootFinished) return;
    bootFinished = true;
    boot_set_global_status("Completado");
    unsigned long t = millis();
    while (millis() - t < 250) lv_timer_handler();
    if (!activeCallFound && ui_Screen1)
        _ui_screen_change(&ui_Screen1, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, NULL);
}

// ========================================
// Manejo de LEDs
// ========================================
void handleLEDs() {
    if (cancelLedActive) {
        if (millis() - cancelLedStartTime >= CANCEL_LED_DURATION_MS) {
            lv_obj_set_style_opa(uic_led_red, LV_OPA_TRANSP, 0);
            cancelLedActive = false;
        }
        return;
    }
    if (isCalling) {
        unsigned long now = millis();
        if (isEmergencyCall) {
            lv_obj_set_style_opa(uic_led_green, LV_OPA_TRANSP, 0);
            if (now - lastBlinkTime >= LED_BLINK_EMERGENCY_MS) {
                ledRedState = !ledRedState;
                lv_obj_set_style_opa(uic_led_red, ledRedState ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
                lastBlinkTime = now;
            }
        } else {
            lv_obj_set_style_opa(uic_led_red, LV_OPA_TRANSP, 0);
            if (now - lastBlinkTime >= LED_BLINK_INTERVAL_MS) {
                ledGreenState = !ledGreenState;
                lv_obj_set_style_opa(uic_led_green, ledGreenState ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
                lastBlinkTime = now;
            }
        }
    } else {
        lv_obj_set_style_opa(uic_led_green, LV_OPA_TRANSP, 0);
        lv_obj_set_style_opa(uic_led_red,   LV_OPA_TRANSP, 0);
        ledGreenState = false; ledRedState = false;
    }
}

// ========================================
// Sonidos
// ========================================
void handleModernSounds() {
    if (!buzzerActive) return;
    unsigned long el = millis() - buzzerStartTime;
    if (soundType == 1) {
        if      (buzzerStep == 0 && el >= 0)   { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 1 && el >= 100)  { buzzer_off(); buzzerStep++; }
        else if (buzzerStep == 2 && el >= 200)  { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 3 && el >= 350)  { buzzer_off(); buzzerStep++; }
        else if (buzzerStep == 4 && el >= 450)  { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 5 && el >= 650)  { buzzer_off(); buzzerActive = false; }
    } else if (soundType == 2) {
        if      (buzzerStep == 0 && el >= 0)   { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 1 && el >= 80)   { buzzer_off(); buzzerStep++; }
        else if (buzzerStep == 2 && el >= 180)  { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 3 && el >= 260)  { buzzer_off(); buzzerActive = false; }
    } else if (soundType == 3) {
        if      (buzzerStep == 0 && el >= 0)   { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 1 && el >= 150)  { buzzer_off(); buzzerStep++; }
        else if (buzzerStep == 2 && el >= 230)  { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 3 && el >= 380)  { buzzer_off(); buzzerStep++; }
        else if (buzzerStep == 4 && el >= 430)  { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 5 && el >= 580)  { buzzer_off(); buzzerStep++; }
        else if (buzzerStep == 6 && el >= 630)  { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 7 && el >= 780)  { buzzer_off(); buzzerActive = false; }
    } else if (soundType == 4) {
        if      (buzzerStep == 0 && el >= 0)   { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 1 && el >= 200)  { buzzer_off(); buzzerStep++; }
        else if (buzzerStep == 2 && el >= 300)  { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 3 && el >= 450)  { buzzer_off(); buzzerActive = false; }
    } else if (soundType == 5) {
        if      (buzzerStep == 0 && el >= 0)   { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 1 && el >= 80)   { buzzer_off(); buzzerStep++; }
        else if (buzzerStep == 2 && el >= 160)  { buzzer_on();  buzzerStep++; }
        else if (buzzerStep == 3 && el >= 240)  { buzzer_off(); buzzerActive = false; }
    }
}

void playCallSound()      { buzzerActive=true; buzzerStartTime=millis(); buzzerStep=0; soundType=1; buzzer_on(); }
void playInsistSound()    { buzzerActive=true; buzzerStartTime=millis(); buzzerStep=0; soundType=2; buzzer_on(); }
void playEmergencySound() { buzzerActive=true; buzzerStartTime=millis(); buzzerStep=0; soundType=3; buzzer_on(); }
void playFinishSound()    { buzzerActive=true; buzzerStartTime=millis(); buzzerStep=0; soundType=4; buzzer_on(); }
void playEmergencyActiveBeep() {
    if (buzzerActive) return;
    buzzerActive=true; buzzerStartTime=millis(); buzzerStep=0; soundType=5; buzzer_on();
}

void playConnectionErrorSound() {
    if (!connectionAudioAlertEnabled) return;
    buzzer_on(); delay(180); buzzer_off(); delay(80);
    buzzer_on(); delay(60);  buzzer_off(); delay(80);
    buzzer_on(); delay(60);  buzzer_off(); delay(150);
    buzzer_on(); delay(180); buzzer_off(); delay(80);
    buzzer_on(); delay(60);  buzzer_off(); delay(80);
    buzzer_on(); delay(60);  buzzer_off();
}

// ========================================
// Helper Functions para Llamadas
// ========================================
bool checkInsistCooldown(const char* source = "") {
    unsigned long now = millis();
    if (now - lastInsistTime < INSIST_COOLDOWN_MS) {
        debugPrintln("Cooldown activo: espera " + String(INSIST_COOLDOWN_MS - (now - lastInsistTime)) + "ms");
        return false;
    }
    return true;
}

void processInsistence(const char* source = "") {
    currentConsecutive += 1;
    int newCons = currentConsecutive;
    lastInsistTime = millis();
    const char* ct = isEmergencyCall ? CALL_TYPE_EMERGENCY : CALL_TYPE_NORMAL;
    bool ok = updateCall(true, newCons, ct, false);
    if (ok) {
        updateConsecutiveDisplay(newCons);
        playInsistSound();
        debugPrintln("Insistencia - Cons: " + String(newCons));
    } else {
        currentConsecutive--;
        lastInsistTime -= INSIST_COOLDOWN_MS;
        debugPrintln("Error al insistir por ESP-LORA");
    }
}

// Verifica si el gateway esta disponible (basado en ultimo ACK recibido)
static inline bool isGatewayReachable() {
    if (isReconnecting) return false;
    if (!espnowServerSynced || lastGatewayAckMs == 0) return false;
    return (millis() - lastGatewayAckMs) <= GATEWAY_LOST_TIMEOUT_MS;
}

bool startNewCall(const char* source = "", bool changeScreen = true) {
    if (!isGatewayReachable()) {
        debugPrintln("Gateway no disponible. Reconectando antes de llamar...");
        reconnectGateway();
        return false;
    }
    bool ok = updateCall(true, 1, CALL_TYPE_NORMAL, true);
    if (ok) {
        isCalling = true; isEmergencyCall = false; lastEmergencyBeepTime = 0;
        lastBlinkTime = 0; ledGreenState = false; ledRedState = false;
        startChronometer();
        currentConsecutive = 1; lastInsistTime = millis();
        updateConsecutiveDisplay(1);
        playCallSound();
        debugPrintln("Llamada normal iniciada");
        if (changeScreen)
            _ui_screen_change(&ui_Screen2, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, &ui_Screen2_screen_init);
    } else {
        debugPrintln("Error al iniciar llamada por ESP-LORA");
    }
    return ok;
}

void checkEmergencyLongPress(bool &longPressFlag, bool &emergencyActiveFlag, unsigned long pressStartTime, const char* sourceName) {
    if (longPressFlag && !emergencyActiveFlag) {
        if (millis() - pressStartTime >= EMERGENCY_LONG_PRESS_TIME_MS) {
            emergencyActiveFlag = true; longPressFlag = false;
            debugPrintln("Emergencia activada - " + String(sourceName));
            if (!isCalling) {
                if (!isGatewayReachable()) {
                    debugPrintln("Gateway no disponible. Reconectando antes de emergencia...");
                    emergencyActiveFlag = false; longPressFlag = false;
                    reconnectGateway();
                    return;
                }
                bool ok = updateCall(true, 1, CALL_TYPE_EMERGENCY, true);
                if (ok) {
                    isEmergencyCall = true; lastEmergencyBeepTime = millis();
                    lastBlinkTime = 0; ledGreenState = false; ledRedState = false;
                    isCalling = true; startChronometer();
                    currentConsecutive = 1; updateConsecutiveDisplay(1);
                    playEmergencySound();
                    if (lv_scr_act() != ui_Screen2)
                        _ui_screen_change(&ui_Screen2, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, &ui_Screen2_screen_init);
                    playEmergencyVisualEffect();
                } else {
                    emergencyActiveFlag = false; longPressFlag = false;
                    debugPrintln("Error al activar emergencia");
                }
            } else {
                currentConsecutive++;
                bool ok = updateCall(true, currentConsecutive, CALL_TYPE_EMERGENCY, false);
                if (ok) {
                    isEmergencyCall = true; lastEmergencyBeepTime = millis();
                    updateConsecutiveDisplay(currentConsecutive);
                    playEmergencySound(); playEmergencyVisualEffect();
                } else {
                    currentConsecutive--;
                    emergencyActiveFlag = false; longPressFlag = false;
                    debugPrintln("Error al convertir a emergencia");
                }
            }
        }
    }
}

void checkAutoReturn(lv_obj_t *targetScreen, bool &inScreenFlag, unsigned long enterTime, unsigned long timeoutMs, void (*markEnterFunc)()) {
    if (lv_scr_act() == targetScreen) {
        if (!inScreenFlag) markEnterFunc();
        else if (millis() - enterTime >= timeoutMs) {
            if (isCalling) _ui_screen_change(&ui_Screen2, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, &ui_Screen2_screen_init);
            else           _ui_screen_change(&ui_Screen1, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, &ui_Screen1_screen_init);
            inScreenFlag = false;
        }
    } else { inScreenFlag = false; }
}

// ========================================
// Boton aereo fisico
// ========================================
void handleBotonAereo() {
    bool cur = !digitalRead(BOTON_AEREO_PIN);
    if (cur != lastBotonAereoState) lastBotonAereoDebounceTime = millis();
    if ((millis() - lastBotonAereoDebounceTime) > BOTON_AEREO_DEBOUNCE_DELAY) {
        if (cur != botonAereoState) {
            botonAereoState = cur;
            if (botonAereoState) {
                if (!isCalling) startNewCall("por boton aereo");
                else { if (!checkInsistCooldown()) return; if (currentConsecutive == 0) currentConsecutive = 1; processInsistence("boton aereo"); }
            }
        }
    }
    lastBotonAereoState = cur;
}

// ========================================
// Efectos visuales
// ========================================
void playEmergencyVisualEffect() {
    emergencyEffectActive = true; emergencyEffectStep = 0; lastEmergencyEffectTime = millis();
    lv_obj_set_style_opa(uic_led_green, LV_OPA_COVER, 0);
    lv_obj_set_style_opa(uic_led_red,   LV_OPA_TRANSP, 0);
}

void handleEmergencyVisualEffect() {
    if (!emergencyEffectActive) return;
    if (millis() - lastEmergencyEffectTime >= BUZZER_DELAY_150_MS) {
        lastEmergencyEffectTime = millis();
        emergencyEffectStep++;
        if (emergencyEffectStep < 6) {
            lv_obj_set_style_opa(uic_led_green, (emergencyEffectStep % 2 == 0) ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
            lv_obj_set_style_opa(uic_led_red,   (emergencyEffectStep % 2 == 1) ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
            lv_timer_handler();
        } else {
            lv_obj_set_style_opa(uic_led_green, LV_OPA_COVER, 0);
            lv_obj_set_style_opa(uic_led_red,   LV_OPA_COVER, 0);
            lv_timer_handler();
            emergencyEffectActive = false;
        }
    }
}

// ========================================
// Manejadores de Botones
// ========================================
void handleCallButton(lv_event_t *e) {
    static bool pressed = false;
    static unsigned long lastPressTime = 0;
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_PRESSED) {
        unsigned long now = millis();
        if (!pressed || (now - lastPressTime > 500)) {
            pressed = true; lastPressTime = now;
            callButtonLongPress = true; callButtonPressStartTime = now; emergencyActivated = false;
        }
    } else if (code == LV_EVENT_RELEASED) {
        pressed = false;
        if (callButtonLongPress && !emergencyActivated) {
            callButtonLongPress = false;
            if (millis() - callButtonPressStartTime < EMERGENCY_LONG_PRESS_TIME_MS) {
                if (!isCalling) startNewCall("", false);
                else { if (!checkInsistCooldown()) return; processInsistence(""); }
            }
        } else if (emergencyActivated) { emergencyActivated = false; callButtonLongPress = false; }
    }
}

void handleFinishButton(lv_event_t *e) {
    if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
    if (!isCalling) return;
    if (!espnowBridgeReady) { debugPrintln("ESP-LORA bridge no listo"); return; }
    bool ok = updateCall(false, 0, CALL_TYPE_NORMAL, false);
    if (ok) {
        isCalling = false; isEmergencyCall = false; lastEmergencyBeepTime = 0;
        stopChronometer();
        currentConsecutive = 0; updateConsecutiveDisplay(0);
        playFinishSound();
        lv_obj_set_style_opa(uic_led_red,   LV_OPA_COVER, 0);
        lv_obj_set_style_opa(uic_led_green, LV_OPA_TRANSP, 0);
        cancelLedActive = true; cancelLedStartTime = millis();
        debugPrintln("Llamada finalizada - enviado por ESP-LORA");
    } else { debugPrintln("Error al finalizar por ESP-LORA"); }
}

void handleInsistButton(lv_event_t *e) {
    static bool pressed = false;
    static unsigned long lastPressTime = 0;
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_PRESSED) {
        unsigned long now = millis();
        if (!pressed || (now - lastPressTime > 500)) {
            pressed = true; lastPressTime = now;
            calls1ButtonLongPress = true; calls1ButtonPressStartTime = now; calls1EmergencyActivated = false;
        }
    } else if (code == LV_EVENT_RELEASED) {
        pressed = false;
        if (calls1ButtonLongPress && !calls1EmergencyActivated) {
            calls1ButtonLongPress = false;
            if (millis() - calls1ButtonPressStartTime < EMERGENCY_LONG_PRESS_TIME_MS) {
                if (isCalling) { if (!checkInsistCooldown("(calls1)")) return; processInsistence("desde Screen2"); }
                else startNewCall("desde Screen2", false);
            }
        } else if (calls1EmergencyActivated) { calls1EmergencyActivated = false; calls1ButtonLongPress = false; }
    }
}

void handleResetButton(lv_event_t *e) {
    if (lv_event_get_code(e) == LV_EVENT_CLICKED) {
        unsigned long t = millis();
        while (millis() - t < 100) lv_timer_handler();
        ESP.restart();
    }
}

void handlePatientNameDoubleTap(lv_event_t *e) {
    if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
    unsigned long now = millis();
    if (!patientNameTouched || (now - patientNameTouchStartTime > DOUBLE_TOUCH_TIMEOUT)) {
        patientNameTouched = true; patientNameTouchStartTime = now; patientNameTouchCount = 1; return;
    }
    if (now - patientNameTouchStartTime <= PATIENT_TOUCH_INTERVAL) {
        patientNameTouchCount++;
        if (patientNameTouchCount >= 2) {
            patientNameTouched = false; patientNameTouchCount = 0;
            if (patientFullName.length() > 0) {
                _ui_screen_change(&ui_Screen4, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, &ui_Screen4_screen_init);
                markEnterScreen4();
            }
        }
    } else { patientNameTouchStartTime = now; patientNameTouchCount = 1; }
}

void handlePatientInfoButton(lv_event_t *e) {
    if (lv_event_get_code(e) == LV_EVENT_CLICKED) {
        _ui_screen_change(&ui_Screen4, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, &ui_Screen4_screen_init);
        markEnterScreen4();
    }
}

// ========================================
// Marcadores de entrada a pantallas
// ========================================
static inline void markEnterScreen3() { inScreen3 = true; screen3EnterTime = millis(); debugPrintln("Entrando Screen3"); }
static inline void markEnterScreen4() { inScreen4 = true; screen4EnterTime = millis(); debugPrintln("Entrando Screen4"); }
static inline void markEnterScreen5() { inScreen5 = true; screen5EnterTime = millis(); debugPrintln("Entrando Screen5"); }
static inline void markEnterScreen6() {
    inScreen6 = true; screen6EnterTime = millis();
    if (ui_Switchtms) { if (monitorSerialEnabled) lv_obj_add_state(ui_Switchtms, LV_STATE_CHECKED); else lv_obj_clear_state(ui_Switchtms, LV_STATE_CHECKED); }
    if (ui_Sliderbrillo) { lv_slider_set_range(ui_Sliderbrillo, MIN_BRIGHTNESS_LEVEL, MAX_BRIGHTNESS_LEVEL); lv_slider_set_value(ui_Sliderbrillo, currentBrightnessLevel, LV_ANIM_OFF); }
    debugPrintln("Entrando Screen6");
}

extern "C" void clearScreen4State() { inScreen4 = false; }

// ========================================
// Setup
// ========================================
void setup() {
    Serial.begin(SERIAL_BAUD_RATE);
    unsigned long t0 = millis();
    while (millis() - t0 < 1000) delay(5);

    preferences.begin("sys_cfg", true);
    uint8_t savedBrightness     = preferences.getUInt("brightness", DEFAULT_BRIGHTNESS_LEVEL);
    bool    savedAudioAlert     = preferences.getBool("audioAlert",  ENABLE_CONNECTION_AUDIO_ALERT);
    preferences.end();

    if (savedBrightness < MIN_BRIGHTNESS_LEVEL) savedBrightness = MIN_BRIGHTNESS_LEVEL;
    if (savedBrightness > MAX_BRIGHTNESS_LEVEL) savedBrightness = MAX_BRIGHTNESS_LEVEL;
    currentBrightnessLevel      = savedBrightness;
    connectionAudioAlertEnabled = savedAudioAlert;
    loadEspNowConfig();
    initializeEspNowSeqCounter();

    esp_task_wdt_deinit();
    esp_task_wdt_config_t wdt_config = { .timeout_ms = 30000, .idle_core_mask = 0, .trigger_panic = true };
    esp_task_wdt_init(&wdt_config);
    esp_task_wdt_add(NULL);

    I2C_Init();
    TCA9554PWR_Init(0x00);
    buzzer_off();
    LCD_Init();
    Backlight_Init();
    Set_Backlight(currentBrightnessLevel);

    pinMode(BOTON_AEREO_PIN, INPUT_PULLUP);

    Lvgl_Init();
    ui_init();
    hookHomeButtons();

    lv_scr_load(ui_Screenwelcome);

    t0 = millis();
    while (millis() - t0 < WELCOME_DURATION_MS) {
        lv_timer_handler();
        esp_task_wdt_reset();
        delay(5);
    }

    createBootScreen();
    boot_set_global_status("Inicializando hardware...");
    boot_set_row_result(bootRowSystem, BR_OK);

    uint64_t chipMac = ESP.getEfuseMac();
    char macBuf[13];
    // getEfuseMac() pone mac[5] en bits altos → imprimir LSB primero da el orden correcto de red
    snprintf(macBuf, sizeof(macBuf), "%02X%02X%02X%02X%02X%02X",
        (uint8_t)(chipMac & 0xFF),
        (uint8_t)((chipMac >> 8)  & 0xFF),
        (uint8_t)((chipMac >> 16) & 0xFF),
        (uint8_t)((chipMac >> 24) & 0xFF),
        (uint8_t)((chipMac >> 32) & 0xFF),
        (uint8_t)((chipMac >> 40) & 0xFF));
    deviceId = String(macBuf);
    debugPrintln("Device ID: " + deviceId);

    boot_set_row_result(bootRowWifi, BR_PENDING, "...");
    boot_set_global_status("Configurando zona horaria...");
    // Configurar zona horaria (Colombia UTC-5, sin cambio horario)
    // La hora real se sincroniza desde el gateway via ACK
    setenv("TZ", "COT5", 1);
    tzset();
    boot_set_row_result(bootRowWifi, BR_OK, "OK");
    boot_process_ui_tick();

    boot_set_row_result(bootRowNTP, BR_PENDING, "...");
    boot_set_global_status("Conectando gateway...");
    if (initEspNowBridge()) {
        boot_set_row_result(bootRowNTP, BR_OK, "OK");
    } else {
        boot_set_row_result(bootRowNTP, BR_ERROR, "Error");
        boot_set_global_status("Gateway fallo. Reiniciando...");
        boot_process_ui_tick();
        boot_wait_before_restart(8000);
        ESP.restart();
    }
    boot_process_ui_tick();

    boot_set_row_result(bootRowFirebase, BR_PENDING, "...");

    // Ventana de escucha de vecinos ANTES del primer intento de registro: en boot en frio
    // relayPeers[] esta vacio (aun no llego ningun heartbeat), asi que sin esta espera
    // el primer intento (y a veces varios) no tienen candidato de relay disponible.
    boot_set_global_status("Escuchando vecinos...");
    boot_process_ui_tick();
    {
        unsigned long tListen = millis();
        while (millis() - tListen < (unsigned long)BOOT_NEIGHBOR_LISTEN_MS) {
            if (espnowPeerMacPending) {
                uint8_t mac[6]; int8_t rssi; uint8_t metric;
                noInterrupts();
                memcpy(mac, espnowPendingPeerMac, 6);
                rssi   = espnowPendingPeerRssi;
                metric = espnowPendingPeerMetric;
                espnowPeerMacPending = false;
                interrupts();
                updateRelayPeer(mac, rssi, metric);
                computeAndUpdateMyMetric();
            }
            boot_process_ui_tick(); esp_task_wdt_reset(); delay(15);
        }
    }

    boot_set_global_status("Buscando gateway...");
    bool registered = false;
    bool registeredViaRelay = false;
    for (int attempt = 1; attempt <= REGISTER_BOOT_RETRIES && !registered; attempt++) {
        char regBuf[28];
        snprintf(regBuf, sizeof(regBuf), "Intento %d/%d...", attempt, REGISTER_BOOT_RETRIES);
        boot_set_global_status(regBuf);
        boot_process_ui_tick();
        registered = sendRegisterEspNow();
        if (!registered && attempt < REGISTER_BOOT_RETRIES) {
            // Esperar procesando heartbeats de peers para descubrir nodos relay cercanos
            unsigned long waitUntil = millis() + REGISTER_BOOT_RETRY_DELAY_MS;
            while (millis() < waitUntil) {
                if (espnowPeerMacPending) {
                    uint8_t mac[6]; int8_t rssi; uint8_t metric;
                    noInterrupts();
                    memcpy(mac, espnowPendingPeerMac, 6);
                    rssi   = espnowPendingPeerRssi;
                    metric = espnowPendingPeerMetric;
                    espnowPeerMacPending = false;
                    interrupts();
                    updateRelayPeer(mac, rssi, metric);
                    computeAndUpdateMyMetric();
                }
                boot_process_ui_tick(); esp_task_wdt_reset(); delay(15);
            }
#if ESPNOW_RELAY_ENABLED
            // Despues de 2 fallos directos, intentar via relay si hay peers conocidos
            if (attempt >= 2) {
                bool hasPeer = false;
                for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++)
                    if (relayPeers[i].active) { hasPeer = true; break; }
                if (hasPeer) {
                    snprintf(regBuf, sizeof(regBuf), "Relay intento %d...", attempt);
                    boot_set_global_status(regBuf);
                    boot_process_ui_tick();
                    registered = tryRegisterViaRelay();
                    if (registered) registeredViaRelay = true;
                }
            }
#endif
        }
    }
    if (registered) {
        computeAndUpdateMyMetric(); // Reflejar de inmediato la ruta real (0=directo) tras el registro
        boot_set_row_result(bootRowFirebase, BR_OK, registeredViaRelay ? "Relay OK" : "ACK");
        boot_set_global_status("Server sincronizado");
    } else {
        boot_set_row_result(bootRowFirebase, BR_ERROR, "Sin ACK");
        boot_set_global_status("Gateway no responde. Reiniciando...");
        boot_process_ui_tick();
        boot_wait_before_restart(8000);
        ESP.restart();
    }
    boot_process_ui_tick();

    boot_set_row_result(bootRowRestore, BR_OK, "ESP-LORA");

    preferences.begin("sys_cfg", true);
    String savedName = preferences.getString("devName", "");
    preferences.end();

    if (savedName.length() > 0) {
        deviceName = savedName;
        debugPrintln("Nombre cargado: " + deviceName);
    } else {
        deviceName = "Dispositivo " + deviceId.substring(deviceId.length() - 4);
    }
    updateDeviceNameDisplay(deviceName);
    updatePatientInfoDisplay();

    boot_set_global_status("Modo ESP-LORA activo");
    boot_process_ui_tick();

    lv_obj_add_event_cb(uic_call,   handleCallButton,           LV_EVENT_ALL, NULL);
    lv_obj_add_event_cb(uic_finish, handleFinishButton,         LV_EVENT_ALL, NULL);
    lv_obj_add_event_cb(ui_calls1,  handleInsistButton,         LV_EVENT_ALL, NULL);
    if (ui_RESET)        lv_obj_add_event_cb(ui_RESET,        handleResetButton,          LV_EVENT_ALL, NULL);
    if (ui_namepaciente) lv_obj_add_event_cb(ui_namepaciente, handlePatientNameDoubleTap, LV_EVENT_ALL, NULL);
    if (ui_InfoPaciente) lv_obj_add_event_cb(ui_InfoPaciente, handlePatientInfoButton,    LV_EVENT_ALL, NULL);
    if (lv_scr_act() == ui_Screen3) markEnterScreen3();
    if (lv_scr_act() == ui_Screen4) markEnterScreen4();

    updateTimeDisplay();
    updateConsecutiveDisplay(0);
    updateNetworkInfo();

    debugPrintln("Sistema ESP-LORA listo! DeviceId: " + deviceId);

    // Esperar ACK enriquecido del servidor (puede traer info de llamado activo ~50-300ms)
    {
        unsigned long tWait = millis();
        while (millis() - tWait < 800 && !espnowPendingRestoreCall) {
            lv_timer_handler();
            esp_task_wdt_reset();
            delay(10);
        }
    }

    if (espnowPendingRestoreCall) {
        bool isEmerg        = (espnowRestoreCallInfo.callType == 1);
        uint32_t startedAtS = espnowRestoreCallInfo.callStartedAtS;
        uint32_t epochNow   = espnowRestoreCallInfo.epochS;
        uint32_t elapsedS   = (epochNow > startedAtS) ? (epochNow - startedAtS) : 0;

        isCalling           = true;
        isEmergencyCall     = isEmerg;
        currentConsecutive  = (int)espnowRestoreCallInfo.callCons;
        currentCallStartSeq = espnowRestoreCallInfo.callStartSeq;
        chronoRestoredBase  = (unsigned long)elapsedS * 1000UL;
        callStartTime       = millis();
        chronoActive        = true;
        chronoRestored      = (elapsedS > 0);
        espnowPendingRestoreCall = false;

        debugPrintln(String("Llamado restaurado: ") + (isEmerg ? "EMERGENCIA" : "NORMAL") +
                     " cons=" + String(currentConsecutive) + " elapsed=" + String(elapsedS) + "s");
        boot_finish(true);
        if (ui_Screen2)
            _ui_screen_change(&ui_Screen2, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, NULL);
        updateConsecutiveDisplay(currentConsecutive);
        if (isEmerg) playEmergencySound(); else playCallSound();
    } else {
        boot_finish(false);
    }
}

// ========================================
// Reconexion en caliente con gateway
// ========================================
void reconnectGateway() {
    if (isReconnecting) return;
    isReconnecting = true;

    debugPrintln("Gateway perdido. Iniciando reconexion...");

    // Liberar pantalla de boot anterior y recrearla fresca
    if (scrBoot) { lv_obj_del(scrBoot); scrBoot = nullptr; }
    bootFinished = false;
    bootOkCount  = 0;
    createBootScreen();

    // Hardware y hora ya listos: marcar OK directamente
    boot_set_row_result(bootRowSystem, BR_OK);
    boot_set_row_result(bootRowWifi, BR_OK, "OK");
    boot_set_global_status("Reconectando con gateway...");
    boot_process_ui_tick();

    // Ventana de escucha de vecinos antes del primer intento (misma razon que en boot en frio:
    // el gateway se perdio, puede que la ruta relay conocida tambien haya cambiado)
    boot_set_global_status("Escuchando vecinos...");
    boot_process_ui_tick();
    {
        unsigned long tListen = millis();
        while (millis() - tListen < (unsigned long)BOOT_NEIGHBOR_LISTEN_MS) {
            if (espnowPeerMacPending) {
                uint8_t mac[6]; int8_t rssi; uint8_t metric;
                noInterrupts();
                memcpy(mac, espnowPendingPeerMac, 6);
                rssi   = espnowPendingPeerRssi;
                metric = espnowPendingPeerMetric;
                espnowPeerMacPending = false;
                interrupts();
                updateRelayPeer(mac, rssi, metric);
                computeAndUpdateMyMetric();
            }
            boot_process_ui_tick(); esp_task_wdt_reset(); delay(15);
        }
    }

    // Reintentar registro con el mismo proceso del boot
    bool registered = false;
    for (int attempt = 1; attempt <= REGISTER_BOOT_RETRIES && !registered; attempt++) {
        char regBuf[28];
        snprintf(regBuf, sizeof(regBuf), "Intento %d/%d...", attempt, REGISTER_BOOT_RETRIES);
        boot_set_global_status(regBuf);
        boot_set_row_result(bootRowNTP, BR_PENDING, regBuf);
        boot_process_ui_tick();
        registered = sendRegisterEspNow();
        if (!registered && attempt < REGISTER_BOOT_RETRIES) {
            unsigned long waitUntil = millis() + REGISTER_BOOT_RETRY_DELAY_MS;
            while (millis() < waitUntil) {
                if (espnowPeerMacPending) {
                    uint8_t mac[6]; int8_t rssi; uint8_t metric;
                    noInterrupts();
                    memcpy(mac, espnowPendingPeerMac, 6);
                    rssi   = espnowPendingPeerRssi;
                    metric = espnowPendingPeerMetric;
                    espnowPeerMacPending = false;
                    interrupts();
                    updateRelayPeer(mac, rssi, metric);
                    computeAndUpdateMyMetric();
                }
                boot_process_ui_tick(); esp_task_wdt_reset(); delay(15);
            }
#if ESPNOW_RELAY_ENABLED
            if (attempt >= 2) {
                bool hasPeer = false;
                for (int i = 0; i < ESPNOW_RELAY_PEER_MAX; i++)
                    if (relayPeers[i].active) { hasPeer = true; break; }
                if (hasPeer) {
                    snprintf(regBuf, sizeof(regBuf), "Relay intento %d...", attempt);
                    boot_set_global_status(regBuf);
                    boot_set_row_result(bootRowNTP, BR_PENDING, regBuf);
                    boot_process_ui_tick();
                    registered = tryRegisterViaRelay();
                }
            }
#endif
        }
    }

    if (!registered) {
        boot_set_row_result(bootRowNTP, BR_ERROR, "Sin ACK");
        boot_set_global_status("Gateway no responde. Reiniciando...");
        boot_process_ui_tick();
        boot_wait_before_restart(8000);
        ESP.restart();
        return;
    }

    computeAndUpdateMyMetric(); // Reflejar de inmediato la ruta real (0=directo) tras el registro
    boot_set_row_result(bootRowNTP, BR_OK, "OK");
    boot_set_row_result(bootRowFirebase, BR_OK, "ACK");
    boot_set_global_status("Reconectado!");
    boot_process_ui_tick();

    // Esperar ACK del servidor (puede traer llamado activo)
    {
        unsigned long tWait = millis();
        while (millis() - tWait < 800 && !espnowPendingRestoreCall) {
            lv_timer_handler(); esp_task_wdt_reset(); delay(10);
        }
    }

    if (espnowPendingRestoreCall) {
        bool isEmerg        = (espnowRestoreCallInfo.callType == 1);
        uint32_t startedAtS = espnowRestoreCallInfo.callStartedAtS;
        uint32_t epochNow   = espnowRestoreCallInfo.epochS;
        uint32_t elapsedS   = (epochNow > startedAtS) ? (epochNow - startedAtS) : 0;
        isCalling           = true;
        isEmergencyCall     = isEmerg;
        currentConsecutive  = (int)espnowRestoreCallInfo.callCons;
        currentCallStartSeq = espnowRestoreCallInfo.callStartSeq;
        chronoRestoredBase  = (unsigned long)elapsedS * 1000UL;
        callStartTime       = millis();
        chronoActive        = true;
        chronoRestored      = (elapsedS > 0);
        espnowPendingRestoreCall = false;
        debugPrintln(String("Llamado restaurado tras reconexion: ") + (isEmerg ? "EMERGENCIA" : "NORMAL") +
                     " cons=" + String(currentConsecutive) + " elapsed=" + String(elapsedS) + "s");
        boot_finish(true);
        if (ui_Screen2)
            _ui_screen_change(&ui_Screen2, LV_SCR_LOAD_ANIM_FADE_ON, SCREEN_CHANGE_ANIMATION_MS, 0, NULL);
        updateConsecutiveDisplay(currentConsecutive);
        if (isEmerg) playEmergencySound(); else playCallSound();
    } else {
        // Servidor no tiene llamado activo: si el terminal tenia uno, cancelarlo
        if (isCalling) {
            isCalling = false; isEmergencyCall = false;
            stopChronometer();
            currentConsecutive = 0;
            updateConsecutiveDisplay(0);
            debugPrintln("Llamado cancelado: servidor sin llamado activo tras reconexion");
        }
        boot_finish(false);
    }

    isReconnecting = false;
}

// ========================================
// Loop
// ========================================
void loop() {
    // ---- Config remota pendiente ----
    if (espnowConfigPending) {
        EspNowConfigFrame cfg = {};
        noInterrupts();
        memcpy(&cfg, &espnowPendingConfig, sizeof(EspNowConfigFrame));
        espnowConfigPending = false;
        interrupts();
        applyEspNowConfig(cfg);
    }

#if USE_LORA_TRANSPORT
    pollLora();
#endif

    // ---- TX Queue: state machine no bloqueante (procesar ANTES que todo) ----
    processEspNowTx();

    // ---- Evento sin ACK final: reconectar sin borrar la llamada local. El
    // REGISTER consulta SQLite y reconcilia el estado autoritativo. ----
    if (espnowCallFrameFailed && !isReconnecting) {
        espnowCallFrameFailed = false;
        reconnectGateway();
    }

#if ESPNOW_RELAY_ENABLED
    // ---- Actualizar relay peer table con MAC recibida en recv callback ----
    if (espnowPeerMacPending) {
        uint8_t mac[6];
        int8_t  rssi;
        uint8_t metric;
        noInterrupts();
        memcpy(mac, espnowPendingPeerMac, 6);
        rssi   = espnowPendingPeerRssi;
        metric = espnowPendingPeerMetric;
        espnowPeerMacPending = false;
        interrupts();
        updateRelayPeer(mac, rssi, metric);
        computeAndUpdateMyMetric(); // Actualizar metrica propia tras nueva info de vecino
    }

    // ---- Drenar cola de RELAY_REQ pendientes (seguro para esp_now_send) ----
    while (espnowRelayReqQHead != espnowRelayReqQTail) {
        EspNowRelayReqFrame req = {};
        noInterrupts();
        memcpy(&req, &espnowRelayReqQueue[espnowRelayReqQHead], sizeof(EspNowRelayReqFrame));
        espnowRelayReqQHead = (espnowRelayReqQHead + 1) % ESPNOW_RELAY_REQ_QUEUE_SIZE;
        interrupts();
        req.embedded.deviceId[12] = '\0';
        req.deviceId[12] = '\0';
        processRelayReq(req);
    }
    // ---- Reenvio de RELAY_CONFIRM como nodo intermedio (mejor camino hacia atras) ----
    if (relayFwdPending) {
        noInterrupts();
        RelayForwardPending fwd = relayFwdReq;
        relayFwdPending = false;
        interrupts();
        EspNowRelayConfirmFrame confirm = {};
        confirm.msgType = ESPNOW_MSG_RELAY_CONFIRM;
        confirm.origSeq = fwd.origSeq;
        confirm.result  = fwd.result;
        confirm.epochS  = fwd.epochS;
        strncpy(confirm.deviceId, fwd.deviceId, 12);
        confirm.deviceId[12] = '\0';
        if (!esp_now_is_peer_exist(fwd.targetMac)) {
            esp_now_peer_info_t p = {};
            memcpy(p.peer_addr, fwd.targetMac, 6);
            p.channel = configuredEspNowChannel;
            p.encrypt = false;
            esp_now_add_peer(&p);
        }
        esp_now_send(fwd.targetMac, (const uint8_t*)&confirm, sizeof(confirm));
        Serial.printf("[RELAY-FWD] Confirm reenviado origSeq=%u result=%d\n", fwd.origSeq, fwd.result);
    }
    // ---- Limpiar entradas obsoletas de hop table ----
    {
        unsigned long nowHop = millis();
        unsigned long hopTimeout = (unsigned long)ESPNOW_RELAY_CONFIRM_TIMEOUT_MS * ESPNOW_RELAY_TTL * 2;
        for (int i = 0; i < RELAY_HOP_TABLE_SIZE; i++) {
            if (relayHopTable[i].active && (nowHop - relayHopTable[i].createdAt) > hopTimeout)
                relayHopTable[i].active = false;
        }
    }
#endif

    static unsigned long lastWdt = 0, lastMem = 0;
    if (millis() - lastWdt >= 1000)  { esp_task_wdt_reset(); lastWdt = millis(); }
    if (millis() - lastMem >= 30000) {
        uint32_t freeH = ESP.getFreeHeap();
        if (freeH < 20000) debugPrintln("MEMORIA BAJA: " + String(freeH) + " bytes");
        lastMem = millis();
    }

    Lvgl_Loop();

    if (millis() - lastTimeUpdate >= TIME_UPDATE_INTERVAL) {
        updateTimeDisplay();
        updateChronometerDisplay();
        if (lv_scr_act() == ui_Screen2 && isCalling && hasPendingConsecutive) applyPendingConsecutive();
        lastTimeUpdate = millis();
    }

    if (millis() - lastNetworkUpdate >= NETWORK_UPDATE_INTERVAL) {
        updateNetworkInfo();
        lastNetworkUpdate = millis();
    }

    if (patientNameTouched && (millis() - patientNameTouchStartTime > DOUBLE_TOUCH_TIMEOUT)) {
        patientNameTouched = false; patientNameTouchCount = 0;
    }

    handleModernSounds();
    handleEmergencyVisualEffect();

    if (remoteTerminationEffectActive) {
        unsigned long el = millis() - remoteTerminationEffectStartTime;
        static const struct { int step; unsigned long t; uint8_t g; uint8_t r; } fx[] = {
            {0, 0,    LV_OPA_COVER, LV_OPA_TRANSP},
            {1, 150,  LV_OPA_TRANSP,LV_OPA_COVER },
            {2, 300,  LV_OPA_COVER, LV_OPA_TRANSP},
            {3, 450,  LV_OPA_TRANSP,LV_OPA_COVER },
            {4, 600,  LV_OPA_COVER, LV_OPA_TRANSP},
            {5, 750,  LV_OPA_TRANSP,LV_OPA_COVER },
            {6, 900,  LV_OPA_COVER, LV_OPA_TRANSP},
            {7, 1050, LV_OPA_TRANSP,LV_OPA_COVER },
        };
        for (const auto &f : fx) {
            if (remoteTerminationEffectStep == f.step && el >= f.t) {
                lv_obj_set_style_opa(uic_led_green, f.g, 0);
                lv_obj_set_style_opa(uic_led_red,   f.r, 0);
                lv_timer_handler();
                remoteTerminationEffectStep++;
                break;
            }
        }
        if (remoteTerminationEffectStep >= 8 && el >= 1200) {
            lv_obj_set_style_opa(uic_led_green, LV_OPA_TRANSP, 0);
            lv_obj_set_style_opa(uic_led_red,   LV_OPA_TRANSP, 0);
            remoteTerminationEffectActive = false;
            remoteTerminationEffectStep   = 0;
        }
    }

    if (isEmergencyCall && isCalling && !buzzerActive && millis() - lastEmergencyBeepTime >= EMERGENCY_BEEP_INTERVAL) {
        playEmergencyActiveBeep();
        lastEmergencyBeepTime = millis();
    }

    handleBotonAereo();
    handleLEDs();

    // ---- Recomputar metrica de ruta periodicamente ----
    if (millis() - lastMetricUpdateMs >= 10000UL) {
        computeAndUpdateMyMetric();
        lastMetricUpdateMs = millis();
    }

    // ---- Heartbeat + broadcast de presencia periodico ----
#if USE_LORA_TRANSPORT
    if (espnowBridgeReady && millis() - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
        sendHeartbeatEspNow();
        lastHeartbeatTime = millis();
    }
#else
    if (espnowBridgeReady && millis() - lastPresenceBroadcastTime >= ESPNOW_PRESENCE_INTERVAL_MS) {
        sendHeartbeatEspNow();
        lastPresenceBroadcastTime = millis();
        lastHeartbeatTime = millis();  // Evitar doble envio al gateway
    } else if (espnowBridgeReady && millis() - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
        sendHeartbeatEspNow();
        lastHeartbeatTime = millis();
    }
#endif

    // ---- Reconexion si se perdio la conexion con el gateway ----
    if (!isReconnecting && espnowServerSynced &&
        lastGatewayAckMs > 0 && millis() - lastGatewayAckMs > GATEWAY_LOST_TIMEOUT_MS) {
        reconnectGateway();
    }

    checkAutoReturn(ui_Screen3, inScreen3, screen3EnterTime, SCREEN3_AUTO_RETURN_MS, markEnterScreen3);
    checkAutoReturn(ui_Screen4, inScreen4, screen4EnterTime, SCREEN4_AUTO_RETURN_MS, markEnterScreen4);
    checkAutoReturn(ui_Screen5, inScreen5, screen5EnterTime, SCREEN5_AUTO_RETURN_MS, markEnterScreen5);
    checkAutoReturn(ui_Screen6, inScreen6, screen6EnterTime, SCREEN6_AUTO_RETURN_MS, markEnterScreen6);

    checkEmergencyLongPress(callButtonLongPress,  emergencyActivated,      callButtonPressStartTime,  "boton principal");
    checkEmergencyLongPress(calls1ButtonLongPress, calls1EmergencyActivated, calls1ButtonPressStartTime, "boton calls1");

    if (inScreen6) {
        if (ui_Switchtms) {
            bool sw = lv_obj_has_state(ui_Switchtms, LV_STATE_CHECKED);
            if (sw != monitorSerialEnabled) {
                monitorSerialEnabled = sw;
                debugPrintln(monitorSerialEnabled ? "Monitor ACTIVADO" : "Monitor DESACTIVADO");
            }
        }
        if (ui_Sliderbrillo) {
            int sv = lv_slider_get_value(ui_Sliderbrillo);
            if (sv < MIN_BRIGHTNESS_LEVEL) sv = MIN_BRIGHTNESS_LEVEL;
            if (sv > MAX_BRIGHTNESS_LEVEL) sv = MAX_BRIGHTNESS_LEVEL;
            if (sv != currentBrightnessLevel) {
                currentBrightnessLevel = sv;
                Set_Backlight(currentBrightnessLevel);
                preferences.begin("sys_cfg", false);
                preferences.putUInt("brightness", currentBrightnessLevel);
                preferences.end();
                settleFlashAfterNvsWrite();
                debugPrintln("Brillo: " + String(currentBrightnessLevel) + "%");
            }
        }
    }

    delay(5);
}

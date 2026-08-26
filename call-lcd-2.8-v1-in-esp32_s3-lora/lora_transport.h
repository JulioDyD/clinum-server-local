#pragma once
#include <Arduino.h>

// ============================================================
// LoraTransport — driver para modulos REYAX RYLR998 (UART/AT)
// Banda 868/915 MHz, control por comandos AT, recepcion +RCV=..
// Compatible con ESP32, ESP32-S3 y ESP32-C3 (Arduino core 2.x/3.x).
// ============================================================

#define LORA_LINE_MAX 200   // Payload maximo por mensaje LoRa (bytes)
#define LORA_CMD_MAX 300    // Comando AT+SEND completo

struct LoraConfig {
  int8_t   rxPin = -1;          // Pin RX del ESP32 -> TXD del modulo
  int8_t   txPin = -1;          // Pin TX del ESP32 -> RXD del modulo
  uint32_t baud = 115200;
  uint16_t address = 0x0001;    // Direccion local (4 digitos hex)
  uint8_t  networkId = 18;      // Network ID de la red LoRa (debe ser igual en todos los modulos)
  uint32_t frequencyHz = 915000000UL;
  uint8_t  sf = 9;              // Spreading factor 7..12
  uint8_t  bw = 7;              // 7=125kHz, 8=250kHz, 9=500kHz
  uint8_t  cr = 1;              // Coding rate 1..4
  uint8_t  preamble = 12;
  uint8_t  crc = 1;             // CRC on/off
  uint8_t  txPowerDbm = 22;     // 0..22 dBm
  uint32_t atTimeoutMs = 1200;
};

class LoraTransport {
public:
  void begin(HardwareSerial& ser, const LoraConfig& cfg) {
    _ser = &ser;
    _cfg = cfg;
    _ser->begin(cfg.baud, SERIAL_8N1, cfg.rxPin, cfg.txPin);
    _ser->setRxBufferSize(1024);
    _ser->setTimeout(cfg.atTimeoutMs);
  }

  // Configura el modulo con secuencia AT. Devuelve false si no responde.
  bool configure() {
    if (!_ser) return false;
    delay(300); // tiempo para que el modulo arranque tras el reset del ESP

    // 1) Detectar baudrate real del modulo (se persiste en flash y puede no ser 115200).
    const unsigned long BAUDS[] = {115200, 9600, 57600, 19200, 38400};
    bool found = false;
    for (size_t i = 0; i < sizeof(BAUDS) / sizeof(BAUDS[0]); i++) {
      _ser->begin(BAUDS[i], SERIAL_8N1, _cfg.rxPin, _cfg.txPin);
      delay(50);
      drain();
      _ser->print("AT\r\n");
      char resp[64];
      uint32_t start = millis();
      while (millis() - start < _cfg.atTimeoutMs) {
        if (readLine(resp, sizeof(resp))) {
          if (strncmp(resp, "+OK", 3) == 0 || strncmp(resp, "OK", 2) == 0) {
            found = true;
            if (BAUDS[i] != 115200) {
              _ser->print("AT+IPR=115200\r\n");
              delay(300);
              _ser->end();
              _ser->begin(115200, SERIAL_8N1, _cfg.rxPin, _cfg.txPin);
              delay(100);
              drain();
            }
            break;
          }
        }
      }
      if (found) break;
    }
    if (!found) return false;

    // 2) Configuracion normal.
    if (!_cmdOk("AT")) return false;
    char buf[48];
    snprintf(buf, sizeof(buf), "AT+ADDRESS=%04X", _cfg.address);
    _cmdOk(buf);
    snprintf(buf, sizeof(buf), "AT+NETWORKID=%u", _cfg.networkId);
    _cmdOk(buf);
    snprintf(buf, sizeof(buf), "AT+BAND=%lu", (unsigned long)_cfg.frequencyHz);
    _cmdOk(buf);
    snprintf(buf, sizeof(buf), "AT+PARAMETER=%u,%u,%u,%u,%u",
             _cfg.sf, _cfg.bw, _cfg.cr, _cfg.preamble, _cfg.crc);
    _cmdOk(buf);
    snprintf(buf, sizeof(buf), "AT+CRFOP=%u", _cfg.txPowerDbm);
    _cmdOk(buf);
    _cmdOk("AT+MODE=0");
    return true;
  }

  // Envia una linea de payload ASCII a una direccion RYLR998 de destino.
  // FFFF = broadcast.
  bool sendLine(uint16_t dest, const char* line) {
    if (!_ser || !line) return false;
    size_t len = strlen(line);
    if (len == 0 || len >= LORA_LINE_MAX) return false;
    char cmd[LORA_CMD_MAX];
    int n = snprintf(cmd, sizeof(cmd), "AT+SEND=%04X,%u,%s\r\n",
                     dest, (unsigned)len, line);
    if (n <= 0 || n >= (int)sizeof(cmd)) return false;
    _ser->print(cmd);
    return true;
  }

  // Lee una linea completa del modulo (hasta '\n'). Timeout con false.
  bool readLine(char* buf, size_t size) {
    if (!_ser || size < 2) return false;
    size_t idx = 0;
    uint32_t start = millis();
    while (millis() - start < _cfg.atTimeoutMs) {
      while (_ser->available()) {
        char c = (char)_ser->read();
        if (c == '\n') {
          if (idx > 0 && buf[idx - 1] == '\r') buf[--idx] = '\0';
          else buf[idx] = '\0';
          return idx > 0;
        }
        if (c == '\r') continue;
        if (idx + 1 < size) buf[idx++] = c;
      }
      delay(2);
    }
    buf[0] = '\0';
    return false;
  }

  // Si la linea es "+RCV=len,addr,data" extrae addr y payload.
  // Devuelve false para lineas de estado (OK, +SEND, errores).
  bool parseRcv(const char* line, char* out, size_t outSize, uint16_t* srcAddr) {
    if (strncmp(line, "+RCV=", 5) != 0) return false;
    // Formato real del RYLR998: +RCV=<addr>,<len>,<data>,<rssi>,<snr>
    const char* p = line + 5;               // addr
    const char* c1 = strchr(p, ',');
    if (!c1) return false;
    const char* c2 = strchr(c1 + 1, ',');   // len
    if (!c2) return false;
    char addr[8] = {0};
    size_t addrLen = (size_t)(c1 - p);
    if (addrLen > 4) addrLen = 4;
    memcpy(addr, p, addrLen);
    if (srcAddr) *srcAddr = (uint16_t)strtoul(addr, nullptr, 16);
    char lenBuf[8] = {0};
    size_t lenLen = (size_t)(c2 - (c1 + 1));
    if (lenLen > 7) lenLen = 7;
    memcpy(lenBuf, c1 + 1, lenLen);
    long dataLen = strtol(lenBuf, nullptr, 10);
    const char* data = c2 + 1;
    if (dataLen < 0) dataLen = 0;
    if ((size_t)dataLen >= outSize) dataLen = (long)outSize - 1;
    memcpy(out, data, (size_t)dataLen);
    out[dataLen] = '\0';
    return true;
  }

  // Descarta bytes residuales del RX (eco o respuestas AT viejas).
  void drain() {
    if (!_ser) return;
    while (_ser->available()) _ser->read();
  }

private:
  HardwareSerial* _ser = nullptr;
  LoraConfig _cfg;

  bool _cmdOk(const char* cmd) {
    if (!_ser) return false;
    drain();
    _ser->print(cmd);
    _ser->print("\r\n");
    char resp[64];
    uint32_t start = millis();
    while (millis() - start < _cfg.atTimeoutMs) {
      if (readLine(resp, sizeof(resp))) {
        // El RYLR998 responde "+OK". Se ignoran el eco del comando y el ruido
        // de arranque ("+ERR=1" por basura del boot del ESP) para esperar el
        // "+OK" real; si no llega a tiempo, timeout => false.
        if (strncmp(resp, "+OK", 3) == 0 || strncmp(resp, "OK", 2) == 0) return true;
      }
    }
    return false;
  }
};

// Divide una linea de payload en tokens (reemplaza ',' por '\0').
// Devuelve la cantidad de tokens encontrados.
static inline int loraSplitTokens(char* line, char** out, int maxTokens) {
  int count = 0;
  char* p = line;
  while (count < maxTokens) {
    out[count++] = p;
    char* comma = strchr(p, ',');
    if (!comma) break;
    *comma = '\0';
    p = comma + 1;
  }
  return count;
}
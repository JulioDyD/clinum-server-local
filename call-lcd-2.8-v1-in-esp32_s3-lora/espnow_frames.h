#ifndef ESPNOW_FRAMES_H
#define ESPNOW_FRAMES_H

#include <stdint.h>

// Forward declaration: el struct EspNowCallFrame se define en el .ino.
// El preprocesador de Arduino genera prototipos de funciones del sketch al
// inicio del .ino.cpp, ANTES de la definicion del struct; sin esta declaracion
// el prototipo de sendCallFrameOverLora() no compilaria.
struct EspNowCallFrame;

// ----------------------------------------
// Tipos de mensaje ESP-NOW
// ----------------------------------------
// 1  CALL_START   — Inicio de llamada
// 2  CALL_INSIST  — Insistencia (consecutivo)
// 3  CALL_END     — Fin de llamada
// 4  HEARTBEAT    — Keep-alive / presencia broadcast
// 5  ACK          — Confirmacion de entrega
// 6  CONFIG       — Configuracion remota
// 7  REGISTER     — Registro del dispositivo
// 8  RELAY_REQ    — Peticion de relay (broadcast)
// 9  RELAY_CONFIRM — Confirmacion de relay (unicast al emisor)

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

// Frame embebido en RELAY_REQ (igual al EspNowCallFrame del .ino)
struct __attribute__((packed)) EspNowCallFrameEmbed {
    uint8_t msgType;
    uint32_t seq;
    uint32_t sentAtMs;
    uint16_t cons;
    uint8_t isEmergency;
    char deviceId[13];
};

// RELAY_REQ: broadcast — solicita que un nodo intermedio reenvie el frame al gateway
// Tamaño total: 1+4+6+6+4+1+13+sizeof(EspNowCallFrameEmbed) = 60 bytes
struct __attribute__((packed)) EspNowRelayReqFrame {
    uint8_t  msgType;          // ESPNOW_MSG_RELAY_REQ = 8
    uint32_t relaySeq;         // Secuencia de este frame relay (del emisor original)
    uint8_t  origMac[6];       // MAC del emisor ORIGINAL (nunca cambia en la cadena)
    uint8_t  prevHopMac[6];    // MAC del nodo que me envio este RELAY_REQ (a quien le envio el CONFIRM)
    uint32_t origSeq;          // seq del frame original (matching en RELAY_CONFIRM)
    uint8_t  ttl;              // Saltos maximos restantes (4 = hasta 4 relays)
    char     deviceId[13];     // deviceId del emisor ORIGINAL, explicito (NO derivar de "embedded":
                               // embedded puede contener un EspNowRegisterFrame (deviceId en offset 9)
                               // o un EspNowCallFrame (deviceId en offset 12) — layouts distintos, por
                               // eso leer "embedded.deviceId" como si siempre fuera CallFrame corrompe
                               // el deviceId cuando lo embebido es un REGISTER (ver bug de registro-via-relay)
    EspNowCallFrameEmbed embedded; // Frame original completo
};

// RELAY_CONFIRM: unicast al emisor original — confirma que el relay entrego el frame
// Tamaño: 1+4+1+13+4 = 23 bytes
struct __attribute__((packed)) EspNowRelayConfirmFrame {
    uint8_t  msgType;          // ESPNOW_MSG_RELAY_CONFIRM = 9
    uint32_t origSeq;          // seq del frame original (debe coincidir)
    uint8_t  result;           // 1=entregado al gateway, 0=fallo
    char     deviceId[13];     // deviceId del emisor original
    uint32_t epochS;           // hora epoch (segundos) del nodo relay al momento de confirmar,
                               // 0 = relay aun no tiene su propio reloj sincronizado.
                               // Permite que el emisor original ajuste su reloj aunque se haya
                               // registrado/conectado via relay (nunca ve el ACK real del gateway).
};

#endif

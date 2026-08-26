# ESP-NOW + LoRa Local Bridge — Protocolo LoRa v1

Transporte complementario al protocolo `espnow-local-bridge-v1.md` para
llamadores y lámparas en zonas con RF degradada (baños, aislamiento, salas de
procedimiento). Usa módulos **REYAX RYLR998** (UART/AT, banda 915 MHz) en modo
estrella: el llamador/lámpara hace **un solo salto LoRa** hacia el gateway o un
nodo puente; la malla multi-salto se mantiene sobre ESP-NOW.

## Reglas generales

- Cada dispositivo LoRa tiene una **dirección RYLR998** única (4 dígitos hex).
- El payload se envía en **ASCII compacto**, un mensaje por línea, sin saltos
  de línea internos.
- Uplink y downlink reutilizan la misma semántica clínica de ESP-NOW:
  `seq` monotónico, `cons`, emergencia, `deviceId`/`lampId`.
- El **gateway** parsea el uplink LoRa y emite **el mismo JSON por serial**
  hacia `clinum-web-local` (los campos coinciden con `espnow-local-bridge-v1.md`).
- El ACK del servidor es la confirmación final (igual que en ESP-NOW).

## Configuración radio (valores iniciales sugeridos)

| Parámetro | Valor |
|---|---|
| Frecuencia | 915.0 MHz (Américas, FCC 902.3–927.9) |
| SF / BW / CR | 9 / 125 kHz / 4/5 (código AT `9,7,1`) |
| Preamble / CRC | 12 / on |
| Potencia TX | 22 dBm (≤ 14 dBm si se requiere CE) |
| Dirección gateway | `0x0001` |
| Direcciones llamadores | `0x0010..0x001F` por zona |
| Direcciones lámparas | `0x0020..0x002F` por zona |
| Dirección nodo puente | `0x0100..` |

> Separación de canales FCC 0.2 MHz: usar un canal por zona si hay varias zonas
> LoRa cercanas entre sí. Ajustar SF/canales según mediciones en sitio.

## Uplink (llamador/lámpara → gateway)

### Llamador

```
REG,<deviceId>,<seq>
CS,<deviceId>,<seq>,<cons>,<emergency>
CI,<deviceId>,<seq>,<cons>,<emergency>
CE,<deviceId>,<seq>
HB,<deviceId>,<seq>
CACK,<deviceId>,<seq>[,<result>]
```

`emergency` es `0`/`1`. `CACK` confirma el `CFG` recibido (`result`: 0=fallido, 1=ok).

### Lámpara

```
LAMP_REG,<lampId>,<seq>,<sentAtMs>,<deviceType>,<relayCapable>,<protocolVersion>
LAMP_HB,<lampId>,<seq>,<sentAtMs>,<appliedRevision>,<appliedState>,<relayCapable>,<rssi>
LAMP_SNAP,<lampId>,<seq>,<sentAtMs>,<appliedRevision>
LAMP_ACK,<lampId>,<commandSeq>,<stateRevision>,<appliedState>,<result>
TEST_ACK,<lampId>,<commandSeq>,<stateRevision>,<appliedState>,<result>
```

`appliedState`/`result` numéricos (0=off/1=normal/2=emergency; result:
0=invalid, 1=applied, 2=duplicate/old).

## Downlink (gateway → llamador/lámpara)

```
ACK,<deviceId>,<seq>,<result>,<callActive>,<callType>,<callStartedAtS>,<callCons>,<callStartSeq>,<epochS>
CFG,<deviceId>,<seq>,<applyBrightness>,<brightness>,<applyAudioAlert>,<audioAlertEnabled>,<applyName>,<name>,<endCall>,<targetCallSeq>
TIME,<epochS>
LAMP_STATE,<lampId>,<commandSeq>,<stateRevision>,<associationRevision>,<effectiveState>,<normalToggleMs>,<emergencyToggleMs>,<colorPreset>,<animationPreset>,<soundPreset>,<audioEnabled>,<brightness>,<buzzerVolume>
LAMP_TEST,<lampId>,<commandSeq>,<testState>,<durationMs>,<colorPreset>,<animationPreset>,<soundPreset>,<audioEnabled>,<brightness>,<buzzerVolume>
```

`CFG` para llamadores LoRa solo incluye los campos que aplican a un terminal
LoRa (brillo LCD, alerta de audio, nombre y fin de llamada remoto).

## Ruteo en el gateway

- Tabla única por `deviceId`/`lampId` con el transporte activo
  (`espnow` o `lora`) y, para LoRa, la dirección RYLR998 de destino.
- El gateway aprende la dirección del emisor desde `+RCV=<len>,<addr>,<data>`.
- El downlink del servidor (ACK, config, lamp_state, lamp_test, time_sync) se
  envía por el transporte correspondiente.

## Fiabilidad

- Reintentos y ACK final del servidor idénticos a ESP-NOW.
- Deduplicación por `(deviceId, seq)` compartida entre transportes.
- El tiempo al aire LoRa es mayor que ESP-NOW: mantener mensajes cortos y
  limitar la tasa (heartbeat 30–60 s en LoRa).
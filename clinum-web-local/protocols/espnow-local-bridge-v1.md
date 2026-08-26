# ESP-NOW Local Bridge Protocol v1

ASCII JSON over serial, one JSON object per line.

## Envelope

All frames must include:

- `msgType`: string
- `deviceId`: string
- `seq`: number (monotonic per device)
- `sentAtMs`: number (device millis or epoch ms)

## Uplink events (gateway -> local)

### call_start

```json
{"msgType":"call_start","deviceId":"A1B2C3D4E5F6","seq":101,"sentAtMs":1234567,"call_type":"normal","cons":1}
```

### call_insist

```json
{"msgType":"call_insist","deviceId":"A1B2C3D4E5F6","seq":102,"sentAtMs":1235567,"call_type":"normal","cons":2}
```

### call_end

```json
{"msgType":"call_end","deviceId":"A1B2C3D4E5F6","seq":103,"sentAtMs":1236567}
```

### heartbeat

```json
{"msgType":"heartbeat","deviceId":"A1B2C3D4E5F6","seq":104,"sentAtMs":1237567,"rssi":-63,"hops":1}
```

## Downlink commands (local -> gateway)

### ack

```json
{"msgType":"ack","deviceId":"A1B2C3D4E5F6","seq":103,"result":"ok"}
```

### config_update

```json
{"msgType":"config_update","deviceId":"A1B2C3D4E5F6","config":{"audioAlert":true,"brightness":80}}
```

### lamp_state

```json
{"msgType":"lamp_state","lampId":"A1B2C3D4E5F6","commandSeq":501,"stateRevision":1786572000001,"associationRevision":201,"effectiveState":2,"normalToggleMs":500,"emergencyToggleMs":200,"colorPreset":0,"animationPreset":4,"soundPreset":4,"audioEnabled":true,"brightness":100}
```

`effectiveState` usa `0=off`, `1=normal`, `2=emergency`. Los presets de color, animación y sonido aceptan `0..19`.

### lamp_test

```json
{"msgType":"lamp_test","lampId":"A1B2C3D4E5F6","commandSeq":502,"testState":1,"durationMs":3000}
```

## Lamp uplink events

Las lámparas usan `lampId` en lugar de `deviceId`: `lamp_register`, `lamp_heartbeat`, `lamp_snapshot_request`, `lamp_state_ack` y `lamp_test_ack`.

El servidor conserva un snapshot pendiente por lámpara. Un snapshot nuevo reemplaza al anterior y se reintenta a los 150, 400, 900 y 1900 ms acumulados; después, cada 2 s. Solo un `lamp_state_ack` con la misma `stateRevision` confirma la entrega.

## Rules

- Deduplicate by (`deviceId`, `seq`).
- Ignore stale `seq` values lower than latest accepted.
- ACK every accepted frame.
- `call_end` has high priority and must be retried by gateway until ACK.
- Local server is source of truth for last accepted sequence per device.

# gatenway-2.8-in-espnow

Gateway firmware role for ESP-NOW mesh callers.

## Responsibilities

- Receive ESP-NOW frames from caller nodes (vertical and horizontal).
- Forward normalized JSON line frames to local server over serial.
- Retry important frames (especially `call_end`) until ACK from local server.
- Receive config downlink frames from local server and forward to target caller.

## Serial framing

One JSON frame per line. Use protocol doc:

- `clinum-web-local/protocols/espnow-local-bridge-v1.md`

## Priority behavior

- Highest: `call_end`
- High: `call_start`, `call_insist`
- Medium: `heartbeat`

## Required reliability

- Keep last `seq` per device to avoid sending stale events.
- Support resend window and exponential backoff.
- Expose serial debug traces for commissioning.

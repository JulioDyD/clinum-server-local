# clinum-web-local

Local server for ESP-NOW mesh callers.

## Goal

Keep the current call logic already used by callers and Firestore, but replace WiFi transport on caller devices with ESP-NOW mesh.

- Caller devices (`call-lcd-2.8-v1-in-espnow`, `call-lcd-2.8-h1-in-espnow`) send events to gateway over ESP-NOW mesh.
- Gateway (`gatenway-2.8-in-espnow`) forwards events to this local server via serial.
- Local server stores state, serves local realtime UI/API, and syncs with Firestore.
- Firestore config changes are mirrored back to local server and pushed to gateway.

## Recommended stack

- Runtime: Node.js 20+
- Language: TypeScript
- HTTP API: Fastify
- Realtime local UI: Socket.IO
- Serial transport: serialport + readline parser
- Firebase sync: firebase-admin
- Local persistence: SQLite con WAL

## Why this stack

- Node + serialport is stable for serial bridge workloads.
- TypeScript helps avoid protocol mistakes in clinical call flows.
- Fastify + Socket.IO provides low-latency local observability.
- Firebase Admin SDK gives secure server-to-server sync with existing Firestore model.

## Folder layout

- local-server/: runnable local bridge server
- protocols/: protocol docs for mesh <-> gateway <-> local server

## Data compatibility with existing Firestore

Use current `called/{deviceId}` shape to avoid breaking existing web/mobile monitoring:

- `deviceId`: string
- `active`: boolean
- `cons`: number
- `call_type`: "normal" | "emergency"
- `timestamp`: server timestamp (Firestore side)

## Lámparas sonoras

El servidor registra lámparas ESP-NOW por separado, mantiene presencia en tiempo real y ofrece una asignación muchos-a-muchos entre llamadores y lámparas. El estado se agrega con prioridad `emergency > normal > off`, por lo que una lámpara compartida no se apaga mientras conserve otro llamado activo.

La vista **Lámparas** permite configurar nombre, brillo, audio, pruebas y cinco perfiles de alerta. Cada perfil tiene 20 presets de color, animación y sonido. Actualmente `normal` y `emergency` están activos; `type3`, `type4` y `type5` quedan reservados para los próximos tipos de llamado.

## Operación

1. Compilar y cargar `gatenway-2.8-in-espnow/gatenway-2.8-in-espnow.ino`.
2. Instalar `Adafruit NeoPixel`, revisar pines y cargar `alert-lamp-espnow-sp32-c3/alert-lamp-espnow-sp32-c3.ino`.
3. Ejecutar `npm run build` y `npm start` dentro de `local-server/`.
4. Abrir el panel local y asignar una o varias lámparas a cada llamador.

## Próximos pasos

1. Validar pines, nivel eléctrico del buzzer y consumo del anillo en el hardware final.
2. Hacer pruebas RF de registro, relay y pérdida de ACK con varias lámparas.
3. Definir semántica clínica de los tipos de llamado 3, 4 y 5 antes de habilitarlos.

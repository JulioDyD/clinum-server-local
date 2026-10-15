# local-server

Bridge server between ESP-NOW gateway and local storage, with optional realtime sync to Firestore.

## Run

1. Copy `.env.example` to `.env`.
2. Install dependencies:

```bash
npm install
```

3. Start in one of these modes:

Local-only (no serial, no Firebase):

```bash
SERIAL_PORT=none
LOCAL_HTTP_PORT=8082
npm run start
```

Hybrid (serial + local persistence + Firestore sync):

```bash
SERIAL_PORT=COM5
LOCAL_HTTP_PORT=8081
FIREBASE_PROJECT_ID=clinum-2
GOOGLE_APPLICATION_CREDENTIALS=H:/path/service-account.json
npm run start
```

## Storage

- Local state is persisted to `LOCAL_DATA_FILE` (default `./data/state.json`).
- State survives process restarts.

## Endpoints

- `GET /health` (incluye `version`, `commit` y `uptimeSeconds`)
- `GET /api/version`
- `GET /calls/active`
- `GET /calls/all`

## Versionado

La versión actual vive en un solo lugar: `package.json` → `"version"`
(hoy **v1.0.0**). Se muestra en la UI (pestaña **Configuración** →
"Versión del sistema") y se sirve por `GET /api/version`.

Al ejecutar `npm run build` el script `prebuild`
(`scripts/write-version.mjs`) genera `dist/version.json` con versión,
commit, rama, fecha de compilación y versión de Node. Ese archivo se
ignora en git y se regenera siempre (el instalador de Linux compila en
la máquina destino).

Para subir la versión:

```bash
npm run version:patch   # 1.0.0 -> 1.0.1   (o version:minor / version:major)
npm run build
```

Los scripts usan `npm version --no-git-tag-version`: solo actualizan
`package.json` y `package-lock.json`, sin crear commits ni tags. Luego
se hace commit y push con normalidad.

## Realtime

Socket.IO emits:

- `call_state`
- `active_calls`

## Firestore

- Mirrors call state to `called/{deviceId}`.
- Mirrors online status to `devices_presence/{deviceId}`.
- Listens to `devices_config/{deviceId}` and forwards config to gateway.
- If cloud sync fails, local processing still continues and remains persisted.

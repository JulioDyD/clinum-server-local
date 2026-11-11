# Rollback Fase 0-1 (presencia agregada y ventana online)

## Qué cambió

- El puente local ya no escribe `devices` ni `devices_presence` en cada heartbeat.
- Publica un solo documento `site_presence/{LOCATION_ID}` cada ~ventana/2.
- `devices/{id}` solo se escribe cuando cambia un campo estable.
- `care_history` lo escribe el puente local con ID determinista. La Cloud Function
  `onCalledWrite` ignora documentos con `origin = "local-bridge"` y especiales.
- La ventana online se guarda en SQLite (`site_settings`) y se ajusta desde
  `site_settings/{LOCATION_ID}` en Firestore. La web la muestra en
  Configuración de sede.

## Banderas

En `local-server/.env`:

```dotenv
PRESENCE_MODE=aggregated   # legacy = comportamiento anterior
HISTORY_WRITER=local       # cloud = no escribir historial desde el puente
```

La bandera `HISTORY_WRITER=cloud` solo funciona si también se retira la guarda
`afterData.origin === 'local-bridge'` de `onCalledWrite` en las Cloud Functions.

## Rollback rápido

1. Detener el servicio local.
2. Editar `.env`:
   - `PRESENCE_MODE=legacy`
   - `HISTORY_WRITER=cloud` (solo si se revierte también la Cloud Function)
3. Restaurar copia de `data/clinum.db` si se necesita el estado anterior.
4. Reiniciar el servicio.
5. Redeploy de las Cloud Functions de la versión anterior si se revierte la guarda.

## Rollback de la Cloud Function

Las guardas son aditivas. Para volver atrás:

1. `git checkout <tag-anterior> -- functions/src/index.ts`
2. `cd functions && npm run build && firebase deploy --only functions`

No se modificó ningún esquema de Firestore existente. `site_presence` y
`site_settings` pueden quedar sin uso; no afectan a la operación.

## Verificación tras rollback

- `GET /health` debe mostrar `presenceMode: "legacy"` y los contadores.
- Los heartbeats deben volver a escribir `devices` y `devices_presence`.
- `care_history` debe volver a ser creado por `onCalledWrite` (si se revirtió
  también la guarda).

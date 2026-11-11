# Rollback Fase 2-3 (outbox, pacientes y sync de configuración)

## Qué cambió

- **Outbox durable:** las escrituras `called`, `devices` y `care_history` se
  encolan en SQLite (`cloud_outbox`) y se reintentan con backoff. Active con
  `OUTBOX=1`.
- **Pacientes:** Firestore es el dueño. El local espeja `patients` de la sede y
  bloquea POST/PATCH/DELETE locales con `PATIENTS_SOURCE=web`.
  Solo se reconcilian pacientes con `source='cloud'`; los locales antiguos se
  conservan.
- **Sincronización de configuración:** el local publica
  `site_sync/{LOCATION_ID}/sections/{settings|devices|lamps|presence}` y aplica
  comandos pendientes de `site_sync/{LOCATION_ID}/commands`.
  La web lee el estado y crea comandos desde Configuración → **Sede local**.

## Banderas

En `local-server/.env`:

```dotenv
OUTBOX=0            # desactiva el outbox y vuelve al envío directo
PATIENTS_SOURCE=local  # vuelve a permitir edición local de pacientes
```

La sincronización de configuración no tiene bandera propia: si el local no
publica `site_sync`, la web muestra el estado vacío y los comandos quedan
pendientes. Para desactivarla por completo, no se llama a
`startSiteCommandsWatch`/`publishAllSiteSections` (rollback de código).

## Rollback rápido

1. Detener el servicio local.
2. Editar `.env`:
   - `OUTBOX=0`
   - `PATIENTS_SOURCE=local`
3. Restaurar `data/clinum.db` si se necesita el estado anterior.
4. Reiniciar el servicio.
5. Redeploy de la versión anterior del servidor y de la web si se revierte la UI.

## Limpieza de datos nuevos

- `site_sync/*`: se puede dejar; no afecta la operación. Borrar si se desea.
- `site_presence/*`: se puede dejar.
- `cloud_outbox`: `DELETE /network/outbox` o `OUTBOX=0` y reiniciar.
- Pacientes espejo: los `source='cloud'` desaparecen si se desactiva el espejo;
  se pueden borrar manualmente si se requiere.

## Verificación tras rollback

- `GET /health` debe mostrar `outboxEnabled: false` y
  `patientsReadOnly: false`.
- Los pacientes vuelven a poder crearse/editarsedesde la UI local.
- Las escrituras a Firestore vuelven a ser directas.

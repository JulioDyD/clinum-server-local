# Rollback Fase 4-5 (optimización web y llamados especiales)

## Fase 4 — Optimización web

### Banderas

En `.env.local` / `.env.development` de `clinum-app`:

```dotenv
VUE_APP_LONG_POLLING=false   # true = vuelve al long polling anterior
VUE_APP_FIRESTORE_CACHE=true # false = caché en memoria (sin IndexedDB)
```

- `VUE_APP_LONG_POLLING=true` restaura el transporte HTTP polling.
- `VUE_APP_FIRESTORE_CACHE=false` desactiva `persistentLocalCache`; útil si un
  navegador concreto tiene problemas con IndexedDB.

### Listeners

`realtimeService.js` ahora usa suscripciones independientes por componente
(claves únicas, sin cancelar las de otras vistas) y ya no lee 24 h de `called`.
Para revertir, restaurar la versión anterior del archivo; no hay migración de
datos.

### Local

El listener legacy de `devices_config` quedó desactivado por defecto. Para
reactivarlo:

```dotenv
LEGACY_DEVICES_CONFIG=1
```

## Fase 5 — Llamados especiales

### Qué se agregó

- Visualización de `type3..type6` en Dashboard, Supervisor, pantalla de sala y
  monitor de llamados.
- Página `/special-calls` con tablero de especiales.
- Tokens de monitor con `callTypes` (todos, solo especiales o un tipo).
- Colección `special_call_acks` para ACK/atención.
- Comando `call.end` en `site_sync` para cerrar llamados desde el web.
- Reglas e índice para `special_call_acks` y `called(active, locationId)`.

### Rollback

- Ocultar la pestaña/botones de **Especiales** y la ruta `/special-calls`.
- Los tokens existentes sin `callTypes` siguen funcionando (ven todos los
  llamados).
- `special_call_acks` es una colección nueva; se puede dejar o borrar.
- El comando `call.end` es aditivo; si no se usa, el local no cambia.
- El índice `called(active, locationId)` es necesario para las consultas por
  sede; si se revierte la página, el índice puede quedarse sin uso.

### Reglas

Desplegar `firestore.rules` y `firestore.indexes.json` junto con la web. Sin
ellas, `/special-calls` y el ACK no funcionarán.

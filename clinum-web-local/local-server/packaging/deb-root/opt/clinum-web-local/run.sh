#!/bin/bash
# Wrapper de arranque en produccion.
# El entorno real (SERIAL_PORT, LOCAL_HTTP_PORT, etc.) se inyecta via
# EnvironmentFile=/etc/clinum-web-local/.env desde systemd.
set -e
export NODE_ENV=production
# systemd LoadCredential deja la credencial Firebase en un tmpfs privado.
if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -f "$CREDENTIALS_DIRECTORY/firebase" ]; then
  export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_DIRECTORY/firebase"
fi
cd /opt/clinum-web-local
exec /opt/clinum-web-local/runtime/bin/node /opt/clinum-web-local/dist/index.js

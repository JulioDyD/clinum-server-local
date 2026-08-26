#!/usr/bin/env bash
#
# install.sh - Instala el .deb, pide el puerto serial del gateway y arranca
# el servicio systemd en modo produccion (local: serial + SQLite, sin Firestore).
# Se ejecuta como root EN LA MAQUINA LINUX despues de build-deb.sh.
#
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETCDIR="/etc/clinum-web-local"
ENVFILE="$ETCDIR/.env"
DEB="$(ls -1 "$PKG_DIR"/*.deb 2>/dev/null | head -n1 || true)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta como root: sudo $0" >&2
  exit 1
fi

if [ -z "$DEB" ]; then
  echo "No se encontro ningun .deb en $PKG_DIR" >&2
  echo "Primero ejecuta: ./build-deb.sh" >&2
  exit 1
fi

read -r -p "Puerto serial del gateway [/dev/ttyUSB0]: " SERIAL_PORT
SERIAL_PORT="${SERIAL_PORT:-/dev/ttyUSB0}"

read -r -p "Puerto HTTP de la UI local [8081]: " HTTP_PORT
HTTP_PORT="${HTTP_PORT:-8081}"

echo "==> Instalando $DEB"
dpkg -i "$DEB"

# Crear .env por defecto si postinst no lo hizo
if [ ! -f "$ENVFILE" ]; then
  cp "$ETCDIR/.env.template" "$ENVFILE"
fi

# Actualizar solo los parametros pedidos, conservando el resto
sed -i -E "s|^SERIAL_PORT=.*|SERIAL_PORT=$SERIAL_PORT|" "$ENVFILE"
sed -i -E "s|^LOCAL_HTTP_PORT=.*|LOCAL_HTTP_PORT=$HTTP_PORT|" "$ENVFILE"
chown root:clinum "$ENVFILE"
chmod 0640 "$ENVFILE"

echo "==> Arrancando servicio systemd"
systemctl daemon-reload
systemctl restart clinum-web-local
systemctl status clinum-web-local --no-pager || true

echo
echo "Listo. UI local en: http://$(hostname -I | awk '{print $1}'):$HTTP_PORT/health"
echo "Logs: journalctl -u clinum-web-local -f"

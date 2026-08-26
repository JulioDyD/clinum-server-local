#!/usr/bin/env bash
#
# setup.sh - Instalacion completa y no interactiva de clinum-web-local.
# Compila la app con Node embebido, genera el .deb, instala, detecta el
# puerto serial del gateway y deja el servicio systemd habilitado al arranque.
#
# Uso:  sudo bash setup.sh [SERIAL_PORT] [HTTP_PORT]
#   SERIAL_PORT : si se omite, se autodetecta (/dev/ttyUSB0, /dev/ttyACM0, ...)
#   HTTP_PORT   : defecto 8081
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$SCRIPT_DIR"
if [ "$(basename "$PKG_DIR")" != "packaging" ] && [ -d "$PKG_DIR/packaging" ]; then
  PKG_DIR="$PKG_DIR/packaging"
fi
APP_DIR="$(cd "$PKG_DIR/.." && pwd)"
ROOT="$PKG_DIR/deb-root"
DEBIAN="$ROOT/DEBIAN"
OPT="$ROOT/opt/clinum-web-local"
OUTDIR="$APP_DIR/dist-deb"
ETCTPL="$ROOT/etc/clinum-web-local"

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta como root: sudo bash $0" >&2
  exit 1
fi

SERIAL_PORT="${1:-}"
HTTP_PORT="${2:-8081}"
NODE_VERSION="20.18.1"

echo "==> App dir : $APP_DIR"
echo "==> HTTP    : $HTTP_PORT"

# 1. Dependencias del sistema
echo "==> Instalando dependencias apt"
export DEBIAN_FRONTEND=noninteractive
# El repo de Google Chrome puede tener clave GPG vieja en este equipo; lo ignoramos
# (no afecta los paquetes que necesitamos, que vienen de Ubuntu/Mint).
apt-get update -qq || true
apt-get install -y build-essential python3 make dpkg-dev curl adduser systemd

# 2. Compilador C++20 (better-sqlite3 v12 requiere >= g++-10)
if ! command -v g++-10 >/dev/null 2>&1 && ! command -v g++-11 >/dev/null 2>&1; then
  apt-get install -y g++-10 || apt-get install -y g++-11
fi
CXXCAND=""
for c in g++-13 g++-12 g++-11 g++-10; do
  if command -v "$c" >/dev/null 2>&1; then CXXCAND="$c"; break; fi
done
export CXX="${CXXCAND:-g++}"
echo "==> CXX     : $CXX"

# 3. Runtime Node embebido
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  NODE_ARCH="x64"   ;;
  aarch64) NODE_ARCH="arm64" ;;
  armv7l)  NODE_ARCH="armv7l";;
  *) echo "Arquitectura no soportada: $ARCH" >&2; exit 1 ;;
esac
NODE_TAR="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}"
RUNTIME="$OPT/runtime"
rm -rf "$RUNTIME"; mkdir -p "$RUNTIME"
if [ ! -f "/tmp/$NODE_TAR" ]; then
  echo "==> Descargando Node $NODE_VERSION ($NODE_ARCH)"
  curl -fSL "$NODE_URL" -o "/tmp/$NODE_TAR"
fi
tar -xJf "/tmp/$NODE_TAR" -C "$RUNTIME" --strip-components=1
export PATH="$RUNTIME/bin:$PATH"
echo "==> Node    : $(node -v) | npm $(npm -v)"

# 4. Instalar y compilar la app
cd "$APP_DIR"
if [ -f "$APP_DIR/package-lock.json" ]; then
  echo "==> npm ci"
  npm ci
else
  echo "==> npm install"
  npm install
fi
echo "==> npm run build"
npm run build
echo "==> npm prune --omit=dev"
npm prune --omit=dev

# 5. Poblar /opt
rm -rf "$OPT/dist" "$OPT/node_modules" "$OPT/public"
cp -r "$APP_DIR/dist"         "$OPT/dist"
cp -r "$APP_DIR/node_modules" "$OPT/node_modules"
cp -r "$APP_DIR/public"       "$OPT/public"

# 6. .env dentro del paquete (requerido por conffiles)
mkdir -p "$ETCTPL"
if [ ! -f "$ETCTPL/.env" ]; then
cat > "$ETCTPL/.env" <<'ENVEOF'
# Clinum local bridge - configuracion de produccion (solo local: serial + SQLite)
LOCAL_HTTP_PORT=8081
SERIAL_PORT=/dev/ttyUSB0
SERIAL_BAUD=115200
LOCAL_DB_FILE=/var/lib/clinum-web-local/clinum.db
LOCAL_ONLY=1
CORS_ORIGIN=*
ENVEOF
fi

# 7. Permisos
find "$ROOT" -type d -exec chmod 0755 {} +
chmod 0644 "$DEBIAN/control" "$DEBIAN/conffiles"
chmod 0755 "$DEBIAN/postinst" "$DEBIAN/prerm" "$DEBIAN/postrm" "$OPT/run.sh"
# Archivos legibles/ejecutables por el usuario del servicio (clinum),
# independientemente del umask con el que se compilo.
chmod -R go+rX "$OPT"

# 8. Construir .deb
mkdir -p "$OUTDIR"
VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo 0.1.0)"
DEB="$OUTDIR/clinum-web-local_${VERSION}_amd64.deb"
rm -f "$DEB"
dpkg-deb --build --root-owner-group "$ROOT" "$DEB"
echo "==> .deb   : $DEB"

# 9. Detectar puerto serial del gateway
if [ -z "$SERIAL_PORT" ]; then
  if [ -e /dev/ttyUSB0 ]; then SERIAL_PORT="/dev/ttyUSB0"; fi
  if [ -z "$SERIAL_PORT" ] && [ -e /dev/ttyACM0 ]; then SERIAL_PORT="/dev/ttyACM0"; fi
  if [ -z "$SERIAL_PORT" ]; then
    SERIAL_PORT="$(ls -1 /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | head -n1)"
  fi
  if [ -z "$SERIAL_PORT" ]; then SERIAL_PORT="/dev/ttyUSB0"; fi
fi
echo "==> Serial  : $SERIAL_PORT"

# 10. Instalar
dpkg -i "$DEB"

# 11. Configurar .env y arrancar el servicio
ENVFILE="/etc/clinum-web-local/.env"
if [ ! -f "$ENVFILE" ]; then
  if [ -f "$ETCTPL/.env.template" ]; then
    cp "$ETCTPL/.env.template" "$ENVFILE"
  else
    cp "$ETCTPL/.env" "$ENVFILE"
  fi
fi
sed -i -E "s|^SERIAL_PORT=.*|SERIAL_PORT=$SERIAL_PORT|" "$ENVFILE"
sed -i -E "s|^LOCAL_HTTP_PORT=.*|LOCAL_HTTP_PORT=$HTTP_PORT|" "$ENVFILE"
chown root:clinum "$ENVFILE"; chmod 0640 "$ENVFILE"

systemctl daemon-reload
systemctl enable clinum-web-local
systemctl restart clinum-web-local
systemctl status clinum-web-local --no-pager || true

echo
echo "Listo. UI local en: http://$(hostname -I | awk '{print $1}'):$HTTP_PORT/health"
echo "Logs: journalctl -u clinum-web-local -f"

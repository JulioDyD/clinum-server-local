#!/usr/bin/env bash
#
# build-deb.sh - Genera el paquete .deb de clinum-web-local para Linux Mint/Ubuntu.
# Se ejecuta EN LA MAQUINA LINUX (no en Windows). Requisitos:
#   sudo apt install -y build-essential python3 make g++ dpkg-dev curl
#
# El binario de Node 20 se embebe en el paquete; los modulos nativos
# (better-sqlite3, serialport) se compilan con ese mismo Node.
#
set -euo pipefail

PKG_NAME="clinum-web-local"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$SCRIPT_DIR/deb-root"
DEBIAN="$ROOT/DEBIAN"
OUTDIR="$APP_DIR/dist-deb"

NODE_VERSION="20.18.1"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  NODE_ARCH="x64";   DEB_ARCH="amd64" ;;
  aarch64) NODE_ARCH="arm64";  DEB_ARCH="arm64" ;;
  armv7l)  NODE_ARCH="armv7l"; DEB_ARCH="armhf" ;;
  *) echo "Arquitectura no soportada: $ARCH" >&2; exit 1 ;;
esac

echo "==> Empaquetando $PKG_NAME para $DEB_ARCH (Node $NODE_VERSION)"

# better-sqlite3 (v12) requiere C++20 => g++ >= 11. Autodetectar uno suficientemente nuevo.
if [ -z "${CXX:-}" ]; then
  for cand in g++-13 g++-12 g++-11 g++-10; do
    if command -v "$cand" >/dev/null 2>&1; then
      export CXX="$cand"
      break
    fi
  done
fi
echo "==> CXX: ${CXX:-g++ (por defecto)}"

# 1. Descargar runtime de Node (embebido en /opt/clinum-web-local/runtime)
NODE_TAR="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}"
RUNTIME="$ROOT/opt/$PKG_NAME/runtime"
rm -rf "$RUNTIME"
mkdir -p "$RUNTIME"
if [ ! -f "/tmp/$NODE_TAR" ]; then
  echo "==> Descargando Node $NODE_VERSION ($NODE_ARCH)"
  if ! curl -fSL "$NODE_URL" -o "/tmp/$NODE_TAR"; then
    if [ "${INSECURE_DOWNLOAD:-0}" = "1" ]; then
      echo "==> Reintentando descarga sin verificar SSL (INSECURE_DOWNLOAD=1)"
      curl -fSLk "$NODE_URL" -o "/tmp/$NODE_TAR"
    else
      echo "Fallo la descarga por problema de certificado SSL." >&2
      echo "Causa comun: el reloj del sistema esta atrasado." >&2
      echo "Corrige la fecha con:  sudo timedatectl set-ntp true" >&2
      echo "O, si no hay hora de red, fija la fecha manualmente:  sudo date -s 'YYYY-MM-DD HH:MM:SS'" >&2
      echo "Tambien puedes forzar la descarga sin verificar:  INSECURE_DOWNLOAD=1 $0" >&2
      exit 1
    fi
  fi
fi
tar -xJf "/tmp/$NODE_TAR" -C "$RUNTIME" --strip-components=1
export PATH="$RUNTIME/bin:$PATH"
echo "==> Node: $(node -v) | npm: $(npm -v)"

# 2. Instalar dependencias y compilar con el Node embebido
cd "$APP_DIR"
if [ -f "$APP_DIR/package-lock.json" ]; then
  echo "==> npm ci"
  npm ci
else
  echo "==> package-lock.json no encontrado: usando npm install"
  npm install
fi
echo "==> npm run build (tsc)"
npm run build
echo "==> npm prune --omit=dev"
npm prune --omit=dev

# 3. Poblar el arbol /opt/clinum-web-local
OPT="$ROOT/opt/$PKG_NAME"
rm -rf "$OPT/dist" "$OPT/node_modules" "$OPT/public"
cp -r "$APP_DIR/dist"         "$OPT/dist"
cp -r "$APP_DIR/node_modules" "$OPT/node_modules"
cp -r "$APP_DIR/public"       "$OPT/public"

# 4. Control con la arquitectura correcta
sed -i "s/__ARCH__/$DEB_ARCH/" "$DEBIAN/control"

# 5. Permisos
chmod 0755 "$DEBIAN/postinst" "$DEBIAN/prerm" "$DEBIAN/postrm" "$OPT/run.sh"
chmod 0644 "$DEBIAN/control" "$DEBIAN/conffiles"

# 5b. Permisos de directorios (dpkg-deb exige 0755..0775 en DEBIAN y el arbol)
find "$ROOT" -type d -exec chmod 0755 {} +
chmod 0644 "$DEBIAN/control" "$DEBIAN/conffiles"
chmod 0755 "$DEBIAN/postinst" "$DEBIAN/prerm" "$DEBIAN/postrm" "$OPT/run.sh"

# 6. Construir el .deb
mkdir -p "$OUTDIR"
VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo 0.1.0)"
DEB="$OUTDIR/${PKG_NAME}_${VERSION}_${DEB_ARCH}.deb"
rm -f "$DEB"
dpkg-deb --build --root-owner-group "$ROOT" "$DEB"
echo "==> Generado: $DEB"
echo "==> Ahora ejecuta: sudo ./install.sh"

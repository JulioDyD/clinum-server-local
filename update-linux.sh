#!/bin/bash
set -e

echo "========================================"
echo "CLINUM SERVER - ACTUALIZADOR"
echo "========================================"

if [ "$EUID" -ne 0 ]; then 
    echo "Por favor ejecuta como root o con sudo"
    exit 1
fi

echo "[1/5] Creando backup..."
BACKUP_FILE="/var/backups/clinum/backup-$(date +%Y%m%d_%H%M%S).tar.gz"
mkdir -p /var/backups/clinum
tar -czf $BACKUP_FILE -C /opt/clinum-server .
echo "Backup creado: $BACKUP_FILE"

echo "[2/5] Deteniendo servicio..."
systemctl stop clinum-server

echo "[3/5] Actualizando desde GitHub..."
cd /tmp
rm -rf clinum-server-local
git clone https://github.com/JulioDyD/clinum-server-local.git clinum-server-local
cd clinum-server-local/clinum-web-local/local-server
npm ci
npm rebuild better-sqlite3 serialport 2>/dev/null || true
npm run build

# Validar que el build generó dist/index.js
if [ ! -f dist/index.js ]; then
  echo "ERROR: La compilación TypeScript falló"
  exit 1
fi

if [ -f /opt/clinum-server/.env ]; then
    echo "Manteniendo configuración existente..."
    cp /opt/clinum-server/.env .env
else
    cat > .env << EOF
LOCAL_HTTP_PORT=8081
SERIAL_PORT=/dev/ttyACM0
SERIAL_BAUD=115200
FIREBASE_PROJECT_ID=clinum-production
LOCAL_DB_FILE=/var/lib/clinum/clinum.db
LOCAL_ONLY=false
CORS_ORIGIN=*
NODE_ENV=production
EOF
fi

# Validar que el archivo .env existe
if [ ! -f .env ]; then
  echo "ERROR: No se pudo crear/actualizar el archivo .env"
  exit 1
fi
echo "Archivo .env configurado correctamente"

echo "[4/5] Instalando actualización..."
shopt -s dotglob
cp -ra * /opt/clinum-server/
test -f /opt/clinum-server/.env && echo ".env copiado correctamente" || echo "ADVERTENCIA: .env no fue copiado"
cd /opt/clinum-server
chown -R clinum:clinum /opt/clinum-server

systemctl daemon-reload
systemctl restart clinum-server
systemctl status clinum-server --no-pager || true

echo ""
echo "========================================"
echo "ACTUALIZACION COMPLETADA!"
echo "========================================"
systemctl status clinum-server --no-pager
echo "========================================"

#!/bin/bash
set -e

echo "========================================"
echo "CLINUM SERVER - ACTUALIZADOR"
echo "========================================"

if [ "$EUID" -ne 0 ]; then 
    echo "Por favor ejecuta como root o con sudo"
    exit 1
fi

echo "[1/4] Creando backup..."
BACKUP_FILE="/var/backups/clinum/backup-$(date +%Y%m%d_%H%M%S).tar.gz"
mkdir -p /var/backups/clinum
tar -czf $BACKUP_FILE -C /opt/clinum-server .
echo "Backup creado: $BACKUP_FILE"

echo "[2/4] Deteniendo servicio..."
systemctl stop clinum-server

echo "[3/4] Actualizando desde GitHub..."
cd /tmp
rm -rf clinum-server-local
git clone https://github.com/JulioDyD/clinum-server-local.git clinum-server-local
cd clinum-server-local/local-server
npm ci --production
npm run build

if [ -f /opt/clinum-server/.env ]; then
    echo "Manteniendo configuración existente..."
    cp /opt/clinum-server/.env .env
else
    cat > .env << EOF
LOCAL_HTTP_PORT=8081
SERIAL_PORT=/dev/ttyUSB0
SERIAL_BAUD=115200
FIREBASE_PROJECT_ID=clinum-production
LOCAL_DB_FILE=/var/lib/clinum/clinum.db
LOCAL_ONLY=false
CORS_ORIGIN=*
NODE_ENV=production
EOF
fi

echo "[4/4] Instalando actualización..."
cp -r * /opt/clinum-server/
cd /opt/clinum-server
chown -R clinum:clinum /opt/clinum-server

systemctl start clinum-server

echo ""
echo "========================================"
echo "ACTUALIZACION COMPLETADA!"
echo "========================================"
systemctl status clinum-server --no-pager
echo "========================================"
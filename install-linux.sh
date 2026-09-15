#!/bin/bash
set -e

echo "========================================"
echo "CLINUM SERVER - INSTALADOR AUTOMATICO"
echo "========================================"

if [ "$EUID" -ne 0 ]; then 
    echo "Por favor ejecuta como root o con sudo"
    exit 1
fi

echo "[1/7] Instalando Node.js 20..."
# Solucionar problema temporal con repositorio de Chrome
if [ -f /etc/apt/sources.list.d/google-chrome.list ]; then
  sudo mv /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.list.bak 2>/dev/null || true
fi

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get update || apt-get update --allow-unauthenticated
apt-get install -y nodejs git curl ufw build-essential python3

echo "[2/7] Configurando usuario y directorios..."
useradd -r -s /bin/false clinum || true
usermod -a -G dialout clinum || true
mkdir -p /opt/clinum-server
mkdir -p /var/lib/clinum
mkdir -p /var/log/clinum
mkdir -p /var/backups/clinum
chown -R clinum:clinum /opt/clinum-server
chown -R clinum:clinum /var/lib/clinum
chown -R clinum:clinum /var/log/clinum
chown -R clinum:clinum /var/backups/clinum

echo "[3/7] Descargando código desde GitHub..."
cd /tmp
rm -rf clinum-server-local
git clone https://github.com/JulioDyD/clinum-server-local.git clinum-server-local

echo "[4/7] Preparando servidor local..."
cd clinum-server-local/clinum-web-local/local-server
npm ci
npm run build

echo "[5/7] Configurando variables de entorno..."
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

# Validar que el archivo .env se creó correctamente
if [ ! -f .env ]; then
  echo "ERROR: No se pudo crear el archivo .env"
  exit 1
fi
echo "Archivo .env creado correctamente"
cat .env

echo "[6/7] Instalando en ubicación final..."
cp -r * /opt/clinum-server/
cd /opt/clinum-server
chown -R clinum:clinum /opt/clinum-server

chmod 660 /dev/ttyACM0 || echo "Ajusta SERIAL_PORT en .env si usas otro puerto"

echo "[7/7] Configurando servicio systemd..."
cat > /etc/systemd/system/clinum-server.service << 'EOF'
[Unit]
Description=Clinum Local Server
After=network.target

[Service]
Type=simple
User=clinum
Group=clinum
WorkingDirectory=/opt/clinum-server
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# Security settings más relajadas para evitar errores NAMESPACE
NoNewPrivileges=false
PrivateTmp=false
ProtectSystem=false
ReadWritePaths=/var/lib/clinum /opt/clinum-server/data

[Install]
WantedBy=multi-user.target
EOF

ufw allow 8081/tcp || true

systemctl daemon-reload
systemctl enable clinum-server
systemctl start clinum-server

echo ""
echo "========================================"
echo "INSTALACION COMPLETADA EXITOSAMENTE!"
echo "========================================"
echo "Servidor corriendo en: http://$(hostname -I | awk '{print $1}'):8081"
echo ""
echo "Comandos utiles:"
echo "  Ver estado: systemctl status clinum-server"
echo "  Ver logs: journalctl -u clinum-server -f"
echo "  Reiniciar: systemctl restart clinum-server"
echo "========================================"
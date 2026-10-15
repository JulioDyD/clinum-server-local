# Clinum Local Server - Instalacion y actualización de sedes

Flujo profesional: el codigo se sube a git (push + tag) y cada sede se
instala/actualiza desde ahi. Nunca se copia a mano desde Windows.

## Publicar una version (desarrollador, en Windows)

```bash
# 1. Subir cambios
git add -A
git commit -m "feat: descripcion del cambio"
git push origin main

# 2. Versionar y etiquetar (dispara la version visible en /health y /api/version)
cd clinum-web-local/local-server
npm run version:patch   # o version:minor / version:major
git add package.json package-lock.json
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

## Sede nueva (equipo Linux Mint, como root)

```bash
git clone --depth 1 https://github.com/JulioDyD/clinum-server-local.git
sudo bash clinum-server-local/clinum-web-local/local-server/packaging/site-install.sh \
  --ref vX.Y.Z --serial auto --http-port 8081 --yes
```

## Actualizar sede existente (preserva .env y base de datos)

```bash
sudo bash /tmp/clinum-site-src/clinum-web-local/local-server/packaging/site-update.sh --ref vX.Y.Z --yes
# o, si ya tienes el repo clonado en la sede:
sudo bash clinum-web-local/local-server/packaging/site-update.sh --ref vX.Y.Z --yes
# solo consultar sin instalar:
sudo bash clinum-web-local/local-server/packaging/site-update.sh --ref vX.Y.Z --check-only
```

Lo que preserva el update: `/etc/clinum-web-local/.env` y
`/var/lib/clinum-web-local/clinum.db`. Antes de instalar hace backup ligero en
`/var/backups/clinum-web-local/backup-<fecha>/` (solo config+DB, sin node_modules).

## Comandos utiles

```bash
systemctl status clinum-web-local
journalctl -u clinum-web-local -f
systemctl restart clinum-web-local
curl http://localhost:8081/health
```

## Configuracion

Archivo: `/etc/clinum-web-local/.env`

```bash
sudo nano /etc/clinum-web-local/.env
sudo systemctl restart clinum-web-local
```

Puerto serial: se autodetecta (`/dev/ttyUSB0`, `/dev/ttyACM0`, ...). Para fijarlo:

```bash
SERIAL_PORT=/dev/ttyUSB1
```

## Compatibilidad

`install-linux.sh`, `update-linux.sh` y `packaging/setup.sh` siguen existiendo
como wrappers deprecados que delegan en `site-install.sh` / `site-update.sh`.

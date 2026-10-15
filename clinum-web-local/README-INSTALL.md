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
  --ref vX.Y.Z --serial /dev/ttyACM0 --http-port 8081 --yes
```

El panel queda en `https://<ip-sede>:8081` (HTTPS con CA interna, ver abajo).
El puerto `http://<ip-sede>:8080` solo redirige a HTTPS.

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
curl -k https://localhost:8081/health
```

## HTTPS y certificado (CA interna de la sede)

Cada sede genera su propia CA en la instalacion (`/etc/clinum-web-local/tls/`).
El panel se sirve por HTTPS en el puerto 8081. Para que los navegadores no
muestren advertencia, instala `ca.crt` **una vez** en cada PC cliente:

1. Copia el archivo desde la sede (USB o red):
   `/etc/clinum-web-local/tls/ca.crt`
2. Windows: doble clic en `ca.crt` -> Instalar certificado -> "Entidades de
   certificacion raiz de confianza".
3. Linux Mint: copialo a `/usr/local/share/ca-certificates/clinum-sede.crt`
   y ejecuta `sudo update-ca-certificates`.
4. Abre `https://<ip-sede>:8081` (usa el nombre o IP incluido al instalar).

Notas:

- Fija IP estatica (o reserva DHCP) al servidor de la sede. Si su IP cambia,
  reemite el certificado sin tocar los clientes:
  `sudo bash packaging/site-tls.sh renew-server && sudo systemctl restart clinum-web-local`.
- Ver estado: `sudo bash packaging/site-tls.sh status`.
- El update preserva `/etc/clinum-web-local/tls/` y lo incluye en el backup.

## Configuracion

Archivo: `/etc/clinum-web-local/.env`

```bash
sudo nano /etc/clinum-web-local/.env
sudo systemctl restart clinum-web-local
```

Puerto serial: por defecto `/dev/ttyACM0`. Para cambiarlo:

```bash
SERIAL_PORT=/dev/ttyUSB1
```

## Compatibilidad

`install-linux.sh`, `update-linux.sh` y `packaging/setup.sh` siguen existiendo
como wrappers deprecados que delegan en `site-install.sh` / `site-update.sh`.

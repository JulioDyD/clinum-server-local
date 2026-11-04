# Clinum Local Server - Instalacion y actualización de sedes

Flujo profesional: el codigo se sube a git (push + tag) y cada sede se
instala/actualiza desde ahi. Nunca se copia a mano desde Windows.

El instalador y el actualizador descargan **solo** `clinum-web-local/local-server`
(clon parcial + sparse checkout). Las carpetas de firmware de los dispositivos
siguen versionadas en git, pero **no se descargan ni se despliegan en las sedes**;
el `.deb` tampoco las incluye.

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
git clone --depth 1 --filter=blob:none --sparse https://github.com/JulioDyD/clinum-server-local.git
cd clinum-server-local
git sparse-checkout set --cone clinum-web-local/local-server
sudo bash clinum-web-local/local-server/packaging/site-install.sh \
  --ref vX.Y.Z --serial /dev/ttyACM0 --http-port 8081 --yes
```

El panel queda en `http://<ip-sede>:8081` (HTTP local). Con `--https` queda en
`https://<ip-sede>:8081` con CA interna (ver abajo); el puerto
`http://<ip-sede>:8080` solo redirige a HTTPS.

## Actualizar sede existente (preserva .env y base de datos)

```bash
# Opcion recomendada: clon parcial (solo la app, sin firmware)
cd /tmp && rm -rf clinum-update-src
git clone --depth 1 --branch vX.Y.Z --filter=blob:none --sparse \
  https://github.com/JulioDyD/clinum-server-local.git clinum-update-src
cd clinum-update-src
git sparse-checkout set --cone clinum-web-local/local-server
sudo bash clinum-web-local/local-server/packaging/site-update.sh --ref vX.Y.Z --yes

# Si ya tienes un clon de la app en la sede:
sudo bash clinum-web-local/local-server/packaging/site-update.sh --ref vX.Y.Z --yes
# Solo consultar sin instalar:
sudo bash clinum-web-local/local-server/packaging/site-update.sh --ref vX.Y.Z --check-only
```

Lo que preserva el update: `/etc/clinum-web-local/.env`,
`/var/lib/clinum-web-local/clinum.db` y la credencial Firebase. Antes de instalar
hace backup ligero en `/var/backups/clinum-web-local/backup-<fecha>/`
(config + DB + TLS + credencial, sin node_modules).

## Comandos utiles

```bash
systemctl status clinum-web-local
journalctl -u clinum-web-local -f
systemctl restart clinum-web-local
curl -k https://localhost:8081/health
```

## HTTPS opcional (CA interna de la sede)

Por defecto todo trabaja por HTTP local. Si quieres HTTPS, instala con
`--https` (sede nueva) o activa en una sede existente:

```bash
sudo sed -i -E 's/^TLS_ENABLED=.*/TLS_ENABLED=1/' /etc/clinum-web-local/.env
sudo bash packaging/site-tls.sh issue
sudo systemctl restart clinum-web-local
```

Para volver a HTTP:

```bash
sudo sed -i -E 's/^TLS_ENABLED=.*/TLS_ENABLED=0/' /etc/clinum-web-local/.env
sudo systemctl restart clinum-web-local
```

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

## Credencial Firebase (integracion con clinum-2.web.app)

La credencial **no** se guarda en git ni en el `.deb`. Se entrega una vez por sede.

### Sede nueva con sync
```bash
sudo bash clinum-web-local/local-server/packaging/site-install.sh \
  --ref vX.Y.Z \
  --location-id iXStZUMPAzQHyQ8RzsBf \
  --project clinum-2 \
  --service-account-file /root/clinum-sa.json \
  --serial /dev/ttyACM0 --http-port 8081 --yes
```
- `/root/clinum-sa.json` es la clave de servicio del proyecto `clinum-2`
  (Firebase Console -> Configuracion del proyecto -> Cuentas de servicio).
- Se instala en `/etc/clinum-web-local/service-account.json` con `0600 root:root`.
- systemd la inyecta en `/run/credentials/clinum-web-local.service/firebase`.
- El `.env` queda con `LOCAL_ONLY=0`, `LOCATION_ID` y `FIREBASE_PROJECT_ID`.
- Al final se verifica `/integration-settings`.

### Actualizar una sede
```bash
# Conservando la credencial existente
sudo bash clinum-web-local/local-server/packaging/site-update.sh --ref vX.Y.Z --yes

# Rotando la credencial
sudo bash clinum-web-local/local-server/packaging/site-update.sh --ref vX.Y.Z \
  --service-account-file /root/clinum-sa-nueva.json --yes
```
- Sin `--service-account-file`: se conserva la credencial actual.
- Con archivo nuevo: se valida, se reemplaza atomicamente y se guarda `.bak`.
- Si la verificacion falla, se restaura la credencial y el `.env` anteriores.

### Entrega por stdin (sin archivo temporal visible)
```bash
sudo bash clinum-web-local/local-server/packaging/site-install.sh --ref vX.Y.Z \
  --location-id iXStZUMPAzQHyQ8RzsBf --project clinum-2 \
  --service-account-stdin --yes < /root/clinum-sa.json
```

### Proteccion
- JSON `0600 root:root`.
- `systemd LoadCredential` lo entrega al servicio desde un tmpfs privado.
- El grupo `clinum`/`soporte` no puede leer el JSON.
- El panel solo muestra si existe; no permite subirlo.
- Nunca subir el JSON a git, correo o USB sin cifrar.

### Rotacion manual
1. Generar nueva clave en Firebase Console.
2. `site-update.sh --service-account-file /root/nueva.json --yes`.
3. Verificar `/integration-settings` y `journalctl`.
4. Revocar la clave anterior.

### Backup
- El update guarda `.env`, DB, TLS y `service-account.json` en
  `/var/backups/clinum-web-local/backup-<fecha>/` con `0600`.
- Mantener una copia segura fuera del servidor.

### Verificacion
```bash
curl -s http://localhost:8081/integration-settings
journalctl -u clinum-web-local -f
```
Debe mostrar `hasServiceAccount: true`, `localOnly: false` y `lastError: null`.

### Si no hay credencial
La sede queda en `LOCAL_ONLY=1` y funciona sin sync. Se puede provisionar
despues con `site-update.sh --service-account-file ...`.

## Compatibilidad

`install-linux.sh`, `update-linux.sh` y `packaging/setup.sh` siguen existiendo
como wrappers deprecados que delegan en `site-install.sh` / `site-update.sh`.

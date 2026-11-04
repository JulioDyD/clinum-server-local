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

La credencial se guarda **cifrada** en git. La llave privada age es compartida y
se entrega una vez por sede.

### Generar la credencial cifrada (Linux/WSL)
```bash
cd clinum-web-local/local-server
bash packaging/encrypt-secret.sh \
  --service-account /root/clinum-sa.json \
  --init
```
- Genera `secrets/age.key` (`0600`) y la clave publica.
- Cifra en `secrets/firebase-service-account.json.age`.
- Commitea **ambos** archivos.
- El repositorio debe ser privado: la llave age queda en el repo.

### Sede nueva con credencial cifrada
```bash
sudo bash clinum-web-local/local-server/packaging/site-install.sh \
  --ref vX.Y.Z \
  --project clinum-2 \
  --require-credential \
  --serial /dev/ttyACM0 --http-port 8081 --yes
```
- Usa automaticamente `secrets/age.key` del repo.
- Instala la llave age en `/etc/clinum-web-local/age.key` (`0600 root`).
- Descifra `secrets/firebase-service-account.json.age` del repo.
- Instala la credencial en `/etc/clinum-web-local/service-account.json` con
  `0600 root:root`.
- systemd la inyecta en `/run/credentials/clinum-web-local.service/firebase`.
- El `.env` queda con `LOCAL_ONLY=1`, `LOCATION_ID` vacio y `FIREBASE_PROJECT_ID`.
- El sync queda desactivado hasta asignar el ID en **Integracion**.
- Al final se verifica la credencial.

### Asignar la sede desde el panel
1. En el web, crea la sede y copia su ID (`locations/{id}`).
2. En el panel local -> **Configuracion -> Integracion**:
   - Pega el ID en **ID de la sede**.
   - Pulsa **Guardar** (guarda el ID, sin activar el sync).
   - Activa **Sincronizar con el servidor web** (se aplica al instante).
3. El servidor empieza a escribir con ese `locationId`.

Las actualizaciones conservan el ID y el estado de sync. Si la sede no tiene ID,
sigue en local-only.

### Actualizar una sede
```bash
sudo bash clinum-web-local/local-server/packaging/site-update.sh --ref vX.Y.Z --yes
```
- Usa `secrets/age.key` y el `.age` del repo automaticamente.
- Si el `.age` cambia, descifra y actualiza la credencial.
- Sin `.age`/llave, conserva la credencial existente.
- Conserva `LOCATION_ID` y el estado de sync.

### Actualizar sin clonar (desde v1.4.1)
```bash
sudo clinum-update --ref vX.Y.Z --yes
```
o
```bash
sudo bash /opt/clinum-web-local/packaging/site-update.sh --ref vX.Y.Z --yes
```
- El updater queda instalado en `/opt/clinum-web-local/packaging/`.
- No uses `--local` desde `/opt`; el flujo oficial es con `--ref`.

### Entrega manual (respaldo)
```bash
sudo bash clinum-web-local/local-server/packaging/site-install.sh --ref vX.Y.Z \
  --project clinum-2 --service-account-file /root/clinum-sa.json \
  --require-credential --yes
```
- Alternativa si no se usa el `.age`.
- Tambien existe `--service-account-stdin` con `--yes < /root/clinum-sa.json`.

### Proteccion
- `secrets/firebase-service-account.json.age` y `secrets/age.key` viven en el repo privado.
- El instalador/updater usan `secrets/age.key` automaticamente.
- En la sede, la llave queda en `/etc/clinum-web-local/age.key` con `0600 root`.
- Credencial descifrada en `/etc/clinum-web-local/service-account.json` con `0600 root:root`.
- Si la llave o el repo se filtran, rota la credencial y la llave.
- `systemd LoadCredential` la entrega al servicio desde un tmpfs privado.
- El grupo `clinum`/`soporte` no puede leer el JSON.
- El panel solo muestra si existe; no permite subirlo.
- Nunca subir el JSON plano a git, correo o USB sin cifrar.

### Rotacion manual
1. Generar nueva clave en Firebase Console.
2. Re-cifrar con la misma clave publica:
   ```bash
   bash packaging/encrypt-secret.sh \
     --service-account /root/clinum-sa-nueva.json \
     --public-key <CLAVE_PUBLICA>
   ```
3. Commit del nuevo `.age`.
4. `clinum-update --ref vX.Y.Z --yes`.
5. Verificar y revocar la clave anterior.

### Backup
- El update guarda `.env`, DB, TLS, `service-account.json` y `age.key` en
  `/var/backups/clinum-web-local/backup-<fecha>/` con `0600`.
- Mantener una copia segura de `age.key` fuera del servidor.

### Verificacion
```bash
curl -s http://localhost:8081/integration-settings
journalctl -u clinum-web-local -f
```
Debe mostrar `hasServiceAccount: true` y `lastError: null`. `localOnly` sera
`false` solo cuando la sede ya este asignada y el sync activado.

### Si no hay credencial
La sede queda en `LOCAL_ONLY=1` y funciona sin sync. Se puede provisionar
despues con `--age-key-file` + el `.age` del repo, o manualmente con
`--service-account-file`.

## Compatibilidad

`install-linux.sh`, `update-linux.sh` y `packaging/setup.sh` siguen existiendo
como wrappers deprecados que delegan en `site-install.sh` / `site-update.sh`.

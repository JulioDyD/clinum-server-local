#!/usr/bin/env bash
# site-install.sh - Creates a NEW clinum-web-local site from git.
# Professional flow: code is pushed to git (push + tag vX.Y.Z) and the site
# is installed from there. Never copy by hand from Windows.
# Usage:
#   sudo bash site-install.sh [--repo URL] [--ref main|v1.2.3]
#       [--serial /dev/ttyACM0] [--http-port 8081] [--https] [--workdir /tmp] [--yes]
#       [--project clinum-2]
#       [--service-account-file /root/clinum-sa.json | --service-account-stdin]
#       [--age-key-file /root/clinum-age.key] [--encrypted-secret RUTA]
#       [--require-credential]
#   Default serial is /dev/ttyACM0. Plain HTTP by default; --https enables
#   HTTPS with the site-internal CA (clients must install ca.crt once).
#   sudo bash site-install.sh --local [--serial /dev/ttyACM0] [--http-port 8081] [--yes]
#     --local: no clone; uses current checkout (dev only).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

REPO="$DEFAULT_REPO"; REF="$DEFAULT_REF"; SERIAL_PREFER="$DEFAULT_SERIAL_PORT"
HTTP_PORT="$DEFAULT_HTTP_PORT"; WORKDIR="/tmp"; ASSUME_YES=0; LOCAL_MODE=0; USE_HTTPS=0
PROJECT_ID="clinum-2"; SERVICE_ACCOUNT_FILE=""; SERVICE_ACCOUNT_STDIN=0; REQUIRE_CREDENTIAL=0
AGE_KEY_FILE=""; ENCRYPTED_SECRET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --serial) SERIAL_PREFER="${2:?}"; shift 2 ;;
    --http-port) HTTP_PORT="${2:?}"; shift 2 ;;
    --https) USE_HTTPS=1; shift ;;
    --workdir) WORKDIR="${2:?}"; shift 2 ;;
    --project) PROJECT_ID="${2:?}"; shift 2 ;;
    --service-account-file) SERVICE_ACCOUNT_FILE="${2:?}"; shift 2 ;;
    --service-account-stdin) SERVICE_ACCOUNT_STDIN=1; shift ;;
    --age-key-file) AGE_KEY_FILE="${2:?}"; shift 2 ;;
    --encrypted-secret) ENCRYPTED_SECRET="${2:?}"; shift 2 ;;
    --require-credential) REQUIRE_CREDENTIAL=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --local) LOCAL_MODE=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

SA_TMP=""
cleanup() { if [ -n "$SA_TMP" ]; then rm -f "$SA_TMP"; fi; }
trap cleanup EXIT

require_root
check_systemd

if [ "$SERVICE_ACCOUNT_STDIN" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ]; then
  die "--service-account-stdin requiere --yes"
fi

if [ "$SERVICE_ACCOUNT_STDIN" -eq 1 ]; then
  SA_TMP="$(read_service_account_stdin)"
  SERVICE_ACCOUNT_FILE="$SA_TMP"
fi

if [ -n "$SERVICE_ACCOUNT_FILE" ] || [ "$SERVICE_ACCOUNT_STDIN" -eq 1 ]; then
  ensure_build_deps
fi

if [ -n "$SERVICE_ACCOUNT_FILE" ]; then
  [ -f "$SERVICE_ACCOUNT_FILE" ] || die "No existe la credencial: $SERVICE_ACCOUNT_FILE"
  validate_service_account "$SERVICE_ACCOUNT_FILE" "$PROJECT_ID"
fi

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  die "Active install already exists ($SERVICE_NAME). To update use site-update.sh --ref $REF"
fi

SERIAL_PORT="$(detect_serial "$SERIAL_PREFER")"
log "Repo   : $REPO @ $REF"
log "Serial : $SERIAL_PORT"
log "HTTP   : $HTTP_PORT"

if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Install NEW site from $REF on this machine? [y/N]: " ans
  case "$ans" in [yY]*) true ;; *) die "Cancelled." ;; esac
fi

if [ "$LOCAL_MODE" -eq 1 ]; then
  APP_DIR="$(find_app_dir "$SCRIPT_DIR")"
else
  ensure_build_deps
  command -v git >/dev/null 2>&1 || apt-get install -y git
  SRC="$WORKDIR/clinum-site-src"
  log "Fetching app subtree $REPO (@ $REF) ..."
  fetch_app_source "$REPO" "$REF" "$SRC"
  SRC="$FETCHED_SRC"
  if [ -d "$SRC/$APP_REL_PATH" ]; then APP_DIR="$SRC/$APP_REL_PATH";
  elif [ -f "$SRC/package.json" ]; then APP_DIR="$SRC";
  else die "Checkout has no local-server (check repo/ref)."; fi
fi

log "App dir: $APP_DIR"
ensure_build_deps

# Single build happens inside build-deb.sh (npm ci + tsc + prune).
# (Older revisions built twice here and inside build-deb.sh: ~8 min wasted.)
log "Building .deb"
bash "$APP_DIR/packaging/build-deb.sh"

DEB_ARCH="$(detect_deb_arch)"
VERSION="$(pkg_version "$APP_DIR/package.json" 2>/dev/null || echo 0.1.0)"
DEB="$(ls -1t "$APP_DIR"/dist-deb/${PKG_NAME}_${VERSION}_${DEB_ARCH}.deb 2>/dev/null | head -n1 || true)"
[ -n "$DEB" ] || die "No .deb found in $APP_DIR/dist-deb"
log ".deb: $DEB"
dpkg -i "$DEB" || { apt-get -f install -y && dpkg -i "$DEB"; }

[ -f "$ENVFILE" ] || die "postinst did not create $ENVFILE"
sed -i -E "s|^SERIAL_PORT=.*|SERIAL_PORT=$SERIAL_PORT|" "$ENVFILE"
sed -i -E "s|^LOCAL_HTTP_PORT=.*|LOCAL_HTTP_PORT=$HTTP_PORT|" "$ENVFILE"
ensure_tls_env
if [ "$USE_HTTPS" -eq 1 ]; then
  # HTTPS with site-internal CA. Idempotent: keeps CA, issues server cert.
  sed -i -E "s|^TLS_ENABLED=.*|TLS_ENABLED=1|" "$ENVFILE"
  bash "$APP_DIR/packaging/site-tls.sh" issue
else
  sed -i -E "s|^TLS_ENABLED=.*|TLS_ENABLED=0|" "$ENVFILE"
fi
chown root:clinum "$ENVFILE"; chmod 0660 "$ENVFILE"
# Usuario genérico de soporte (si existe en esta máquina): mismo grupo que el
# servicio, para editar .env / colocar la credencial sin sudo por archivo.
if getent passwd soporte >/dev/null; then
  adduser soporte clinum || true
fi

# Integracion con el servidor web (Firebase clinum-2)
set_env_key "FIREBASE_PROJECT_ID" "$PROJECT_ID" "$ENVFILE"
# La sede se asigna desde el panel de Integracion; hasta entonces queda local-only.
set_env_key "LOCAL_ONLY" "1" "$ENVFILE"

# Credencial cifrada en git + llave age compartida.
# Si la llave esta en el repo (secrets/age.key), se usa automaticamente.
if [ -z "$AGE_KEY_FILE" ] && [ -f "$APP_DIR/secrets/age.key" ]; then
  AGE_KEY_FILE="$APP_DIR/secrets/age.key"
fi
if [ -n "$AGE_KEY_FILE" ]; then install_age_key "$AGE_KEY_FILE"; fi
if [ -z "$SERVICE_ACCOUNT_FILE" ] && [ -z "$ENCRYPTED_SECRET" ]; then
  ENCRYPTED_SECRET="$APP_DIR/secrets/firebase-service-account.json.age"
fi
if [ -z "$SERVICE_ACCOUNT_FILE" ] && [ -s "$ENCRYPTED_SECRET" ] && [ -f "$AGE_KEY_PATH" ]; then
  SA_TMP="$(decrypt_service_account "$ENCRYPTED_SECRET" "$AGE_KEY_PATH")"
  SERVICE_ACCOUNT_FILE="$SA_TMP"
fi

if [ -n "$SERVICE_ACCOUNT_FILE" ]; then
  validate_service_account "$SERVICE_ACCOUNT_FILE" "$PROJECT_ID"
  install_service_account_atomic "$SERVICE_ACCOUNT_FILE"
  enable_systemd_credential
  log "Credencial Firebase instalada (0600 root:root + systemd). Asigna el ID de la sede en el panel."
elif [ "$REQUIRE_CREDENTIAL" -eq 1 ]; then
  die "No hay credencial: falta el secreto cifrado o la llave age"
else
  disable_systemd_credential || true
  warn "Sin credencial: la sede queda en modo local-only."
fi
chown root:clinum "$ENVFILE"; chmod 0660 "$ENVFILE"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager || true
health_check "$HTTP_PORT" || true
if [ -n "$SERVICE_ACCOUNT_FILE" ]; then
  if verify_credential "$HTTP_PORT"; then
    log "Credencial verificada. Asigna el ID de la sede en el panel para activar el sync."
  else
    warn "La sede quedo instalada, pero la verificacion de la credencial fallo. Revisa: journalctl -u $SERVICE_NAME -f"
  fi
else
  verify_integration "$HTTP_PORT" 0 || true
fi
print_site_info "$HTTP_PORT"
log "New site ready. Future updates: site-update.sh --ref <tag>"

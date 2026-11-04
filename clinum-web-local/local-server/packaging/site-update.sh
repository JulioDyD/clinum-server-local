#!/usr/bin/env bash
# site-update.sh - Updates an EXISTING site from git, preserving data.
# Preserves: /etc/clinum-web-local/.env and /var/lib/clinum-web-local/clinum.db
# Light backup first in /var/backups/clinum-web-local/backup-<date>/
# (config+DB only, no node_modules).
# Usage:
#   sudo bash site-update.sh [--repo URL] [--ref main|v1.2.3] [--check-only] [--force] [--yes]
#       [--project clinum-2]
#       [--service-account-file /root/clinum-sa.json | --service-account-stdin]
#   sudo bash site-update.sh --local [--yes]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

REPO="$DEFAULT_REPO"; REF="$DEFAULT_REF"; WORKDIR="/tmp"
ASSUME_YES=0; LOCAL_MODE=0; CHECK_ONLY=0; FORCE=0
PROJECT_ID="clinum-2"; SERVICE_ACCOUNT_FILE=""; SERVICE_ACCOUNT_STDIN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --workdir) WORKDIR="${2:?}"; shift 2 ;;
    --project) PROJECT_ID="${2:?}"; shift 2 ;;
    --service-account-file) SERVICE_ACCOUNT_FILE="${2:?}"; shift 2 ;;
    --service-account-stdin) SERVICE_ACCOUNT_STDIN=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --force) FORCE=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --local) LOCAL_MODE=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

SA_TMP=""
cleanup() { if [ -n "$SA_TMP" ]; then rm -f "$SA_TMP"; fi; }
trap cleanup EXIT

require_root
check_systemd

CURRENT="$(installed_version)"
log "Installed: v$CURRENT"
log "Target   : $REPO @ $REF"

if [ "$LOCAL_MODE" -eq 1 ]; then
  APP_DIR="$(find_app_dir "$SCRIPT_DIR")"
  TARGET="$(pkg_version "$APP_DIR/package.json" 2>/dev/null || echo unknown)"
else
  ensure_build_deps
  SRC="$WORKDIR/clinum-site-src"
  log "Fetching app subtree $REPO (@ $REF) ..."
  fetch_app_source "$REPO" "$REF" "$SRC"
  SRC="$FETCHED_SRC"
  if [ -d "$SRC/$APP_REL_PATH" ]; then APP_DIR="$SRC/$APP_REL_PATH";
  elif [ -f "$SRC/package.json" ]; then APP_DIR="$SRC";
  else die "Checkout has no local-server."; fi
  TARGET="$(pkg_version "$APP_DIR/package.json" 2>/dev/null || echo unknown)"
fi
log "Target version: v$TARGET"

if [ "$CHECK_ONLY" -eq 1 ]; then
  if [ "$CURRENT" = "$TARGET" ]; then echo "UP-TO-DATE v$CURRENT"; else echo "UPDATE-AVAILABLE current=v$CURRENT target=v$TARGET"; fi
  exit 0
fi

if [ "$CURRENT" = "$TARGET" ] && [ "$FORCE" -ne 1 ]; then
  log "Already on v$TARGET. Nothing to do (use --force to reinstall)."
  exit 0
fi

if [ "$SERVICE_ACCOUNT_STDIN" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ]; then
  die "--service-account-stdin requiere --yes"
fi

if [ "$SERVICE_ACCOUNT_STDIN" -eq 1 ]; then
  SA_TMP="$(read_service_account_stdin)"
  SERVICE_ACCOUNT_FILE="$SA_TMP"
fi

if [ "$LOCAL_MODE" -eq 1 ] && { [ -n "$SERVICE_ACCOUNT_FILE" ] || [ "$SERVICE_ACCOUNT_STDIN" -eq 1 ]; }; then
  ensure_build_deps
fi

if [ -n "$SERVICE_ACCOUNT_FILE" ]; then
  [ -f "$SERVICE_ACCOUNT_FILE" ] || die "No existe la credencial: $SERVICE_ACCOUNT_FILE"
  validate_service_account "$SERVICE_ACCOUNT_FILE" "$PROJECT_ID"
fi

HTTP_PORT="$DEFAULT_HTTP_PORT"
if [ -f "$ENVFILE" ]; then
  HTTP_PORT="$(grep -E '^LOCAL_HTTP_PORT=' "$ENVFILE" | cut -d= -f2 | tail -n1)"
  HTTP_PORT="${HTTP_PORT:-$DEFAULT_HTTP_PORT}"
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Update v$CURRENT -> v$TARGET preserving .env and DB? [y/N]: " ans
  case "$ans" in [yY]*) true ;; *) die "Cancelled." ;; esac
fi

BACKUP="$(backup_site)"
log "Light backup at: $BACKUP"

log "Stopping service"
systemctl stop "$SERVICE_NAME" || true

log "Building target (single build inside build-deb.sh)"
ensure_build_deps
bash "$APP_DIR/packaging/build-deb.sh"
[ -f "$APP_DIR/dist/index.js" ] || die "Build did not produce dist/index.js (backup kept at $BACKUP)"
DEB_ARCH="$(detect_deb_arch)"
DEB="$(ls -1t "$APP_DIR"/dist-deb/${PKG_NAME}_${TARGET}_${DEB_ARCH}.deb 2>/dev/null | head -n1 || \
       ls -1t "$APP_DIR"/dist-deb/*.deb 2>/dev/null | head -n1 || true)"
[ -n "$DEB" ] || die "No .deb found (backup at $BACKUP)"
dpkg -i "$DEB" || { apt-get -f install -y && dpkg -i "$DEB"; }

# dpkg respects conffiles: /etc/clinum-web-local/.env is NOT overwritten.
log ".env preserved: $ENVFILE"
ensure_tls_env
# 0660: grupo clinum (servicio + soporte) con lectura y escritura, para que el
# panel (PATCH /integration-settings) y la edicion manual funcionen sin sudo
# adicional por archivo.
chown root:clinum "$ENVFILE"; chmod 0660 "$ENVFILE"
if getent passwd soporte >/dev/null; then
  adduser soporte clinum >/dev/null 2>&1 || true
fi
if [ -n "$SERVICE_ACCOUNT_FILE" ]; then
  install_service_account_atomic "$SERVICE_ACCOUNT_FILE"
  enable_systemd_credential
  EXISTING_LOCATION="$(grep -E '^LOCATION_ID=' "$ENVFILE" 2>/dev/null | cut -d= -f2 | tail -n1 || true)"
  if [ -z "$EXISTING_LOCATION" ]; then
    set_env_key "LOCAL_ONLY" "1" "$ENVFILE"
    log "Credencial actualizada. Sin sede asignada: asigna el ID en el panel para activar el sync."
  else
    log "Credencial actualizada. Sede conservada: $EXISTING_LOCATION"
  fi
  if [ -n "$PROJECT_ID" ]; then set_env_key "FIREBASE_PROJECT_ID" "$PROJECT_ID" "$ENVFILE"; fi
else
  if [ -f "$SERVICE_ACCOUNT_PATH" ]; then
    chown root:root "$SERVICE_ACCOUNT_PATH" 2>/dev/null || true
    chmod 0600 "$SERVICE_ACCOUNT_PATH" 2>/dev/null || true
    enable_systemd_credential
    log "Credencial existente preservada"
  else
    disable_systemd_credential || true
    set_env_key "LOCAL_ONLY" "1" "$ENVFILE"
    warn "Sin credencial: la sede queda en modo local-only."
  fi
fi
chown root:clinum "$ENVFILE"; chmod 0660 "$ENVFILE"

# HTTPS with site-internal CA (method B). Keeps existing CA (no client reinstall),
# issues the server cert on first TLS upgrade.
bash "$APP_DIR/packaging/site-tls.sh" issue

systemctl daemon-reload
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager || true
health_check "$HTTP_PORT" || {
  warn "Installed but /health does not answer."
  warn "Manual rollback: restore $BACKUP/.env -> $ENVFILE, $BACKUP/service-account.json -> $SERVICE_ACCOUNT_PATH and $BACKUP/var-lib -> $VARDIR, then systemctl restart $SERVICE_NAME"
  exit 1
}

if [ -n "$SERVICE_ACCOUNT_FILE" ] || [ -f "$SERVICE_ACCOUNT_PATH" ]; then
  if verify_credential "$HTTP_PORT"; then
    log "Credencial verificada."
  else
    if [ -n "$SERVICE_ACCOUNT_FILE" ]; then
      warn "Verificacion de credencial fallida; restaurando credencial y configuracion anteriores..."
      [ -f "$BACKUP/.env" ] && install -o root -g clinum -m 0660 "$BACKUP/.env" "$ENVFILE"
      if [ -f "$SERVICE_ACCOUNT_PATH.bak" ]; then
        mv -f "$SERVICE_ACCOUNT_PATH.bak" "$SERVICE_ACCOUNT_PATH"
        chown root:root "$SERVICE_ACCOUNT_PATH" 2>/dev/null || true
        chmod 0600 "$SERVICE_ACCOUNT_PATH" 2>/dev/null || true
        enable_systemd_credential || true
      elif [ -f "$BACKUP/service-account.json" ]; then
        install -o root -g root -m 0600 "$BACKUP/service-account.json" "$SERVICE_ACCOUNT_PATH"
        enable_systemd_credential || true
      else
        rm -f "$SERVICE_ACCOUNT_PATH"
        disable_systemd_credential || true
        set_env_key "LOCAL_ONLY" "1" "$ENVFILE"
      fi
      systemctl restart "$SERVICE_NAME" || true
      warn "Revisa: journalctl -u $SERVICE_NAME -f"
      exit 1
    else
      warn "La credencial existente no se pudo verificar. La actualizacion quedo aplicada; revisa el panel."
    fi
  fi
else
  verify_integration "$HTTP_PORT" 0 || true
fi
print_site_info "$HTTP_PORT"
log "Update v$CURRENT -> v$TARGET OK (backup: $BACKUP)"

#!/usr/bin/env bash
# site-update.sh - Updates an EXISTING site from git, preserving data.
# Preserves: /etc/clinum-web-local/.env and /var/lib/clinum-web-local/clinum.db
# Light backup first in /var/backups/clinum-web-local/backup-<date>/
# (config+DB only, no node_modules).
# Usage:
#   sudo bash site-update.sh [--repo URL] [--ref main|v1.2.3] [--check-only] [--force] [--yes]
#   sudo bash site-update.sh --local [--yes]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

REPO="$DEFAULT_REPO"; REF="$DEFAULT_REF"; WORKDIR="/tmp"
ASSUME_YES=0; LOCAL_MODE=0; CHECK_ONLY=0; FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --workdir) WORKDIR="${2:?}"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --force) FORCE=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --local) LOCAL_MODE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

require_root
check_systemd

CURRENT="$(installed_version)"
log "Installed: v$CURRENT"
log "Target   : $REPO @ $REF"

if [ "$LOCAL_MODE" -eq 1 ]; then
  APP_DIR="$(find_app_dir "$SCRIPT_DIR")"
  TARGET="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)"
else
  ensure_build_deps
  SRC="$WORKDIR/clinum-site-src"
  rm -rf "$SRC"; mkdir -p "$WORKDIR"
  log "Fetching ref $REF ..."
  git clone --depth 1 --branch "$REF" "$REPO" "$SRC" 2>/dev/null || {
    git clone "$REPO" "$SRC" && git -C "$SRC" checkout "$REF"
  }
  if [ -d "$SRC/$APP_REL_PATH" ]; then APP_DIR="$SRC/$APP_REL_PATH";
  elif [ -f "$SRC/package.json" ]; then APP_DIR="$SRC";
  else die "Checkout has no local-server."; fi
  TARGET="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)"
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
chown root:clinum "$ENVFILE"; chmod 0640 "$ENVFILE"

# HTTPS with site-internal CA (method B). Keeps existing CA (no client reinstall),
# issues the server cert on first TLS upgrade.
bash "$APP_DIR/packaging/site-tls.sh" issue

systemctl daemon-reload
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager || true
health_check "$HTTP_PORT" || {
  warn "Installed but /health does not answer."
  warn "Manual rollback: restore $BACKUP/.env -> $ENVFILE and $BACKUP/var-lib -> $VARDIR, then systemctl restart $SERVICE_NAME"
  exit 1
}
print_site_info "$HTTP_PORT"
log "Update v$CURRENT -> v$TARGET OK (backup: $BACKUP)"

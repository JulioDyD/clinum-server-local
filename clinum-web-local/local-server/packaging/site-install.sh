#!/usr/bin/env bash
# site-install.sh - Creates a NEW clinum-web-local site from git.
# Professional flow: code is pushed to git (push + tag vX.Y.Z) and the site
# is installed from there. Never copy by hand from Windows.
# Usage:
#   sudo bash site-install.sh [--repo URL] [--ref main|v1.2.3]
#       [--serial /dev/ttyACM0] [--http-port 8081] [--workdir /tmp] [--yes]
#   Default serial is /dev/ttyACM0. Override only with --serial <path>.
#   sudo bash site-install.sh --local [--serial /dev/ttyACM0] [--http-port 8081] [--yes]
#     --local: no clone; uses current checkout (dev only).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

REPO="$DEFAULT_REPO"; REF="$DEFAULT_REF"; SERIAL_PREFER="$DEFAULT_SERIAL_PORT"
HTTP_PORT="$DEFAULT_HTTP_PORT"; WORKDIR="/tmp"; ASSUME_YES=0; LOCAL_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --serial) SERIAL_PREFER="${2:?}"; shift 2 ;;
    --http-port) HTTP_PORT="${2:?}"; shift 2 ;;
    --workdir) WORKDIR="${2:?}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --local) LOCAL_MODE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

require_root
check_systemd

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
  rm -rf "$SRC"; mkdir -p "$WORKDIR"
  log "Cloning $REPO (@ $REF) ..."
  git clone --depth 1 --branch "$REF" "$REPO" "$SRC" 2>/dev/null || {
    git clone "$REPO" "$SRC" && git -C "$SRC" checkout "$REF"
  }
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
VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo 0.1.0)"
DEB="$(ls -1t "$APP_DIR"/dist-deb/${PKG_NAME}_${VERSION}_${DEB_ARCH}.deb 2>/dev/null | head -n1 || true)"
[ -n "$DEB" ] || die "No .deb found in $APP_DIR/dist-deb"
log ".deb: $DEB"
dpkg -i "$DEB" || { apt-get -f install -y && dpkg -i "$DEB"; }

[ -f "$ENVFILE" ] || die "postinst did not create $ENVFILE"
sed -i -E "s|^SERIAL_PORT=.*|SERIAL_PORT=$SERIAL_PORT|" "$ENVFILE"
sed -i -E "s|^LOCAL_HTTP_PORT=.*|LOCAL_HTTP_PORT=$HTTP_PORT|" "$ENVFILE"
ensure_tls_env
chown root:clinum "$ENVFILE"; chmod 0640 "$ENVFILE"

# HTTPS with site-internal CA (method B). Idempotent: keeps CA, issues server cert.
bash "$APP_DIR/packaging/site-tls.sh" issue
chown root:clinum "$ENVFILE"; chmod 0640 "$ENVFILE"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager || true
health_check "$HTTP_PORT" || true
print_site_info "$HTTP_PORT"
log "New site ready. Future updates: site-update.sh --ref <tag>"

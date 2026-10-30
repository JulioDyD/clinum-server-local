#!/usr/bin/env bash
# lib.sh - Common functions for Clinum site install/update.
# Do not run directly: `source "$(dirname "$0")/lib.sh"`.
# shellcheck disable=SC2034
set -euo pipefail

PKG_NAME="clinum-web-local"
SERVICE_NAME="clinum-web-local"
APP_REL_PATH="clinum-web-local/local-server"
DEFAULT_REPO="https://github.com/JulioDyD/clinum-server-local.git"
DEFAULT_REF="main"
DEFAULT_HTTP_PORT="8081"
DEFAULT_SERIAL_PORT="/dev/ttyACM0"
NODE_VERSION="20.18.1"
ETCDIR="/etc/clinum-web-local"
ENVFILE="$ETCDIR/.env"
VARDIR="/var/lib/clinum-web-local"
BACKUP_DIR="/var/backups/clinum-web-local"

log()  { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash $0 ..."
}

check_systemd() {
  [ -d /run/systemd/system ] || die "No active systemd (container without systemd?). This installer requires systemd."
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found. Install systemd first."
}

detect_deb_arch() {
  case "$(uname -m)" in
    x86_64) echo "amd64" ;;
    aarch64) echo "arm64" ;;
    armv7l) echo "armhf" ;;
    *) die "Unsupported arch: $(uname -m)" ;;
  esac
}

detect_node_arch() {
  case "$(uname -m)" in
    x86_64) echo "x64" ;;
    aarch64) echo "arm64" ;;
    armv7l) echo "armv7l" ;;
    *) die "Unsupported arch: $(uname -m)" ;;
  esac
}

# Finds APP_DIR whether the script lives in packaging/ or is called
# from the checkout root (compat with legacy wrappers).
find_app_dir() {
  local base="$1" dir="$base"
  if [ -d "$dir/packaging" ] && [ -f "$dir/package.json" ]; then echo "$dir"; return 0; fi
  dir="$(cd "$base/.." 2>/dev/null && pwd)"
  if [ -f "$dir/package.json" ]; then echo "$dir"; return 0; fi
  local root
  root="$(cd "$base" && git rev-parse --show-toplevel 2>/dev/null || echo "$base")"
  if [ -d "$root/$APP_REL_PATH" ]; then echo "$root/$APP_REL_PATH"; return 0; fi
  if [ -d "$PWD/$APP_REL_PATH" ]; then echo "$PWD/$APP_REL_PATH"; return 0; fi
  die "local-server not found (searched from $base). Clone full repo or use --repo."
}

# Fetches ONLY the app subtree from git. Firmware directories are versioned in
# git but must never reach a site: partial clone (no blobs) + sparse checkout
# keeps them out of /tmp and out of the .deb.
# Falls back to a full clone if the git server does not support partial clone.
fetch_app_source() {
  local repo="$1" ref="$2" dest="$3" self_root=""
  # Never delete the checkout this script is running from (e.g. when invoked
  # from /tmp/clinum-site-src): use a sibling directory in that case.
  self_root="$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd || true)"
  if [ -n "$self_root" ] && [ "$(cd "$dest" 2>/dev/null && pwd || true)" = "$self_root" ]; then
    dest="${dest}-fetch"
    warn "Running from $self_root; using $dest for the fresh checkout."
  fi
  FETCHED_SRC="$dest"
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  if git clone --depth 1 --branch "$ref" --filter=blob:none --sparse "$repo" "$dest" 2>/dev/null; then
    if git -C "$dest" sparse-checkout set --cone "$APP_REL_PATH" 2>/dev/null \
       || git -C "$dest" sparse-checkout set "$APP_REL_PATH" 2>/dev/null; then
      if [ -d "$dest/$APP_REL_PATH" ]; then
        log "Sparse checkout: solo $APP_REL_PATH (firmware no descargado)"
        return 0
      fi
    fi
    warn "Sparse checkout unavailable for $APP_REL_PATH; retrying full clone."
    rm -rf "$dest"
  fi
  git clone "$repo" "$dest" || die "Could not clone $repo"
  git -C "$dest" checkout "$ref" || die "Could not checkout $ref"
  warn "Full clone used: firmware files were downloaded (git server lacks partial clone)."
}

detect_serial() {
  local prefer="${1:-}"
  # Explicit path always wins. Empty or "auto" => fixed default (gateway uses ttyACM0).
  if [ -n "$prefer" ] && [ "$prefer" != "auto" ]; then echo "$prefer"; return 0; fi
  echo "$DEFAULT_SERIAL_PORT"
}

ensure_build_deps() {
  export DEBIAN_FRONTEND=noninteractive
  # Fast path: if toolchain is already present, skip apt entirely.
  local cxx0=""
  for c in g++-13 g++-12 g++-11; do
    if command -v "$c" >/dev/null 2>&1; then cxx0="$c"; break; fi
  done
  if [ -n "$cxx0" ] && command -v gcc >/dev/null 2>&1 && command -v make >/dev/null 2>&1 \
     && command -v python3 >/dev/null 2>&1 && command -v dpkg-deb >/dev/null 2>&1 \
     && command -v curl >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
    export CXX="$cxx0"
    log "Build deps OK (apt skipped). CXX: $CXX"
    return 0
  fi
  log "System deps (Mint/Ubuntu)"
  # Do not abort on third-party repos with old GPG (typical Chrome on Mint);
  # needed packages come from Ubuntu/Mint base.
  apt-get update -qq || true
  apt-get install -y build-essential python3 make dpkg-dev curl git adduser systemd ca-certificates xz-utils || \
    die "apt deps failed. Check network and 'sudo apt update'."
  # better-sqlite3 v12 requires C++20 => g++ >= 11
  local cxx=""
  for c in g++-13 g++-12 g++-11; do
    if command -v "$c" >/dev/null 2>&1; then cxx="$c"; break; fi
  done
  if [ -z "$cxx" ]; then
    apt-get install -y g++ || die "Could not install g++"
    cxx="g++"
  fi
  export CXX="$cxx"
  log "CXX: $CXX ($( $CXX --version | head -n1 ))"
}

# Downloads embedded Node into $1 (runtime dir) and exports PATH. Reuses /tmp.
ensure_node() {
  local runtime="$1" node_arch tar url
  node_arch="$(detect_node_arch)"
  tar="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${tar}"
  mkdir -p "$runtime"
  if [ ! -f "/tmp/$tar" ]; then
    log "Downloading Node $NODE_VERSION ($node_arch)"
    curl -fSL --retry 3 "$url" -o "/tmp/$tar" || {
      warn "Download failed (check date/time with 'timedatectl status' and network)."
      warn "If clock is wrong: sudo timedatectl set-ntp true"
      return 1
    }
  fi
  rm -rf "$runtime"; mkdir -p "$runtime"
  tar -xJf "/tmp/$tar" -C "$runtime" --strip-components=1
  export PATH="$runtime/bin:$PATH"
  log "Node: $(node -v) | npm: $(npm -v)"
}

installed_version() {
  pkg_version "/opt/$PKG_NAME/package.json" 2>/dev/null || echo "none"
}

# Reads package.json version without needing node on PATH.
pkg_version() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","unknown"))' "$1" 2>/dev/null \
    || grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$1" 2>/dev/null | head -n1 | cut -d'"' -f4
}

backup_site() {
  # Light backup: only config + DB + version (NO node_modules).
  local ts dest
  ts="$(date +%Y%m%d_%H%M%S)"
  dest="$BACKUP_DIR/backup-$ts"
  mkdir -p "$dest"
  [ -f "$ENVFILE" ] && cp -a "$ENVFILE" "$dest/.env"
  # TLS private keys/certs live in /etc (never in the .deb): back them up too.
  if [ -d "$ETCDIR/tls" ]; then cp -a "$ETCDIR/tls" "$dest/tls" 2>/dev/null || true; fi
  if [ -d "$VARDIR" ]; then cp -a "$VARDIR" "$dest/var-lib" 2>/dev/null || true; fi
  installed_version > "$dest/VERSION" 2>/dev/null || echo "none" > "$dest/VERSION"
  # Rotation: keep last 10
  ls -1dt "$BACKUP_DIR"/backup-* 2>/dev/null | tail -n +11 | xargs -r rm -rf
  echo "$dest"
}

site_scheme() {
  if [ -f "$ENVFILE" ] && grep -qE '^TLS_ENABLED=1' "$ENVFILE" 2>/dev/null; then echo "https"; else echo "http"; fi
}

# Adds missing TLS_* keys to a preserved .env (upgrades from pre-TLS installs).
# Default is plain HTTP (TLS_ENABLED=0); HTTPS is opt-in via --https.
ensure_tls_env() {
  grep -qE '^TLS_ENABLED=' "$ENVFILE" || echo "TLS_ENABLED=0" >> "$ENVFILE"
  grep -qE '^TLS_CERT_FILE=' "$ENVFILE" || echo "TLS_CERT_FILE=/etc/clinum-web-local/tls/server.crt" >> "$ENVFILE"
  grep -qE '^TLS_KEY_FILE=' "$ENVFILE" || echo "TLS_KEY_FILE=/etc/clinum-web-local/tls/server.key" >> "$ENVFILE"
  grep -qE '^TLS_REDIRECT_PORT=' "$ENVFILE" || echo "TLS_REDIRECT_PORT=8080" >> "$ENVFILE"
}

health_check() {
  local port="${1:-8081}" i scheme insecure=""
  scheme="$(site_scheme)"
  [ "$scheme" = "https" ] && insecure="-k"
  for i in $(seq 1 30); do
    if curl -fsS $insecure "${scheme}://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      log "Health OK on $scheme :$port (/health)"
      return 0
    fi
    sleep 2
  done
  warn "Service did not answer /health after 60s. Check: journalctl -u $SERVICE_NAME -f"
  return 1
}

print_site_info() {
  local port="${1:-8081}" scheme
  scheme="$(site_scheme)"
  echo ""
  echo "----------------------------------------"
  echo "Installed version: v$(installed_version)"
  echo "Panel: ${scheme}://$(hostname -I 2>/dev/null | awk '{print $1}'):$port/"
  echo "Health: ${scheme}://$(hostname -I 2>/dev/null | awk '{print $1}'):$port/health"
  echo "Logs: journalctl -u $SERVICE_NAME -f"
  echo "Config: $ENVFILE"
  echo "----------------------------------------"
}

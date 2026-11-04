#!/usr/bin/env bash
# encrypt-secret.sh - Cifra la credencial Firebase con age para commitearla.
# Uso (Linux/WSL, con age instalado):
#   bash encrypt-secret.sh --service-account /root/clinum-sa.json \
#     --init --key-out /root/clinum-age.key
#   bash encrypt-secret.sh --service-account /root/clinum-sa.json \
#     --public-key age1...
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_OUT="$APP_ROOT/secrets/firebase-service-account.json.age"

SERVICE_ACCOUNT=""; PUBLIC_KEY=""; OUT="$DEFAULT_OUT"
PROJECT_ID="clinum-2"; KEY_OUT="$APP_ROOT/secrets/age.key"; INIT=0; FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --service-account) SERVICE_ACCOUNT="${2:?}"; shift 2 ;;
    --public-key) PUBLIC_KEY="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --project) PROJECT_ID="${2:?}"; shift 2 ;;
    --init) INIT=1; shift ;;
    --key-out) KEY_OUT="${2:?}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "Opcion desconocida: $1" ;;
  esac
done

[ -n "$SERVICE_ACCOUNT" ] || die "Falta --service-account"
[ -f "$SERVICE_ACCOUNT" ] || die "No existe: $SERVICE_ACCOUNT"
command -v age >/dev/null 2>&1 || die "age no esta instalado"
command -v age-keygen >/dev/null 2>&1 || die "age-keygen no esta instalado"

validate_service_account "$SERVICE_ACCOUNT" "$PROJECT_ID"

if [ "$INIT" -eq 1 ]; then
  if [ -f "$KEY_OUT" ] && [ "$FORCE" -ne 1 ]; then
    warn "La llave ya existe: $KEY_OUT (usa --force para reemplazarla)"
  else
    umask 077
    age-keygen -o "$KEY_OUT"
  fi
  chmod 0600 "$KEY_OUT"
  PUBLIC_KEY="$(age-keygen -y "$KEY_OUT")"
  warn "La llave privada se guardara en el repo ($KEY_OUT). Usa un repositorio privado y limita el acceso."
fi

[ -n "$PUBLIC_KEY" ] || die "Falta --public-key o --init"

mkdir -p "$(dirname "$OUT")"
age -r "$PUBLIC_KEY" -o "$OUT" "$SERVICE_ACCOUNT"
chmod 0644 "$OUT"

echo "Credencial cifrada: $OUT"
echo "Clave publica age: $PUBLIC_KEY"
if [ "$INIT" -eq 1 ]; then
  echo "Llave privada compartida: $KEY_OUT"
  echo "Entregala a cada sede en /root/clinum-age.key (0600) y no la subas a git."
fi

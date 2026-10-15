#!/usr/bin/env bash
# site-tls.sh - Internal site CA + HTTPS server certificate (method B).
# No public domain needed. Clients trust the site by installing ca.crt once.
#
# Usage (as root, on the Linux Mint site machine):
#   sudo bash site-tls.sh issue          # create CA (if missing) + server cert
#   sudo bash site-tls.sh renew-server   # reissue server cert (keeps CA: no client reinstall)
#   sudo bash site-tls.sh status         # show CA/server expiry + SANs
#
# Layout: /etc/clinum-web-local/tls/{ca.key,ca.crt,server.key,server.crt}
# Server SANs cover localhost, hostname and all current LAN IPs.
# If the site IP changes (DHCP), run renew-server and restart the service.
set -euo pipefail

TLSDIR="/etc/clinum-web-local/tls"
CA_KEY="$TLSDIR/ca.key"; CA_CRT="$TLSDIR/ca.crt"
SRV_KEY="$TLSDIR/server.key"; SRV_CRT="$TLSDIR/server.crt"
SERVICE_NAME="clinum-web-local"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash $0 ..."
command -v openssl >/dev/null 2>&1 || {
  log "Installing openssl"
  apt-get update -qq || true
  apt-get install -y openssl || die "Could not install openssl"
}

ACTION="${1:-issue}"

lan_ips() {
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true
}

sans() {
  local out="DNS:localhost,DNS:$(hostname -s 2>/dev/null || hostname),IP:127.0.0.1" ip
  for ip in $(lan_ips); do out="$out,IP:$ip"; done
  echo "$out"
}

ensure_ca() {
  mkdir -p "$TLSDIR"
  if [ -f "$CA_KEY" ] && [ -f "$CA_CRT" ]; then
    log "Site CA already exists (keeping it: clients do not reinstall)"
    return 0
  fi
  log "Creating site CA (10 years)"
  openssl genrsa -out "$CA_KEY" 4096 2>/dev/null
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 3650 \
    -subj "/CN=Clinum Site CA ($(hostname))" -out "$CA_CRT" 2>/dev/null
}

issue_server() {
  log "Issuing server cert (825 days). SANs: $(sans)"
  openssl genrsa -out "$SRV_KEY" 2048 2>/dev/null
  openssl req -new -key "$SRV_KEY" -subj "/CN=$(hostname)" -out /tmp/clinum-srv.csr 2>/dev/null
  openssl x509 -req -in /tmp/clinum-srv.csr -CA "$CA_CRT" -CAkey "$CA_KEY" \
    -CAcreateserial -days 825 -sha256 \
    -extfile <(printf "subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth" "$(sans)") \
    -out "$SRV_CRT" 2>/dev/null
  rm -f /tmp/clinum-srv.csr "$TLSDIR/ca.srl" /tmp/clinum-srv.srl
}

set_perms() {
  chown -R root:clinum "$TLSDIR"
  chmod 0750 "$TLSDIR"
  chmod 0640 "$CA_KEY" "$SRV_KEY"
  chmod 0644 "$CA_CRT" "$SRV_CRT"
}

show_status() {
  echo "CA cert : $CA_CRT"
  openssl x509 -in "$CA_CRT" -noout -subject -dates -fingerprint -sha256 2>/dev/null || echo "(missing)"
  echo "Server  : $SRV_CRT"
  openssl x509 -in "$SRV_CRT" -noout -subject -dates -fingerprint -sha256 -ext subjectAltName 2>/dev/null || echo "(missing)"
}

case "$ACTION" in
  issue)
    ensure_ca
    if [ -f "$SRV_CRT" ] && [ -f "$SRV_KEY" ]; then
      log "Server cert already exists. Use renew-server to reissue (e.g. after IP change)."
    else
      issue_server
    fi
    set_perms
    show_status
    echo ""
    echo "Next: install $CA_CRT ONCE on each client PC (USB/scp), then open https://<site-ip>:8081"
    ;;
  renew-server)
    [ -f "$CA_CRT" ] || die "No site CA. Run '$0 issue' first."
    issue_server
    set_perms
    show_status
    echo ""
    echo "Now: systemctl restart $SERVICE_NAME"
    ;;
  status)
    show_status
    ;;
  *)
    die "Unknown action: $ACTION (use issue|renew-server|status)"
    ;;
esac

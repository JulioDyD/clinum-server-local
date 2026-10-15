#!/bin/bash
# DEPRECATED: use clinum-web-local/local-server/packaging/site-install.sh
# New site from git: sudo bash clinum-web-local/local-server/packaging/site-install.sh --ref main --serial auto --http-port 8081
# This wrapper keeps old path working for existing docs.
set -e
D="$(cd "$(dirname "$0")/clinum-web-local/local-server/packaging" 2>/dev/null && pwd)"
if [ -f "$D/site-install.sh" ]; then
  echo "DEPRECATED install-linux.sh -> site-install.sh" >&2
  exec bash "$D/site-install.sh" "$@"
fi
echo "ERROR: packaging/site-install.sh not found. Clone the repo first." >&2
exit 1

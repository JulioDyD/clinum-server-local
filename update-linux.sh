#!/bin/bash
# DEPRECATED: use clinum-web-local/local-server/packaging/site-update.sh
# Update site from git: sudo bash clinum-web-local/local-server/packaging/site-update.sh --ref <tag|main>
set -e
D="$(cd "$(dirname "$0")/clinum-web-local/local-server/packaging" 2>/dev/null && pwd)"
if [ -f "$D/site-update.sh" ]; then
  echo "DEPRECATED update-linux.sh -> site-update.sh" >&2
  exec bash "$D/site-update.sh" "$@"
fi
echo "ERROR: packaging/site-update.sh not found. Clone the repo first." >&2
exit 1

#!/bin/bash
# DEPRECATED: use local-server/packaging/site-update.sh
set -e
D="$(cd "$(dirname "$0")/local-server/packaging" 2>/dev/null && pwd)"
if [ -f "$D/site-update.sh" ]; then
  echo "DEPRECATED update-linux.sh -> local-server/packaging/site-update.sh" >&2
  exec bash "$D/site-update.sh" "$@"
fi
echo "ERROR: local-server/packaging/site-update.sh not found." >&2
exit 1

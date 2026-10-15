#!/bin/bash
# DEPRECATED: use local-server/packaging/site-install.sh
set -e
D="$(cd "$(dirname "$0")/local-server/packaging" 2>/dev/null && pwd)"
if [ -f "$D/site-install.sh" ]; then
  echo "DEPRECATED install-linux.sh -> local-server/packaging/site-install.sh" >&2
  exec bash "$D/site-install.sh" "$@"
fi
echo "ERROR: local-server/packaging/site-install.sh not found." >&2
exit 1

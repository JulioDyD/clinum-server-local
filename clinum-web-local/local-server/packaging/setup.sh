#!/usr/bin/env bash
# setup.sh - Compat wrapper. Use site-install.sh (new site).
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "NOTE: setup.sh is deprecated. Use site-install.sh (same basic syntax)." >&2
SERIAL="${1:-}"; HTTP="${2:-8081}"
if [ -z "$SERIAL" ] || [ "$SERIAL" = "auto" ]; then
  exec bash "$D/site-install.sh" --local --serial auto --http-port "$HTTP" --yes
else
  exec bash "$D/site-install.sh" --local --serial "$SERIAL" --http-port "$HTTP" --yes
fi

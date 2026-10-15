#!/usr/bin/env bash
# install.sh - Compat wrapper. Use site-install.sh (new site from git).
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "NOTE: install.sh is deprecated. Use site-install.sh --ref <tag|main>." >&2
echo "Example: sudo bash $D/site-install.sh --ref main --serial auto --http-port 8081" >&2
exit 2

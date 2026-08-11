#!/usr/bin/env bash
# Local static server for the sea project.

set -euo pipefail

port="${1:-8000}"

if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "Usage: ./run.sh [port]" >&2
    exit 1
fi

printf 'Sea is available at http://localhost:%s/sea/\n' "$port"
exec python3 -m http.server "$port" --bind 127.0.0.1

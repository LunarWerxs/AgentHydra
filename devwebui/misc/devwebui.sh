#!/usr/bin/env bash
# DevWebUI launcher (macOS / Linux). Double-click in a file manager, or run ./devwebui.sh
set -e
cd "$(dirname "$0")/.."

command -v bun >/dev/null 2>&1 || { echo "bun is not installed. Get it from https://bun.sh"; exit 1; }

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies (one time)..."
  bun install
fi

echo "DevWebUI starting → http://localhost:4010  (Ctrl+C to stop)"

# Open the browser shortly after the servers come up.
(
  sleep 4
  if command -v open >/dev/null 2>&1; then open http://localhost:4010
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:4010
  fi
) &

exec bun run dev

#!/usr/bin/env bash
# Start Absolute Cinema on macOS or Linux and print the address to open.
#
#   ./run.sh           start (downloads the app the first time)
#   ./run.sh stop      stop it
#   ./run.sh logs      follow its logs
#   ./run.sh update    get the newest version and restart
set -euo pipefail
cd "$(dirname "$0")"

PORT="${AC_PORT:-$(grep -E '^AC_PORT=' .env 2>/dev/null | cut -d= -f2 || true)}"
PORT="${PORT:-3000}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Get Docker Desktop from https://www.docker.com/products/docker-desktop/ and run this again."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Open Docker Desktop, wait until it says it is running, then run this again."
  exit 1
fi

case "${1:-start}" in
  stop) docker compose down; exit 0 ;;
  logs) docker compose logs -f --tail=100; exit 0 ;;
  update) docker compose pull && docker compose up -d ;;
  start) docker compose up -d ;;
  *) echo "usage: ./run.sh [start|stop|logs|update]"; exit 1 ;;
esac

echo "Starting Absolute Cinema (the first start downloads the app, about 4 GB unpacked, and takes a few minutes)..."
for _ in $(seq 1 180); do
  if curl -sf --max-time 3 "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    lan=""
    if command -v ipconfig >/dev/null 2>&1; then lan="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"; fi
    if [ -z "${lan}" ] && command -v hostname >/dev/null 2>&1; then lan="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"; fi
    echo
    echo "  Absolute Cinema is running."
    echo "  On this computer:        http://localhost:${PORT}"
    [ -n "${lan}" ] && echo "  On your phone or TV:     http://${lan}:${PORT}  (same Wi-Fi)"
    echo
    echo "  Stop it with ./run.sh stop"
    if command -v open >/dev/null 2>&1; then open "http://localhost:${PORT}" >/dev/null 2>&1 || true; fi
    exit 0
  fi
  sleep 2
done
echo "It did not start within 6 minutes. See what happened with: ./run.sh logs"
exit 1

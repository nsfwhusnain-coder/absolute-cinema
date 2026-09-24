#!/bin/bash
# Container entrypoint: prepares data folders and defaults, then runs and
# supervises the three processes that make up Absolute Cinema:
#   - stream-scraper (Bun, :3030)  finds streams
#   - remuxer        (Bun, :3040)  serves MKV releases as seekable HLS
#   - web app        (Node, :3000) the site and API
# A crashed helper is restarted (at most 3 times a minute); if the web app
# exits, the container exits and Docker restarts it.
set -euo pipefail

export SOURCE_MEMORY_DIR="${SOURCE_MEMORY_DIR:-/app/data/source-memory}"
export REMUX_CACHE_DIR="${REMUX_CACHE_DIR:-/app/transcode-cache}"
mkdir -p /app/db "$REMUX_CACHE_DIR" "$SOURCE_MEMORY_DIR"

# Zero-config defaults so `docker compose up` works without an .env file.
# API keys (TMDB, Real-Debrid) are entered in Settings after first sign-in.
export DATABASE_URL="${DATABASE_URL:-file:/app/db/absolute-cinema.db}"
export AUTH_TRUST_HOST="${AUTH_TRUST_HOST:-true}"
if [ -z "${NEXTAUTH_SECRET:-}" ]; then
  SECRET_FILE=/app/db/.auth-secret
  if [ ! -s "$SECRET_FILE" ]; then
    head -c 48 /dev/urandom | base64 | tr -d '\n' > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    echo "[entrypoint] generated a session secret in db/.auth-secret"
  fi
  NEXTAUTH_SECRET="$(cat "$SECRET_FILE")"
  export NEXTAUTH_SECRET
fi
export AUTH_SECRET="${AUTH_SECRET:-$NEXTAUTH_SECRET}"

bunx prisma db push --skip-generate

MAX_RESTARTS_PER_MINUTE=3
declare -A PIDS=()
declare -A RESTARTS=()
declare -A WINDOW_START=()

start_helper() {
  local name="$1" dir="$2"
  (cd "$dir" && exec bun index.ts) &
  PIDS[$name]=$!
  echo "[entrypoint] $name started (pid=${PIDS[$name]})"
}

restart_helper() {
  local name="$1" dir="$2" now
  now=$(date +%s)
  if [ -z "${WINDOW_START[$name]:-}" ] || [ $((now - WINDOW_START[$name])) -ge 60 ]; then
    WINDOW_START[$name]=$now
    RESTARTS[$name]=0
  fi
  RESTARTS[$name]=$((RESTARTS[$name] + 1))
  if [ "${RESTARTS[$name]}" -gt "$MAX_RESTARTS_PER_MINUTE" ]; then
    echo "[entrypoint] $name keeps crashing; exiting so Docker restarts the container"
    exit 1
  fi
  echo "[entrypoint] restarting $name (${RESTARTS[$name]}/$MAX_RESTARTS_PER_MINUTE this minute)"
  start_helper "$name" "$dir"
}

wait_for_health() {
  local name="$1" url="$2" waited=0
  until curl -sf "$url" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge 60 ]; then
      echo "[entrypoint] $name did not become healthy within 60s"
      return 1
    fi
  done
  echo "[entrypoint] $name healthy"
}

shutdown() {
  echo "[entrypoint] shutting down…"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

start_helper scraper /app/mini-services/stream-scraper
wait_for_health scraper http://127.0.0.1:3030/health
if [ "${REMUX_ENABLED:-1}" != "0" ]; then
  start_helper remuxer /app/mini-services/remuxer
else
  echo "[entrypoint] remuxer disabled (REMUX_ENABLED=0)"
fi

# The web app runs on Node: its stream proxying holds far less memory than Bun's.
NODE_ENV=production node .next/standalone/server.js &
PIDS[app]=$!
echo "[entrypoint] web app started (pid=${PIDS[app]})"

while true; do
  sleep 2
  if ! kill -0 "${PIDS[app]}" 2>/dev/null; then
    echo "[entrypoint] web app exited"
    exit 1
  fi
  if ! kill -0 "${PIDS[scraper]}" 2>/dev/null; then
    restart_helper scraper /app/mini-services/stream-scraper
  fi
  if [ -n "${PIDS[remuxer]:-}" ] && ! kill -0 "${PIDS[remuxer]}" 2>/dev/null; then
    restart_helper remuxer /app/mini-services/remuxer
  fi
done

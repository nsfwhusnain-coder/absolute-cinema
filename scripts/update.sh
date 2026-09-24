#!/usr/bin/env bash
# Update a running Absolute Cinema install to the latest code, safely.
#
#   ./scripts/update.sh               pull the current branch, rebuild, restart
#   SKIP_PULL=1 ./scripts/update.sh   rebuild the checked-out tree as-is
#
# Steps: refuse a dirty tree, pull, check free disk, snapshot the database,
# tag the running image for rollback, build, restart, and wait for health.
# Roll back with:
#   docker tag <printed rollback tag> absolute-cinema:latest && docker compose up -d
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

CONTAINER="${CONTAINER:-absolute-cinema}"
port="${AC_PORT:-}"
if [[ -z "${port}" ]] && [[ -f .env ]]; then
  port="$(sed -n 's/^AC_PORT=//p' .env | tail -1)"
fi
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${port:-3000}/api/health}"

if [[ "${SKIP_PULL:-0}" != "1" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: local changes present; commit/stash them or run with SKIP_PULL=1." >&2
    git --no-pager status --short >&2
    exit 1
  fi
  echo "=== git pull ==="
  git pull --ff-only
fi
git --no-pager log -1 --format='building: %h %s'

./scripts/disk-preflight.sh
./scripts/db-backup.sh || echo "WARNING: database backup failed; continuing" >&2

if docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  live_image="$(docker inspect --format '{{.Image}}' "${CONTAINER}")"
  rollback_tag="absolute-cinema:rollback-$(date -u +%Y%m%dT%H%M%SZ)"
  docker image tag "${live_image}" "${rollback_tag}"
  echo "rollback image: ${rollback_tag}"
fi

docker compose build
docker compose up -d

echo "=== waiting for health (${HEALTH_URL}) ==="
for _ in $(seq 1 60); do
  if curl -sf --max-time 5 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "healthy"
    ./scripts/disk-prune.sh --dangling --keep-last-2-absolute-cinema >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done
echo "ERROR: not healthy after 120s; check: docker compose logs --tail=100" >&2
exit 1

#!/usr/bin/env bash
# Safe Docker disk reclaim for Absolute Cinema hosts.
#
# IMPORTANT: `docker builder prune` is HOST-WIDE — it clears BuildKit/builder
# cache for every project on this machine, not only Absolute Cinema. On a shared
# server that can slow unrelated image builds. Default keeps recent cache
# (until=168h); pass --builder-all for a full wipe.
#
# - Default: prune builder cache older than 7 days
# - Optionally prunes dangling images
# Policy: keep the last 2 unique absolute-cinema image IDs when cleaning tagged ones.
set -euo pipefail

PRUNE_DANGLING=0
PRUNE_OLD_IMAGES=0
BUILDER_ALL=0
BUILDER_UNTIL="${BUILDER_UNTIL:-168h}"

usage() {
  cat <<'EOF'
Usage: ./scripts/disk-prune.sh [--dangling] [--keep-last-2-absolute-cinema] [--builder-all]

  (default)              docker builder prune with --filter until=168h
                         (host-wide; only drops cache older than 7 days)
  --builder-all          full host-wide builder cache wipe (docker builder prune -f)
  --dangling             also remove dangling images (docker image prune)
  --keep-last-2-absolute-cinema also remove older local absolute-cinema compose/app images,
                         keeping the 2 most recently created unique image IDs

Does NOT hard-delete volumes or running containers.

NOTE: builder prune is always host-wide (not scoped to Absolute Cinema). Prefer the
default until=168h filter on shared hosts; use --builder-all only on a
dedicated Absolute Cinema box when you need maximum reclaim.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    -h|--help) usage; exit 0 ;;
    --dangling) PRUNE_DANGLING=1 ;;
    --keep-last-2-absolute-cinema) PRUNE_OLD_IMAGES=1 ;;
    --builder-all) BUILDER_ALL=1 ;;
    *) echo "Unknown arg: ${arg}" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found" >&2
  exit 1
fi

# Short IDs (as `docker images` prints them) of the image the container is
# running and of the newest image update.sh tagged for rollback, one per line.
# The rollback tag carries its own UTC timestamp, so the newest sorts last.
short_id() {
  sed -e 's/^sha256://' | cut -c1-12
}

protected_image_ids() {
  local running rollback_ref rollback
  running="$(docker inspect --format '{{.Image}}' "${CONTAINER:-absolute-cinema}" 2>/dev/null | short_id || true)"
  rollback_ref="$(docker images --format '{{.Repository}}:{{.Tag}}' \
    | grep -E '^absolute-cinema:rollback-[0-9]{8}T[0-9]{6}Z$' | sort | tail -1 || true)"
  rollback=""
  if [ -n "${rollback_ref}" ]; then
    rollback="$(docker image inspect --format '{{.Id}}' "${rollback_ref}" 2>/dev/null | short_id || true)"
  fi
  printf '%s\n%s\n' "${running}" "${rollback}" | awk 'NF && !seen[$0]++' | tr '\n' ' '
}

echo "=== before ==="
df -h /
docker system df || true
echo

if [ "${BUILDER_ALL}" -eq 1 ]; then
  echo "=== docker builder prune -f (HOST-WIDE full wipe) ==="
  docker builder prune -f
else
  echo "=== docker builder prune -f --filter until=${BUILDER_UNTIL} (HOST-WIDE) ==="
  docker builder prune -f --filter "until=${BUILDER_UNTIL}"
fi

if [ "${PRUNE_DANGLING}" -eq 1 ]; then
  echo
  echo "=== docker image prune (dangling only) ==="
  docker image prune -f
fi

if [ "${PRUNE_OLD_IMAGES}" -eq 1 ]; then
  echo
  echo "=== keep last 2 unique absolute-cinema image IDs, remove older ==="
  # A staging image (absolute-cinema:staging) is neither counted nor removed: it is
  # usually the newest, and counting it pushed the previous live image (the
  # rollback) out of the two kept, so a deploy deleted its own rollback.
  # Dedupe by image ID (multi-tag rows for the same ID must not consume two KEEP slots).
  # Sort by docker inspect Created (RFC3339) so ordering is a true timestamp, not string date fields.
  #
  # The running image and the newest rollback are kept whatever their age, and
  # fill the two slots first. Age alone got this wrong: a staging image promoted
  # to live is older than the rollback taken before it, so the deploy after
  # that removed the rollback tag it had just printed and kept a stale one.
  protected="$(protected_image_ids)"
  idx=0
  for id in ${protected}; do
    idx=$((idx + 1))
    echo "KEEP  ${id} (running or newest rollback)"
  done
  while IFS=$'\t' read -r id ref; do
    [ -z "${id}" ] && continue
    case " ${protected} " in *" ${id} "*) continue ;; esac
    idx=$((idx + 1))
    if [ "${idx}" -le 2 ]; then
      echo "KEEP  ${id} ${ref}"
    else
      echo "REMOVE ${id} ${ref}"
      docker rmi -f "${id}" || true
    fi
  done < <(
    {
      docker images --format '{{.ID}}\t{{.Repository}}:{{.Tag}}' \
        | grep -E 'absolute-cinema' \
        | grep -v '<none>' \
        | grep -v ':staging$' \
        | awk -F'\t' '!seen[$1]++ { print $1 "\t" $2 }' || true
    } | while IFS=$'\t' read -r id ref; do
      [ -z "${id}" ] && continue
      created="$(docker image inspect --format '{{.Created}}' "${id}" 2>/dev/null || echo '1970-01-01T00:00:00Z')"
      printf '%s\t%s\t%s\n' "${created}" "${id}" "${ref}"
    done | sort -r | awk -F'\t' '{ print $2 "\t" $3 }'
  )
  if [ "${idx}" -eq 0 ]; then
    echo "No absolute-cinema-related images found."
  elif [ "${idx}" -le 2 ]; then
    echo "Found ${idx} unique absolute-cinema image ID(s); nothing older to remove."
  fi
fi

echo
echo "=== after ==="
df -h /
docker system df || true
echo
echo "Done. Builder prune is host-wide. keep-last-2 uses unique image IDs."

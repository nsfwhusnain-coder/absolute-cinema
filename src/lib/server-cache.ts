/**
 * In-memory stale-while-revalidate cache for catalog / metadata.
 * Process-local (one Node/Bun instance). TTL ~6h with background revalidate.
 */

type Entry<T> = {
  value: T;
  freshUntil: number;
  staleUntil: number;
  revalidating?: Promise<T>;
};

const store = new Map<string, Entry<unknown>>();

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_GRACE_MS = 30 * 60 * 1000;
/**
 * Entry caps. Keys include whatever the client asked for (every search
 * query, every page), and entries were only dropped when the same key was
 * read again after expiry, so the maps grew for as long as the server ran.
 * Detail payloads are 70-170 KB, so 1500 catalog entries is ~100-250 MB at
 * worst. Maps keep insertion order: re-inserting on use makes the first key
 * the least recently used one.
 */
const CATALOG_MAX_ENTRIES = 1500;
const PLAYBACK_MAX_ENTRIES = 400;
const RAW_SCRAPE_MAX_ENTRIES = 400;
const SWEEP_INTERVAL_MS = 60 * 1000;

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

let lastSweep = 0;
/** Drops expired entries from every map, at most once a minute. */
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, entry] of store) if (now >= entry.staleUntil && !entry.revalidating) store.delete(key);
  for (const [key, entry] of playbackStore) if (now > entry.until) playbackStore.delete(key);
  for (const [key, entry] of rawScrapeStore) if (now > entry.until) rawScrapeStore.delete(key);
}

export async function cachedFetch<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;

  sweep(now);
  if (hit && now < hit.freshUntil) {
    remember(store, key, hit, CATALOG_MAX_ENTRIES);
    return hit.value;
  }

  if (hit && now < hit.staleUntil) {
    if (!hit.revalidating) {
      hit.revalidating = loader()
        .then((value) => {
          remember(
            store,
            key,
            { value, freshUntil: Date.now() + ttlMs, staleUntil: Date.now() + ttlMs + STALE_GRACE_MS },
            CATALOG_MAX_ENTRIES
          );
          return value;
        })
        .catch(() => hit.value)
        .finally(() => {
          const cur = store.get(key) as Entry<T> | undefined;
          if (cur) cur.revalidating = undefined;
        });
    }
    return hit.value;
  }

  const value = await loader();
  remember(store, key, { value, freshUntil: now + ttlMs, staleUntil: now + ttlMs + STALE_GRACE_MS }, CATALOG_MAX_ENTRIES);
  return value;
}

/**
 * Per-user playback response cache (proxy URLs embed HLS session ids).
 * Complete resolves: 3m warm. Partial answers only absorb duplicate and
 * parallel requests: the player re-asks every 2-3s while discovery runs, and
 * each re-ask must reach the enriched scraper cache.
 */
const playbackStore = new Map<string, { value: unknown; until: number }>();
/** Match the 3m scraper TTL so expired signed links are never kept for 20m. */
export const PLAYBACK_TTL_MS = 3 * 60 * 1000;
/** Any partial answer: shorter than the client's 2s re-ask, so each re-ask sees new sources. */
export const PLAYBACK_PARTIAL_TTL_MS = 1_000;

export function playbackResponseTtlMs(result: { partial?: boolean }): number {
  return result.partial ? PLAYBACK_PARTIAL_TTL_MS : PLAYBACK_TTL_MS;
}

export function getCachedPlayback<T>(key: string): T | null {
  const hit = playbackStore.get(key);
  if (!hit) return null;
  if (Date.now() > hit.until) {
    playbackStore.delete(key);
    return null;
  }
  return hit.value as T;
}

export function setCachedPlayback(key: string, value: unknown, ttlMs = PLAYBACK_TTL_MS): void {
  sweep(Date.now());
  remember(playbackStore, key, { value, until: Date.now() + ttlMs }, PLAYBACK_MAX_ENTRIES);
}

function contentClassSuffix(contentClass?: string): string {
  return contentClass === "anime" ? ":anime" : "";
}

/**
 * Playback responses embed per-user HLS session IDs in proxy URLs.
 * Cache key MUST include userId or user B gets user A's sessions → HTTP 403 Forbidden
 * on every /api/hls request (breaks Opera/Chrome/etc. identically).
 *
 * Cross-user warm for *public* stream lists lives in `rawScrapeCacheKey` —
 * shared scrape payload, then per-user session mint in playback/scraper.ts.
 */
export function playbackCacheKey(
  mediaType: string,
  tmdbId: number,
  season: number | undefined,
  episode: number | undefined,
  fast: boolean | undefined,
  userId: string,
  qualityPreference: "auto" | number = "auto",
  contentClass?: string
): string {
  return `pb:${userId}:${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}:${fast ? "f" : "full"}:q${qualityPreference}${contentClassSuffix(contentClass)}`;
}

/**
 * Raw (pre-session-mint) scraper result cache — deliberately cross-user.
 * The scrape itself is identical for every user on the same title/S/E/pass;
 * only HLS session + proxy URLs minted after are user-scoped.
 */
const rawScrapeStore = new Map<string, { value: unknown; until: number }>();
/** Raw signed provider links follow the scraper's short-lived source cache. */
export const RAW_SCRAPE_TTL_MS = 3 * 60 * 1000;
export const RAW_SCRAPE_PARTIAL_TTL_MS = 1_500;

export function rawScrapeCacheKey(
  mediaType: string,
  tmdbId: number,
  season: number | undefined,
  episode: number | undefined,
  fast: boolean | undefined,
  qualityPreference: "auto" | number = "auto",
  contentClass?: string
): string {
  const qualityBucket =
    typeof qualityPreference === "number" && qualityPreference >= 1080
      ? Math.min(Math.round(qualityPreference), 4320)
      : 1080;
  return `raw:${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}:${fast ? "f" : "full"}:q${qualityBucket}${contentClassSuffix(contentClass)}`;
}

export function getCachedRawScrape<T>(key: string): T | null {
  const hit = rawScrapeStore.get(key);
  if (!hit) return null;
  if (Date.now() > hit.until) {
    rawScrapeStore.delete(key);
    return null;
  }
  return hit.value as T;
}

export function setCachedRawScrape(key: string, value: unknown, ttlMs = RAW_SCRAPE_TTL_MS): void {
  sweep(Date.now());
  remember(rawScrapeStore, key, { value, until: Date.now() + ttlMs }, RAW_SCRAPE_MAX_ENTRIES);
}

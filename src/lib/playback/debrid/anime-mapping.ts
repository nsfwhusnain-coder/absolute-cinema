import { cachedFetch } from "@/lib/server-cache";
import { tmdb } from "@/lib/tmdb";

/**
 * TMDB (show, season, episode) → Kitsu (entry, episode) for anime.
 *
 * Torrentio indexes most anime by Kitsu id with per-entry episode numbers.
 * Its IMDb lookup maps across for the usual case, but long-running shows whose
 * TMDB/IMDb season split differs from the release groups' (One Piece, Naruto
 * Shippuden, Detective Conan...) come back empty. The fallback: turn the TMDB
 * episode into an absolute number, then walk the Kitsu sequel chain (TV
 * entries only) until that number falls inside one entry.
 */

const ANI_ZIP_URL = "https://api.ani.zip/mappings";
const KITSU_URL = "https://kitsu.io/api/edge/anime";
const MAPPING_TIMEOUT_MS = 4_000;
const MAPPING_TTL_MS = 24 * 60 * 60 * 1000;
/** Sequel chains longer than this are not followed (and would be absurd). */
const MAX_CHAIN = 12;
const TV_SUBTYPES = new Set(["TV", "ONA"]);

export interface KitsuEpisode {
  kitsuId: number;
  episode: number;
}

export interface KitsuEntry {
  id: number;
  subtype: string;
  /** Null while the show is still airing. */
  episodeCount: number | null;
  sequelIds: number[];
}

interface SeasonCount {
  season_number: number;
  episode_count: number;
}

/**
 * Absolute episode number from TMDB season sizes (specials, season 0, excluded).
 * Some long runners are numbered absolutely inside each season on TMDB (One
 * Piece season 22 is episodes 1089-1155); an episode number larger than its
 * season is already absolute.
 */
export function absoluteEpisode(seasons: readonly SeasonCount[], season: number, episode: number): number {
  const own = seasons.find((s) => s.season_number === season);
  if (own && episode > own.episode_count) return episode;
  const before = seasons
    .filter((s) => s.season_number > 0 && s.season_number < season)
    .reduce((sum, s) => sum + (s.episode_count || 0), 0);
  return before + episode;
}

/**
 * Walks the chain from `first`, subtracting each TV entry's episode count until
 * `absolute` lands inside one. Non-TV entries (movies, OVAs, specials) are
 * stepped over without consuming episodes.
 */
export async function locateInChain(
  first: number,
  absolute: number,
  load: (id: number) => Promise<KitsuEntry | null>
): Promise<KitsuEpisode | null> {
  let remaining = absolute;
  const visited = new Set<number>();
  let queue = [first];
  for (let step = 0; step < MAX_CHAIN && queue.length; step++) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const entry = await load(id);
    if (!entry) return null;
    if (!TV_SUBTYPES.has(entry.subtype)) {
      queue = [...entry.sequelIds, ...queue];
      continue;
    }
    if (entry.episodeCount == null || remaining <= entry.episodeCount) {
      return { kitsuId: entry.id, episode: remaining };
    }
    remaining -= entry.episodeCount;
    queue = [...entry.sequelIds];
  }
  return null;
}

/** Null for a genuine "not found"; throws on network trouble so it is never cached. */
async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.api+json, application/json" },
    signal: AbortSignal.timeout(MAPPING_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mapping lookup failed (${res.status})`);
  return (await res.json()) as T;
}

async function firstKitsuId(tmdbId: number): Promise<number | null> {
  const data = await getJson<{ mappings?: { kitsu_id?: number | null } }>(
    `${ANI_ZIP_URL}?themoviedb_id=${tmdbId}`
  );
  return data?.mappings?.kitsu_id ?? null;
}

interface KitsuResponse {
  data?: { id: string; attributes?: { subtype?: string; episodeCount?: number | null } };
  included?: Array<{
    type: string;
    attributes?: { role?: string };
    relationships?: { destination?: { data?: { type: string; id: string } } };
  }>;
}

async function loadKitsuEntry(id: number): Promise<KitsuEntry | null> {
  return cachedFetch(
    `kitsu-entry:${id}`,
    async () => {
      const data = await getJson<KitsuResponse>(
        `${KITSU_URL}/${id}?fields[anime]=subtype,episodeCount&include=mediaRelationships.destination`
      );
      if (!data?.data) return null;
      const sequelIds = (data.included ?? [])
        .filter((rel) => rel.type === "mediaRelationships" && rel.attributes?.role === "sequel")
        .map((rel) => rel.relationships?.destination?.data)
        .filter((dest): dest is { type: string; id: string } => dest?.type === "anime")
        .map((dest) => Number(dest.id))
        .filter(Number.isFinite);
      return {
        id,
        subtype: data.data.attributes?.subtype ?? "TV",
        episodeCount: data.data.attributes?.episodeCount ?? null,
        sequelIds,
      };
    },
    MAPPING_TTL_MS
  );
}

/** Kitsu entry + episode for a TMDB anime episode, or null when it cannot be mapped. */
export async function resolveKitsuEpisode(
  tmdbId: number,
  season: number,
  episode: number
): Promise<KitsuEpisode | null> {
  try {
    const [first, details] = await Promise.all([
      cachedFetch(`kitsu-first:${tmdbId}`, () => firstKitsuId(tmdbId), MAPPING_TTL_MS),
      cachedFetch(`tmdb-anime-signals:tv:${tmdbId}`, () => tmdb.animeSignals("tv", tmdbId), 6 * 60 * 60 * 1000),
    ]);
    if (!first) return null;
    const seasons = ((details as { seasons?: SeasonCount[] }).seasons ?? []).filter(Boolean);
    const absolute = season > 0 ? absoluteEpisode(seasons, season, episode) : episode;
    return await locateInChain(first, absolute, loadKitsuEntry);
  } catch {
    return null;
  }
}

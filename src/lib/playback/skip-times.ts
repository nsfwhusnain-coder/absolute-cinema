import { cachedFetch } from "@/lib/server-cache";
import { resolveKitsuEpisode } from "@/lib/playback/debrid/anime-mapping";

/** A part of an episode the viewer can skip. */
export interface SkipSegment {
  kind: "intro" | "recap" | "credits";
  start: number;
  end: number;
  /** Length of the episode the times were measured on. */
  episodeLength: number;
}

const ANI_ZIP_URL = "https://api.ani.zip/mappings";
const ANISKIP_URL = "https://api.aniskip.com/v2/skip-times";
const TIMEOUT_MS = 4_000;
const TTL_MS = 24 * 60 * 60 * 1000;
const KIND: Record<string, SkipSegment["kind"]> = { op: "intro", "mixed-op": "intro", recap: "recap", ed: "credits", "mixed-ed": "credits" };

async function json<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  return (await res.json()) as T;
}

/**
 * Intro, recap and credits times for an anime episode, from AniSkip's
 * community database (keyed by MyAnimeList id, reached through Kitsu). Empty
 * for anything that is not anime or has no submitted times.
 */
export async function animeSkipSegments(tmdbId: number, season: number, episode: number): Promise<SkipSegment[]> {
  try {
    const kitsu = await resolveKitsuEpisode(tmdbId, season, episode);
    if (!kitsu) return [];
    const mal = await cachedFetch(
      `mal-for-kitsu:${kitsu.kitsuId}`,
      async () => (await json<{ mappings?: { mal_id?: number | null } }>(`${ANI_ZIP_URL}?kitsu_id=${kitsu.kitsuId}`))?.mappings?.mal_id ?? null,
      TTL_MS
    );
    if (!mal) return [];
    return await cachedFetch(
      `aniskip:${mal}:${kitsu.episode}`,
      async () => {
        const types = ["op", "ed", "recap", "mixed-op", "mixed-ed"].map((t) => `types[]=${t}`).join("&");
        const data = await json<{
          results?: Array<{ skipType: string; interval: { startTime: number; endTime: number }; episodeLength: number }>;
        }>(`${ANISKIP_URL}/${mal}/${kitsu.episode}?${types}&episodeLength=0`);
        return (data?.results ?? [])
          .filter((r) => KIND[r.skipType] && r.interval.endTime > r.interval.startTime)
          .map((r) => ({
            kind: KIND[r.skipType]!,
            start: r.interval.startTime,
            end: r.interval.endTime,
            episodeLength: r.episodeLength,
          }));
      },
      TTL_MS
    );
  } catch {
    return [];
  }
}

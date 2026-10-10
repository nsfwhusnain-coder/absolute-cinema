import "server-only";
import { cachedFetch } from "@/lib/server-cache";
import { tmdb } from "@/lib/tmdb";
import { resolveNextEpisode, type AiredEpisode, type SeasonMeta } from "@/lib/playback/next-episode";

/**
 * The episode after one that was finished, for Continue Watching. Uses the
 * same cache entry as the /api/tmdb/tv/<id> route, so this is usually free.
 * Null at the end of a show, for an unaired next episode, or when TMDB is
 * unreachable (the show then simply drops off the row until it answers).
 */
export async function nextEpisodeAfter(
  tvId: number,
  season: number,
  episode: number
): Promise<{ season: number; episode: number } | null> {
  try {
    const details = await cachedFetch(`tmdb:/tv/${tvId}:{}`, () => tmdb.tvDetails(tvId));
    const show = details as { seasons?: SeasonMeta[]; last_episode_to_air?: AiredEpisode | null };
    if (!show.seasons?.length) return null;
    return resolveNextEpisode(show.seasons, season, episode, show.last_episode_to_air ?? null);
  } catch {
    return null;
  }
}

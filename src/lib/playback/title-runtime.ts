import { tmdb } from "@/lib/tmdb";
import type { MediaType } from "./types";

export interface RuntimeQuestion {
  mediaType: MediaType;
  tmdbId: number;
  season?: number;
  episode?: number;
}

/**
 * How long a title runs by the catalogue, in minutes: a film, or one episode
 * of a series. Null when the catalogue does not say or cannot be reached.
 */
export async function titleRuntimeMinutes(title: RuntimeQuestion): Promise<number | null> {
  try {
    if (title.mediaType === "movie") {
      const movie = (await tmdb.movieDetails(title.tmdbId)) as { runtime?: number | null } | null;
      return movie?.runtime || null;
    }
    if (!title.season || !title.episode) return null;
    const season = await tmdb.tvSeason(title.tmdbId, title.season);
    return season?.episodes?.find((ep) => ep.episode_number === title.episode)?.runtime || null;
  } catch {
    return null;
  }
}

import "server-only";
import { NETFLIX_PROVIDER_ID } from "@/lib/tmdb";
import { cachedTmdbRoute, type TmdbRouteParams } from "@/lib/tmdb-route";

/**
 * What Home's first screens need: the banner pool and the six catalog rails,
 * built from the same cache entries the /api/tmdb proxy uses.
 */

interface ListItem {
  id: number;
  media_type?: string;
  [key: string]: unknown;
}

/** Enough for a rail after the rows above it have claimed their titles. */
const PER_LIST = 48;

async function results(path: string, params: TmdbRouteParams = {}): Promise<ListItem[]> {
  try {
    const data = (await cachedTmdbRoute(path.split("/"), params)) as { results?: ListItem[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

function unique(lists: ListItem[][], limit = PER_LIST): ListItem[] {
  const seen = new Set<string>();
  const out: ListItem[] = [];
  for (const item of lists.flat()) {
    const key = `${item.media_type ?? ""}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** The same page requests the client made, so they share cache entries with it. */
const listPages = (base: string) => Promise.all([1, 2, 3].map((n) => results(`${base}/${n}`)));
const discoverPages = (base: string) => Promise.all([1, 2, 3].map((n) => results(base, n > 1 ? { page: n } : {})));

export interface HomeFeed {
  catalog: Record<"trendingMovies" | "trendingSeries" | "netflixMovies" | "netflixSeries" | "topRatedMovies" | "topRatedSeries", ListItem[]>;
  hero: ListItem[];
}

export async function loadHomeFeed(): Promise<HomeFeed> {
  const [
    trendingMovieWeek,
    trendingMovieDay,
    trendingTvWeek,
    trendingTvDay,
    netflixMovies,
    netflixSeries,
    topRatedMovies,
    topRatedSeries,
    heroDay,
    heroWeek,
  ] = await Promise.all([
    results("trending/movie/week"),
    results("trending/movie/day"),
    results("trending/tv/week"),
    results("trending/tv/day"),
    discoverPages(`discover/movie/provider/${NETFLIX_PROVIDER_ID}`),
    discoverPages(`discover/tv/provider/${NETFLIX_PROVIDER_ID}`),
    listPages("movie/top_rated"),
    listPages("tv/top_rated"),
    results("trending/all/day"),
    results("trending/all/week"),
  ]);

  return {
    catalog: {
      trendingMovies: unique([trendingMovieWeek, trendingMovieDay], 60),
      trendingSeries: unique([trendingTvWeek, trendingTvDay], 60),
      netflixMovies: unique(netflixMovies),
      netflixSeries: unique(netflixSeries),
      topRatedMovies: unique(topRatedMovies),
      topRatedSeries: unique(topRatedSeries),
    },
    // Day first, then week: the banner pool the page filters for quality.
    hero: unique([heroDay, heroWeek], 60),
  };
}

/** How often the server refreshes Home's lists on its own, ahead of the cache's 6-hour lifetime. */
const WARM_INTERVAL_MS = 3 * 60 * 60 * 1000;
const WARM_FIRST_DELAY_MS = 30 * 1000;
let warming = false;

/**
 * Keeps Home's lists warm so the first visit of the morning doesn't wait on
 * TMDB (the site's own analytics show cold TMDB lists taking 0.5-2.6 s). Every 3 hours: entries are
 * fresh for 6, so each one is refreshed in the background before anyone sees
 * it expire.
 */
export function startHomeFeedWarmer(): void {
  if (warming) return;
  warming = true;
  const warm = () => void loadHomeFeed().catch(() => undefined);
  const first = setTimeout(warm, WARM_FIRST_DELAY_MS);
  const every = setInterval(warm, WARM_INTERVAL_MS);
  (first as { unref?: () => void }).unref?.();
  (every as { unref?: () => void }).unref?.();
}

import "server-only";
import { tmdb } from "@/lib/tmdb";
import { cachedFetch } from "@/lib/server-cache";
import { rewriteSearchResults } from "@/lib/catalog/title-alias";

/**
 * The TMDB routes the app reads, shared by the /api/tmdb proxy and by
 * server code that assembles several lists in one response (/api/home).
 * Both go through the same cache entries, keyed exactly as the proxy keys
 * them, so a list fetched by one is free for the other.
 */
export type TmdbRouteParams = Record<string, string | number | boolean>;

/** TMDB serves pages 1-500; anything else is an error upstream. */
export function pageNumber(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : 1;
}

export function tmdbRouteCacheKey(path: string[], params: TmdbRouteParams): string {
  return `tmdb:/${path.join("/")}:${JSON.stringify(params)}`;
}

export function cachedTmdbRoute(path: string[], params: TmdbRouteParams = {}): Promise<unknown> {
  return cachedFetch(tmdbRouteCacheKey(path, params), () => loadTmdbRoute(path, params));
}

async function loadTmdbRoute(path: string[], params: TmdbRouteParams): Promise<unknown> {
  const route = "/" + path.join("/");
  const [a, b, c] = path;
    if (a === "trending" && b === "movie") {
      return tmdb.trending((c as "day" | "week") || "week");
    }
    if (a === "trending" && b === "tv") {
      return tmdb.trendingTv((c as "day" | "week") || "week");
    }
    if (a === "trending" && b === "all") {
      return tmdb.trendingAll((c as "day" | "week") || "day");
    }
    if (a === "movie" && b === "popular") {
      return tmdb.popularMovies(pageNumber(c));
    }
    if (a === "movie" && b === "top_rated") {
      return tmdb.topRatedMovies(pageNumber(c));
    }
    if (a === "movie" && b === "upcoming") {
      return tmdb.upcomingMovies(pageNumber(c));
    }
    if (a === "movie" && b === "now_playing") {
      return tmdb.nowPlaying(pageNumber(c));
    }
    if (a === "tv" && b === "popular") {
      return tmdb.popularTv(pageNumber(c));
    }
    if (a === "tv" && b === "top_rated") {
      return tmdb.topRatedTv(pageNumber(c));
    }
    if (a === "tv" && b === "airing_today") {
      return tmdb.airingTodayTv(pageNumber(c));
    }
    if (a === "tv" && b === "on_the_air") {
      return tmdb.onTheAirTv(pageNumber(c));
    }
    if (a === "movie" && b && !isNaN(Number(b)) && c === "images") {
      return tmdb.movieImages(Number(b));
    }
    if (a === "tv" && b && !isNaN(Number(b)) && c === "images") {
      return tmdb.tvImages(Number(b));
    }
    if (a === "tv" && b && !isNaN(Number(b)) && c === "season") {
      const d = path[3];
      return tmdb.tvSeason(Number(b), Number(d));
    }
    if (a === "movie" && b && !isNaN(Number(b))) {
      return tmdb.movieDetails(Number(b));
    }
    if (a === "tv" && b && !isNaN(Number(b))) {
      return tmdb.tvDetails(Number(b));
    }
    if (a === "search" && b === "movie") {
      const found = await tmdb.search(
        params.query as string,
        Number(params.page) || 1
      );
      return {
        ...found,
        results: rewriteSearchResults(
          (found.results ?? []).map((row) => ({
            ...row,
            media_type: row.media_type ?? "movie",
          }))
        ),
      };
    }
    if (a === "search" && b === "multi") {
      const found = await tmdb.searchMulti(
        params.query as string,
        Number(params.page) || 1
      );
      return {
        ...found,
        results: rewriteSearchResults(found.results ?? []),
      };
    }
    if (a === "genre" && (b === "movie" || b === "tv")) {
      return tmdb.genres(b);
    }
    if (a === "discover" && b === "anime" && c) {
      return tmdb.anime(c, Number(params.page) || 1);
    }
    if (a === "discover" && (b === "movie" || b === "tv") && c === "acclaimed") {
      return tmdb.acclaimedRecent(b, Number(params.page) || 1);
    }
    if (a === "discover" && b === "movie" && c === "new-digital") {
      return tmdb.newDigitalReleases(Number(params.page) || 1, (params.region as string) || "US");
    }
    if (a === "discover" && (b === "movie" || b === "tv") && c === "provider" && path[3]) {
      return tmdb.discoverByWatchProvider(
        b,
        Number(path[3]),
        Number(params.page) || 1,
        (params.region as string) || "US"
      );
    }
    if (a === "discover" && (b === "movie" || b === "tv") && c) {
      return tmdb.discoverByGenre(b, Number(c), Number(params.page) || 1);
    }
    if (a === "collection" && b && !isNaN(Number(b))) {
      return tmdb.collection(Number(b));
    }
    if (a === "person" && b === "popular") {
      return tmdb.popularPeople(pageNumber(params.page));
    }
    if (a === "search" && b === "person") {
      return tmdb.searchPeople(params.query as string, pageNumber(params.page));
    }
    if (a === "person" && b && !isNaN(Number(b)) && c === "combined_credits") {
      return tmdb.personCredits(Number(b));
    }
    if (a === "person" && b && !isNaN(Number(b))) {
      return tmdb.personDetails(Number(b));
    }
    throw Object.assign(new Error(`Unknown TMDB route: ${route}`), { status: 404 });
}

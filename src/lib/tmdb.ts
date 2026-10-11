/**
 * TMDB API client — server-side only (hides API key).
 * Docs: https://developer.themoviedb.org/reference/intro/getting-started
 */

import { db } from "@/lib/db";
import { OPERATOR_TMDB_ENV, OPERATOR_TMDB_SETTING_KEY } from "@/lib/operator-keys";
import { trimTmdbDetails } from "@/lib/tmdb-detail-trim";
import { ANIME_SHELF_LANGUAGES } from "@/lib/tmdb-anime";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_TIMEOUT_MS = 10_000;
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export type TmdbImageSize =
  | "w92"
  | "w185"
  | "w200"
  | "w300"
  | "w342"
  | "w500"
  | "w780"
  | "w1280"
  | "original";

export function tmdbImageUrl(path: string | null | undefined, size: TmdbImageSize = "w500") {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

export interface ResponsiveTmdbImage {
  src: string;
  srcSet: string;
  sizes: string;
}

/**
 * Poster rungs the browser may choose from. A card is 150-190 CSS pixels wide,
 * so a retina screen needs about 400 pixels, not the 2000-pixel original
 * (up to 1.6 MB each, twenty-odd of them on the Home page). The original stays
 * on the ladder for the rare very large display.
 */
const POSTER_RUNGS: ReadonlyArray<readonly [TmdbImageSize, number]> = [
  ["w342", 342],
  ["w500", 500],
  ["w780", 780],
  ["original", 2000],
];
const POSTER_CARD_SIZES = "(min-width: 768px) 190px, (min-width: 640px) 170px, 150px";

const BACKDROP_RUNGS: ReadonlyArray<readonly [TmdbImageSize, number]> = [
  ["w300", 300],
  ["w780", 780],
  ["w1280", 1280],
  ["original", 3840],
];

function responsive(
  path: string,
  rungs: ReadonlyArray<readonly [TmdbImageSize, number]>,
  src: TmdbImageSize,
  sizes: string
): ResponsiveTmdbImage {
  return {
    src: tmdbImageUrl(path, src)!,
    srcSet: rungs.map(([size, width]) => `${tmdbImageUrl(path, size)} ${width}w`).join(", "),
    sizes,
  };
}

/** A poster at the width a card needs, with larger rungs for dense screens. */
export function posterSrcSet(path: string | null | undefined, sizes = POSTER_CARD_SIZES): ResponsiveTmdbImage | null {
  return path ? responsive(path, POSTER_RUNGS, "w500", sizes) : null;
}

/** A full-width backdrop: 1280 pixels for ordinary screens, the original for large or retina ones. */
export function backdropSrcSet(path: string | null | undefined, sizes = "100vw"): ResponsiveTmdbImage | null {
  return path ? responsive(path, BACKDROP_RUNGS, "w1280", sizes) : null;
}

/** Pick the best title-logo asset from a TMDB images response: English first, then language-agnostic, then whatever's first. */
export function pickTitleLogoUrl(
  images: TmdbImages | null | undefined,
  size: "w300" | "w500" | "original" = "original"
): string | null {
  if (!images?.logos?.length) return null;
  const english = images.logos.find((l) => l.iso_639_1 === "en");
  const languageless = images.logos.find((l) => l.iso_639_1 === null);
  const logo = english || languageless || images.logos[0];
  return `${TMDB_IMAGE_BASE}/${size}${logo.file_path}`;
}

async function apiKey(): Promise<string> {
  const setting = await db.appSetting.findUnique({
    where: { key: OPERATOR_TMDB_SETTING_KEY },
  });
  const key = setting?.value || process.env[OPERATOR_TMDB_ENV];
  if (!key) throw new Error("TMDB_API_KEY is not set");
  return key;
}

/**
 * TMDB issues two credentials: a v3 "API Key" (32 hex chars, query param) and
 * a v4 "API Read Access Token" (a JWT, bearer header). People paste either,
 * so both are accepted.
 */
export function tmdbAuth(key: string): { param?: string; headers: Record<string, string> } {
  const trimmed = key.trim();
  if (trimmed.startsWith("eyJ")) {
    return { headers: { Accept: "application/json", Authorization: `Bearer ${trimmed}` } };
  }
  return { param: trimmed, headers: { Accept: "application/json" } };
}

/** Checks a TMDB credential against the API without saving it. */
export async function validateTmdbKey(key: string): Promise<{ ok: boolean; error?: string }> {
  const auth = tmdbAuth(key);
  const url = new URL(`${TMDB_BASE}/configuration`);
  if (auth.param) url.searchParams.set("api_key", auth.param);
  try {
    const res = await fetch(url, { headers: auth.headers, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: "TMDB rejected this key." };
    return { ok: false, error: `TMDB returned HTTP ${res.status}.` };
  } catch {
    return { ok: false, error: "Could not reach TMDB to verify the key." };
  }
}

async function tmdbFetch<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE}${path}`);
  const auth = tmdbAuth(await apiKey());
  if (auth.param) url.searchParams.set("api_key", auth.param);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: auth.headers,
    next: { revalidate: 3600 }, // cache for an hour
    // A stalled TMDB connection must not hold a page (or the server) forever.
    signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
  });

  if (!res.ok) {
    // The status travels with the error so the API can answer 404 for a title
    // that does not exist instead of a 500 that reads as a broken API key.
    // TMDB's body is not passed on: for some errors it is a whole HTML page.
    await res.body?.cancel().catch(() => undefined);
    throw Object.assign(new Error(`TMDB ${res.status} for ${path}`), { status: res.status });
  }

  return res.json() as Promise<T>;
}

// ---------- Types ----------
export interface TmdbNames {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string | null;
  first_air_date?: string | null;
  /** Films list theirs under `titles`, series under `results`. */
  alternative_titles?: { titles?: { title: string }[]; results?: { title: string }[] };
  translations?: { translations?: { data?: { title?: string; name?: string } }[] };
  /** A series' seasons, each with the date it first aired. */
  seasons?: { season_number?: number; air_date?: string | null }[];
}

export interface TmdbMovie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string | null;
  vote_average: number;
  vote_count: number;
  genre_ids?: number[];
  runtime?: number;
  genres?: { id: number; name: string }[];
  tagline?: string;
  status?: string;
  imdb_id?: string | null;
  budget?: number;
  revenue?: number;
  original_language?: string;
  origin_country?: string[];
  production_countries?: { iso_3166_1: string; name?: string }[];
  adult?: boolean;
}

export interface TmdbTv {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string | null;
  vote_average: number;
  vote_count: number;
  genre_ids?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  genres?: { id: number; name: string }[];
  status?: string;
  seasons?: TmdbSeason[];
  created_by?: { id: number; name: string; profile_path: string | null }[];
  original_language?: string;
  origin_country?: string[];
  production_countries?: { iso_3166_1: string; name?: string }[];
  adult?: boolean;
}

export interface TmdbSeason {
  id: number;
  season_number: number;
  episode_count: number;
  name: string;
  overview: string;
  poster_path: string | null;
  air_date: string | null;
}

export interface TmdbEpisode {
  id: number;
  episode_number: number;
  season_number: number;
  name: string;
  overview: string;
  still_path: string | null;
  air_date: string | null;
  runtime: number | null;
  vote_average: number;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
  order: number;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job: string;
  department: string;
  profile_path: string | null;
}

export interface TmdbVideo {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
}

export interface TmdbPaged<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

export interface TmdbWatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string;
  display_priority: number;
}

export interface TmdbWatchProviderRegion {
  link: string;
  flatrate?: TmdbWatchProvider[];
  rent?: TmdbWatchProvider[];
  buy?: TmdbWatchProvider[];
}

export interface TmdbReview {
  id: string;
  author: string;
  content: string;
  created_at: string;
  author_details: { rating: number | null };
}

export interface TmdbImage {
  file_path: string;
  width: number;
  height: number;
  aspect_ratio: number;
  iso_639_1: string | null;
}

export interface TmdbImages {
  backdrops: TmdbImage[];
  posters: TmdbImage[];
  logos: TmdbImage[];
}

export interface TmdbPerson {
  id: number;
  name: string;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  place_of_birth: string | null;
  profile_path: string | null;
  known_for_department: string;
  also_known_as?: string[];
  popularity?: number;
  gender?: number;
  adult?: boolean;
}

export interface TmdbPersonCredit {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  vote_average?: number;
  popularity?: number;
  media_type?: string;
  character?: string;
  job?: string;
  department?: string;
  adult?: boolean;
  genre_ids?: number[];
  vote_count?: number;
  episode_count?: number;
}

export interface TmdbPersonCredits {
  id: number;
  cast: TmdbPersonCredit[];
  crew: TmdbPersonCredit[];
}

export interface TmdbAnimeSignalsRaw {
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  original_language?: string;
  origin_country?: string[];
  production_countries?: { iso_3166_1: string; name?: string }[];
  keywords?: {
    keywords?: { id: number; name: string }[];
    results?: { id: number; name: string }[];
  };
}

export { heroPicks, isShowcaseWorthy, showcase, withoutAdultTitles } from "./tmdb-filters";

// ---------- Endpoints ----------
export const tmdb = {
  trending: (window: "day" | "week" = "week") =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/trending/movie/${window}`),

  trendingTv: (window: "day" | "week" = "week") =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/trending/tv/${window}`),

  /** Movies and shows together: what everyone is watching today. */
  trendingAll: (window: "day" | "week" = "day") =>
    tmdbFetch<TmdbPaged<(TmdbMovie | TmdbTv) & { media_type?: string }>>(`/trending/all/${window}`),

  /**
   * Recent, well-reviewed titles that people are watching now: the "worth
   * your evening" picks for the Movies and Shows pages.
   */
  acclaimedRecent: (type: "movie" | "tv", page = 1) => {
    const since = new Date(Date.now() - ACCLAIMED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    return tmdbFetch<TmdbPaged<TmdbMovie | TmdbTv>>(`/discover/${type}`, {
      ...(type === "movie" ? { "primary_release_date.gte": since } : { "air_date.gte": since }),
      "vote_average.gte": type === "movie" ? 7.2 : 7.5,
      "vote_count.gte": type === "movie" ? 300 : 150,
      sort_by: "popularity.desc",
      include_adult: false,
      ...NOT_ANIME,
      page,
    });
  },

  popularMovies: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/movie/popular`, { page }),

  topRatedMovies: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/movie/top_rated`, { page }),

  upcomingMovies: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/movie/upcoming`, { page }),

  nowPlaying: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/movie/now_playing`, { page }),

  popularTv: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/tv/popular`, { page }),

  topRatedTv: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/tv/top_rated`, { page }),

  airingTodayTv: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/tv/airing_today`, { page }),

  onTheAirTv: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/tv/on_the_air`, { page }),

  movieDetails: (id: number) =>
    tmdbFetch<
      TmdbMovie & {
        credits?: { cast: TmdbCastMember[]; crew: TmdbCrewMember[] };
        videos?: { results: TmdbVideo[] };
        recommendations?: TmdbPaged<TmdbMovie>;
        similar?: TmdbPaged<TmdbMovie>;
        reviews?: TmdbPaged<TmdbReview>;
        "watch/providers"?: { results: Record<string, TmdbWatchProviderRegion> };
      }
    >(`/movie/${id}`, {
      append_to_response:
        "credits,videos,recommendations,similar,reviews,release_dates",
    }).then(trimTmdbDetails),

  movieImages: (id: number) =>
    tmdbFetch<TmdbImages>(`/movie/${id}/images`, { include_image_language: "en,null" }),

  tvImages: (id: number) =>
    tmdbFetch<TmdbImages>(`/tv/${id}/images`, { include_image_language: "en,null" }),

  tvDetails: (id: number) =>
    tmdbFetch<
      TmdbTv & {
        credits?: { cast: TmdbCastMember[]; crew: TmdbCrewMember[] };
        videos?: { results: TmdbVideo[] };
        recommendations?: TmdbPaged<TmdbTv>;
        similar?: TmdbPaged<TmdbTv>;
        reviews?: TmdbPaged<TmdbReview>;
        "watch/providers"?: { results: Record<string, TmdbWatchProviderRegion> };
      }
    >(`/tv/${id}`, {
      append_to_response:
        "credits,videos,recommendations,similar,reviews,content_ratings",
    }).then(trimTmdbDetails),

  /**
   * Light details + keywords only. Used by playback to decide contentClass=anime
   * without paying for the full movieDetails/tvDetails append set.
   */
  animeSignals: (type: "movie" | "tv", id: number) =>
    tmdbFetch<TmdbAnimeSignalsRaw>(`/${type}/${id}`, {
      append_to_response: "keywords",
    }),

  watchProviders: (id: number, type: "movie" | "tv") =>
    tmdbFetch<{ results: Record<string, TmdbWatchProviderRegion> }>(`/${type}/${id}/watch/providers`),

  /** Every name a title goes by, in every language, with its dates: for telling a release of it from a namesake. */
  names: (id: number, type: "movie" | "tv") =>
    tmdbFetch<TmdbNames>(`/${type}/${id}`, { append_to_response: "alternative_titles,translations" }),

  /** IMDb id lookup — Torrentio (debrid tier) is keyed by imdb id, not tmdb id. */
  externalIds: (id: number, type: "movie" | "tv") =>
    tmdbFetch<{ id: number; imdb_id: string | null }>(`/${type}/${id}/external_ids`),

  tvSeason: (id: number, season: number) =>
    tmdbFetch<{ episodes: TmdbEpisode[]; name: string; overview: string; season_number: number }>(
      `/tv/${id}/season/${season}`
    ),

  search: (query: string, page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie & { media_type?: string }>>(`/search/movie`, { query, page, include_adult: false }),

  searchMulti: (query: string, page = 1) =>
    tmdbFetch<TmdbPaged<(TmdbMovie | TmdbTv) & { media_type: string }>>(`/search/multi`, { query, page, include_adult: false }),

  genres: (type: "movie" | "tv" = "movie") =>
    tmdbFetch<{ genres: { id: number; name: string }[] }>(`/genre/${type}/list`),

  discoverByGenre: (type: "movie" | "tv", genreId: number, page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie | TmdbTv>>(`/discover/${type}`, {
      with_genres: genreId,
      page,
      sort_by: "popularity.desc",
      include_adult: false,
      ...NOT_ANIME,
    }),

  /** Discover titles available on a streaming provider (e.g. Netflix = 8). */
  discoverByWatchProvider: (
    type: "movie" | "tv",
    providerId: number,
    page = 1,
    region = "US"
  ) =>
    tmdbFetch<TmdbPaged<TmdbMovie | TmdbTv>>(`/discover/${type}`, {
      with_watch_providers: providerId,
      watch_region: region,
      page,
      sort_by: "popularity.desc",
      // Popular and liked: without a floor the list leads with whatever
      // landed this week, however it was received.
      "vote_average.gte": PROVIDER_MIN_RATING,
      "vote_count.gte": type === "movie" ? 250 : 120,
      include_adult: false,
      ...NOT_ANIME,
    }),

  /**
   * Films that reached streaming / digital purchase recently (release types
   * 4 and 5), newest first, with enough votes to skip placeholder entries.
   */
  newDigitalReleases: (page = 1, region = "US") => {
    const today = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - NEW_RELEASE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    return tmdbFetch<TmdbPaged<TmdbMovie>>("/discover/movie", {
      with_release_type: "4|5",
      region,
      "release_date.gte": since,
      "release_date.lte": today,
      "vote_count.gte": NEW_RELEASE_MIN_VOTES,
      "vote_average.gte": NEW_RELEASE_MIN_RATING,
      sort_by: "popularity.desc",
      include_adult: false,
      ...NOT_ANIME,
      page,
    });
  },

  /** Series that premiered in the last few months and have been well received so far. */
  newSeries: (page = 1) => {
    const today = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - NEW_RELEASE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    return tmdbFetch<TmdbPaged<TmdbTv>>("/discover/tv", {
      "first_air_date.gte": since,
      "first_air_date.lte": today,
      "vote_count.gte": NEW_SERIES_MIN_VOTES,
      "vote_average.gte": NEW_RELEASE_MIN_RATING,
      sort_by: "popularity.desc",
      include_adult: false,
      ...NOT_ANIME,
      page,
    });
  },

  /**
   * The Anime section: Japanese animation, with Chinese and Korean animation alongside. `kind`: trending, season (aired in the last few
   * months), top, movies, acclaimed (recent and loved: the Anime page hero),
   * or genre-<TMDB TV genre id>.
   */
  anime: (kind: string, page = 1) => {
    const base = { with_genres: ANIME_GENRE_ID, with_original_language: ANIME_SHELF_LANGUAGES.join("|"), include_adult: false, page };
    const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    if (kind === "movies") {
      return tmdbFetch<TmdbPaged<TmdbMovie>>("/discover/movie", { ...base, sort_by: "popularity.desc", "vote_count.gte": 100 });
    }
    const tv = (params: Record<string, string | number | boolean>) =>
      tmdbFetch<TmdbPaged<TmdbTv>>("/discover/tv", { ...base, ...params });
    if (kind === "season") return tv({ "air_date.gte": since(90), sort_by: "popularity.desc" });
    if (kind === "top") return tv({ sort_by: "vote_average.desc", "vote_count.gte": 400 });
    if (kind === "acclaimed") {
      return tv({ "air_date.gte": since(365), "vote_average.gte": 8, "vote_count.gte": 80, sort_by: "popularity.desc" });
    }
    const genre = /^genre-(\d+)$/.exec(kind);
    if (genre) return tv({ with_genres: `${ANIME_GENRE_ID},${genre[1]}`, sort_by: "popularity.desc", "vote_count.gte": 50 });
    return tv({ sort_by: "popularity.desc", "vote_average.gte": 7, "vote_count.gte": 50 });
  },

  /** A film series ("Dune Collection") and all its parts. */
  collection: (id: number) =>
    tmdbFetch<{ id: number; name: string; parts?: TmdbMovie[] }>(`/collection/${id}`),

  personDetails: (id: number) => tmdbFetch<TmdbPerson>(`/person/${id}`),

  /** Popular people (the profile picture picker's "Famous faces"). */
  popularPeople: (page = 1) =>
    tmdbFetch<TmdbPaged<{ id: number; name: string; profile_path: string | null; known_for_department?: string }>>(`/person/popular`, { page }),

  searchPeople: (query: string, page = 1) =>
    tmdbFetch<TmdbPaged<{ id: number; name: string; profile_path: string | null; known_for_department?: string }>>(`/search/person`, {
      query,
      page,
      include_adult: false,
    }),

  personCredits: (id: number) =>
    tmdbFetch<TmdbPersonCredits>(`/person/${id}/combined_credits`),
};

/** TMDB watch provider id for Netflix (US catalog). */
export const NETFLIX_PROVIDER_ID = 8;

const NEW_RELEASE_WINDOW_DAYS = 120;
/** TMDB's Animation genre; with an East Asian original language it is shelved as anime. */
const ANIME_GENRE_ID = 16;
/** TMDB's "anime" keyword. Excluding it keeps anime out of general discover lists; it has a section of its own. */
const ANIME_KEYWORD_ID = 210024;
const NOT_ANIME = { without_keywords: ANIME_KEYWORD_ID } as const;
/** A new series has had less time to collect votes than a film on digital release. */
const NEW_SERIES_MIN_VOTES = 40;
/** How far back the Movies/Shows "acclaimed now" picks may reach. */
const ACCLAIMED_WINDOW_DAYS = 540;
const NEW_RELEASE_MIN_VOTES = 60;
const NEW_RELEASE_MIN_RATING = 6.5;
/** Streaming-service lists: well received titles only. */
const PROVIDER_MIN_RATING = 6.5;

export const COMMON_GENRES: { id: number; name: string }[] = [
  { id: 28, name: "Action" },
  { id: 12, name: "Adventure" },
  { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" },
  { id: 99, name: "Documentary" },
  { id: 18, name: "Drama" },
  { id: 10751, name: "Family" },
  { id: 14, name: "Fantasy" },
  { id: 36, name: "History" },
  { id: 27, name: "Horror" },
  { id: 9648, name: "Mystery" },
  { id: 10749, name: "Romance" },
  { id: 878, name: "Science Fiction" },
  { id: 53, name: "Thriller" },
  { id: 10752, name: "War" },
  { id: 37, name: "Western" },
];

/** TMDB TV genre list (subset used for Shows hub rows). */
export const COMMON_TV_GENRES: { id: number; name: string }[] = [
  { id: 10759, name: "Action & Adventure" },
  { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" },
  { id: 99, name: "Documentary" },
  { id: 18, name: "Drama" },
  { id: 10751, name: "Family" },
  { id: 10762, name: "Kids" },
  { id: 9648, name: "Mystery" },
  { id: 10765, name: "Sci-Fi & Fantasy" },
  { id: 10768, name: "War & Politics" },
  { id: 37, name: "Western" },
];

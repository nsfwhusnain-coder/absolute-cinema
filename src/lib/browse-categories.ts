/**
 * Fixed category taxonomy for hubs / View All (Appendix C).
 * Proxy paths match `src/app/api/tmdb/[...path]/route.ts` allowlist only.
 */

import { COMMON_GENRES, COMMON_TV_GENRES } from "@/lib/tmdb";

export type MediaKind = "movie" | "tv";

export interface BrowseCategory {
  slug: string;
  title: string;
  mediaType: MediaKind;
  /** Whether load-more via page is supported. */
  paged: boolean;
  /**
   * Path after `/api/tmdb/` for the given page.
   * Genre discover uses path-segment genre id + optional `?page=`.
   * List endpoints use path-segment page.
   */
  tmdbPathForPage: (page: number) => string;
}

export interface HubRow {
  id: string;
  title: string;
  tmdbPath: string;
  /** When a hub mixes kinds (the Anime page has films too). */
  mediaType?: MediaKind;
}

function listPath(prefix: string, page: number): string {
  return `${prefix}/${page}`;
}

function discoverPath(type: MediaKind, genreId: number, page: number): string {
  if (page <= 1) return `discover/${type}/${genreId}`;
  return `discover/${type}/${genreId}?page=${page}`;
}

function genreTitle(type: MediaKind, id: number): string {
  const list = type === "movie" ? COMMON_GENRES : COMMON_TV_GENRES;
  return list.find((g) => g.id === id)?.name ?? `Genre ${id}`;
}

/** Streaming services with their own home rail and View All pages (TMDB watch-provider ids, US). */
export const STREAMING_SERVICES = [
  { slug: "prime", name: "Prime Video", providerId: 9 },
  { slug: "disney", name: "Disney+", providerId: 337 },
  { slug: "apple", name: "Apple TV+", providerId: 350 },
  { slug: "max", name: "Max", providerId: 1899 },
  { slug: "hulu", name: "Hulu", providerId: 15 },
] as const;

export type StreamingService = (typeof STREAMING_SERVICES)[number];

export function providerPath(type: MediaKind, providerId: number, page: number): string {
  return page <= 1
    ? `discover/${type}/provider/${providerId}`
    : `discover/${type}/provider/${providerId}?page=${page}`;
}

function serviceCategories(): Record<string, BrowseCategory> {
  const out: Record<string, BrowseCategory> = {};
  for (const service of STREAMING_SERVICES) {
    for (const type of ["movie", "tv"] as const) {
      const slug = `${service.slug}-${type === "movie" ? "movies" : "tv"}`;
      out[slug] = {
        slug,
        title: `${type === "movie" ? "Movies" : "Series"} on ${service.name}`,
        mediaType: type,
        paged: true,
        tmdbPathForPage: (page) => providerPath(type, service.providerId, page),
      };
    }
  }
  return out;
}

const STATIC_CATEGORIES: Record<string, BrowseCategory> = {
  ...serviceCategories(),
  "new-digital": {
    slug: "new-digital",
    title: "New on Digital",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) =>
      page <= 1 ? "discover/movie/new-digital" : `discover/movie/new-digital?page=${page}`,
  },
  "trending-movies": {
    slug: "trending-movies",
    title: "Trending Movies",
    mediaType: "movie",
    paged: false,
    tmdbPathForPage: () => "trending/movie/week",
  },
  "now-playing": {
    slug: "now-playing",
    title: "Now Playing",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) => listPath("movie/now_playing", page),
  },
  "popular-movies": {
    slug: "popular-movies",
    title: "Popular Movies",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) => listPath("movie/popular", page),
  },
  "top-rated-movies": {
    slug: "top-rated-movies",
    title: "Top Rated Movies",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) => listPath("movie/top_rated", page),
  },
  "upcoming-movies": {
    slug: "upcoming-movies",
    title: "Upcoming",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) => listPath("movie/upcoming", page),
  },
  "trending-tv": {
    slug: "trending-tv",
    title: "Trending Series",
    mediaType: "tv",
    paged: false,
    tmdbPathForPage: () => "trending/tv/week",
  },
  "popular-tv": {
    slug: "popular-tv",
    title: "Popular Shows",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) => listPath("tv/popular", page),
  },
  "top-rated-tv": {
    slug: "top-rated-tv",
    title: "Top Rated Series",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) => listPath("tv/top_rated", page),
  },
  "netflix-movies": {
    slug: "netflix-movies",
    title: "Movies on Netflix",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) =>
      page <= 1 ? "discover/movie/provider/8" : `discover/movie/provider/8?page=${page}`,
  },
  "netflix-tv": {
    slug: "netflix-tv",
    title: "TV Series on Netflix",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) =>
      page <= 1 ? "discover/tv/provider/8" : `discover/tv/provider/8?page=${page}`,
  },
  "airing-today": {
    slug: "airing-today",
    title: "Airing Today",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) => listPath("tv/airing_today", page),
  },
  "on-the-air": {
    slug: "on-the-air",
    title: "On The Air",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) => listPath("tv/on_the_air", page),
  },
};

const GENRE_MOVIE_RE = /^genre-movie-(\d+)$/;
const GENRE_TV_RE = /^genre-tv-(\d+)$/;

/** Resolve a View All slug to a category; unknown → null (404). */
export function resolveCategory(slug: string): BrowseCategory | null {
  const staticCat = STATIC_CATEGORIES[slug];
  if (staticCat) return staticCat;

  const anime = ANIME_ROWS.find((row) => `anime-${row.kind}` === slug);
  if (anime) {
    return {
      slug,
      title: anime.title,
      mediaType: anime.mediaType,
      paged: true,
      tmdbPathForPage: (page) => animePath(anime.kind, page),
    };
  }

  const movieGenre = GENRE_MOVIE_RE.exec(slug);
  if (movieGenre) {
    const id = Number(movieGenre[1]);
    return {
      slug,
      title: genreTitle("movie", id),
      mediaType: "movie",
      paged: true,
      tmdbPathForPage: (page) => discoverPath("movie", id, page),
    };
  }

  const tvGenre = GENRE_TV_RE.exec(slug);
  if (tvGenre) {
    const id = Number(tvGenre[1]);
    return {
      slug,
      title: genreTitle("tv", id),
      mediaType: "tv",
      paged: true,
      tmdbPathForPage: (page) => discoverPath("tv", id, page),
    };
  }

  return null;
}

/** Movies hub rows (Appendix C). */
export function movieHubRows(): HubRow[] {
  const base: HubRow[] = [
    { id: "trending-movies", title: "Trending This Week", tmdbPath: "trending/movie/week" },
    { id: "now-playing", title: "Now Playing", tmdbPath: "movie/now_playing/1" },
    { id: "popular-movies", title: "Popular Movies", tmdbPath: "movie/popular/1" },
    { id: "top-rated-movies", title: "Top Rated Movies", tmdbPath: "movie/top_rated/1" },
    { id: "upcoming-movies", title: "Upcoming", tmdbPath: "movie/upcoming/1" },
  ];
  const genres: HubRow[] = COMMON_GENRES.slice(0, 6).map((g) => ({
    id: `genre-movie-${g.id}`,
    title: g.name,
    tmdbPath: `discover/movie/${g.id}`,
  }));
  return [...base, ...genres];
}

const ANIME_ROWS: Array<{ kind: string; title: string; mediaType: MediaKind }> = [
  { kind: "trending", title: "Trending Anime", mediaType: "tv" },
  { kind: "season", title: "New This Season", mediaType: "tv" },
  { kind: "top", title: "Top Rated Anime", mediaType: "tv" },
  { kind: "movies", title: "Anime Movies", mediaType: "movie" },
  { kind: "genre-10759", title: "Action & Adventure", mediaType: "tv" },
  { kind: "genre-10765", title: "Fantasy & Sci-Fi", mediaType: "tv" },
  { kind: "genre-35", title: "Comedy", mediaType: "tv" },
  { kind: "genre-18", title: "Drama", mediaType: "tv" },
  { kind: "genre-9648", title: "Mystery", mediaType: "tv" },
];

function animePath(kind: string, page: number): string {
  return page <= 1 ? `discover/anime/${kind}` : `discover/anime/${kind}?page=${page}`;
}

/** Anime hub rows. */
export function animeHubRows(): HubRow[] {
  return ANIME_ROWS.map((row) => ({ id: `anime-${row.kind}`, title: row.title, tmdbPath: animePath(row.kind, 1), mediaType: row.mediaType }));
}

/** Shows hub rows (Appendix C, full parity including extended TV lists). */
export function showsHubRows(): HubRow[] {
  const base: HubRow[] = [
    { id: "trending-tv", title: "Trending Shows", tmdbPath: "trending/tv/week" },
    { id: "popular-tv", title: "Popular Shows", tmdbPath: "tv/popular/1" },
    { id: "top-rated-tv", title: "Top Rated Shows", tmdbPath: "tv/top_rated/1" },
    { id: "airing-today", title: "Airing Today", tmdbPath: "tv/airing_today/1" },
    { id: "on-the-air", title: "On The Air", tmdbPath: "tv/on_the_air/1" },
  ];
  const genres: HubRow[] = COMMON_TV_GENRES.slice(0, 6).map((g) => ({
    id: `genre-tv-${g.id}`,
    title: g.name,
    tmdbPath: `discover/tv/${g.id}`,
  }));
  return [...base, ...genres];
}

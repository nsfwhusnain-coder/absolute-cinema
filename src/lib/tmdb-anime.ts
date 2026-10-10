/** TMDB Animation genre — required, never sufficient on its own. */
export const TMDB_ANIMATION_GENRE_ID = 16;

export interface TmdbAnimeSignals {
  genreIds?: number[];
  genres?: { id: number; name?: string }[];
  originalLanguage?: string | null;
  originCountry?: string | string[] | null;
  productionCountries?: Array<string | { iso_3166_1?: string }>;
  keywords?: Array<string | { name?: string }>;
}

function collectGenreIds(signals: TmdbAnimeSignals): Set<number> {
  const ids = new Set<number>(signals.genreIds ?? []);
  for (const genre of signals.genres ?? []) {
    if (Number.isFinite(genre.id)) ids.add(genre.id);
  }
  return ids;
}

function genreNames(signals: TmdbAnimeSignals): string[] {
  return (signals.genres ?? []).map((genre) => (genre.name ?? "").toLowerCase());
}

function keywordNames(signals: TmdbAnimeSignals): string[] {
  return (signals.keywords ?? []).map((keyword) =>
    (typeof keyword === "string" ? keyword : keyword.name ?? "").toLowerCase()
  );
}

function originCountries(signals: TmdbAnimeSignals): string[] {
  const raw = signals.originCountry;
  const listed = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const production = (signals.productionCountries ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.iso_3166_1 ?? ""
  );
  return [...listed, ...production]
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Animation (16) AND (JP origin / ja language / "anime" keyword or genre).
 * Western animation stays on the default ranker.
 */
export function isTmdbAnimeTitle(signals: TmdbAnimeSignals): boolean {
  const names = genreNames(signals);
  const hasAnimation =
    collectGenreIds(signals).has(TMDB_ANIMATION_GENRE_ID) ||
    names.some((name) => name.includes("animation") || name === "anime");
  if (!hasAnimation) return false;

  const language = (signals.originalLanguage ?? "").trim().toLowerCase();
  if (language === "ja" || language === "jpn") return true;
  if (originCountries(signals).includes("JP")) return true;
  if (names.some((name) => name.includes("anime"))) return true;
  if (keywordNames(signals).some((name) => name.includes("anime"))) return true;
  return false;
}

export function keywordsFromTmdbAppend(raw: {
  keywords?: Array<{ name?: string }>;
  results?: Array<{ name?: string }>;
} | null | undefined): string[] {
  const rows = raw?.keywords ?? raw?.results ?? [];
  return rows.map((row) => row.name ?? "").filter(Boolean);
}

/**
 * Where a title is shelved in the catalog. Wider than `isTmdbAnimeTitle`
 * (which decides how a title is played): Chinese donghua and Korean aeni look
 * and browse like anime, so they live in the Anime section with it.
 */
export const ANIME_SHELF_LANGUAGES = ["ja", "zh", "ko"] as const;
const ANIME_SHELF_COUNTRIES = new Set(["JP", "CN", "KR", "TW", "HK"]);

export function belongsOnAnimeShelf(signals: TmdbAnimeSignals): boolean {
  if (isTmdbAnimeTitle(signals)) return true;
  if (!collectGenreIds(signals).has(TMDB_ANIMATION_GENRE_ID)) return false;
  const language = (signals.originalLanguage ?? "").trim().toLowerCase();
  if ((ANIME_SHELF_LANGUAGES as readonly string[]).includes(language)) return true;
  return originCountries(signals).some((code) => ANIME_SHELF_COUNTRIES.has(code));
}

/** A title as TMDB's list endpoints return it. */
export interface TmdbListTitle {
  genre_ids?: number[];
  original_language?: string;
  origin_country?: string[];
}

/** Anime has its own section; general lists (trending, popular, by genre or service) leave it out. */
export function withoutAnimeTitles<T extends TmdbListTitle>(items: readonly T[]): T[] {
  return items.filter(
    (item) => !belongsOnAnimeShelf({ genreIds: item.genre_ids, originalLanguage: item.original_language, originCountry: item.origin_country })
  );
}

/** Drop TMDB adult titles when the household setting is on (default). */
export function withoutAdultTitles<T extends { adult?: boolean }>(
  items: T[],
  hideAdult = true
): T[] {
  if (!hideAdult) return items;
  return items.filter((item) => item.adult !== true);
}

interface ShowcaseCandidate {
  vote_average?: number;
  vote_count?: number;
  backdrop_path?: string | null;
  poster_path?: string | null;
  media_type?: string;
}

/**
 * The bar for anything featured on Home: well liked, seen by enough people
 * for the rating to mean something, and with artwork to show. Trending lists
 * are full of titles released this week with a handful of votes or a 5.x
 * average; those belong in search, not on the front page.
 */
const SHOWCASE_MIN_RATING = 6.8;
const SHOWCASE_MIN_VOTES: Record<"movie" | "tv", number> = { movie: 250, tv: 120 };
/** The banner holds itself to a higher bar still: the big, loved titles. */
const HERO_MIN_RATING = 7.2;
const HERO_MIN_VOTES: Record<"movie" | "tv", number> = { movie: 800, tv: 300 };

function passes(item: ShowcaseCandidate, minRating: number, minVotes: Record<"movie" | "tv", number>, mediaType?: "movie" | "tv"): boolean {
  const kind = mediaType ?? (item.media_type === "tv" ? "tv" : "movie");
  return (
    Boolean(item.backdrop_path && item.poster_path) &&
    (item.vote_average ?? 0) >= minRating &&
    (item.vote_count ?? 0) >= minVotes[kind]
  );
}

export function isShowcaseWorthy(item: ShowcaseCandidate, mediaType?: "movie" | "tv"): boolean {
  return passes(item, SHOWCASE_MIN_RATING, SHOWCASE_MIN_VOTES, mediaType);
}

/** Home-worthy titles, in their original (popularity) order. */
export function showcase<T extends ShowcaseCandidate>(items: T[], mediaType?: "movie" | "tv"): T[] {
  return items.filter((item) => isShowcaseWorthy(item, mediaType));
}

/** Banner picks: the loved hits first, topped up from the showcase bar if there are too few. */
export function heroPicks<T extends ShowcaseCandidate>(items: T[], count: number): T[] {
  const hits = items.filter((item) => passes(item, HERO_MIN_RATING, HERO_MIN_VOTES));
  if (hits.length >= count) return hits.slice(0, count);
  const rest = showcase(items).filter((item) => !hits.includes(item));
  return [...hits, ...rest].slice(0, count);
}

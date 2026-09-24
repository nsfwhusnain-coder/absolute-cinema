import type { TmdbPersonCredit } from "@/lib/tmdb";

/** TMDB TV genres that are appearances, not roles: Talk, News, Reality. */
const APPEARANCE_GENRES = new Set([10767, 10763, 10764]);
const SELF_CHARACTER = /^(self|himself|herself|themselves|narrator \(voice\)|host)\b/i;

/** Talk-show spots, award shows and "as himself" cameos: real credits, but not what a person is known for. */
export function isAppearanceCredit(credit: TmdbPersonCredit): boolean {
  if (credit.genre_ids?.some((g) => APPEARANCE_GENRES.has(g))) return true;
  return SELF_CHARACTER.test((credit.character ?? "").trim());
}

/**
 * Ranks credits by how well known the work is. vote_count tracks lasting
 * audience size; popularity alone is dominated by this week's trending
 * titles and long-running talk shows.
 */
export function creditScore(credit: TmdbPersonCredit): number {
  const votes = Math.log10((credit.vote_count ?? 0) + 1);
  const popularity = Math.log10((credit.popularity ?? 0) + 1);
  return votes * 3 + popularity + (credit.vote_average ?? 0) / 5;
}

/** Best title to offer as the person's headline "Play" action. */
export function pickFeaturedCredit(credits: TmdbPersonCredit[]): TmdbPersonCredit | null {
  const roles = credits.filter((c) => !isAppearanceCredit(c));
  const pool = roles.length > 0 ? roles : credits;
  const ranked = [...pool].sort((a, b) => creditScore(b) - creditScore(a));
  return ranked.find((c) => c.poster_path) ?? ranked[0] ?? null;
}

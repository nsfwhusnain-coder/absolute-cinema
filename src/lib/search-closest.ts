import { tmdb } from "@/lib/tmdb";
import { cachedFetch } from "@/lib/server-cache";
import { closestMatches, queryVariants } from "@/lib/search-fuzzy";

/** One search row: a film, a show or a person, as TMDB returns it. */
export type SearchRow = { id: number; media_type?: string; title?: string; name?: string; popularity?: number } & Record<string, unknown>;

/** Pages of each list read for the well-known titles (20 titles a page). */
const WELL_KNOWN_PAGES = 8;
const WELL_KNOWN_TTL_MS = 24 * 60 * 60 * 1000;
/** Close matches offered for one search. */
const MAX_CLOSEST = 20;

type Listing = (page: number) => Promise<{ results?: unknown[] }>;

async function listRows(list: Listing, mediaType: "movie" | "tv"): Promise<SearchRow[]> {
  const pages = await Promise.allSettled(Array.from({ length: WELL_KNOWN_PAGES }, (_, i) => list(i + 1)));
  return pages.flatMap((page) =>
    page.status === "fulfilled" ? ((page.value.results ?? []) as SearchRow[]).map((row) => ({ ...row, media_type: mediaType })) : []
  );
}

/**
 * The films and shows most people look for: the popular and top-rated lists.
 * A misspelling anywhere in one of these titles can be matched against the
 * list itself, where TMDB's own search only forgives the end of a word.
 */
function wellKnownTitles(): Promise<SearchRow[]> {
  return cachedFetch(
    "search:well-known-titles",
    async () => {
      const lists = await Promise.all([
        listRows(tmdb.popularMovies, "movie"),
        listRows(tmdb.topRatedMovies, "movie"),
        listRows(tmdb.popularTv, "tv"),
        listRows(tmdb.topRatedTv, "tv"),
      ]);
      return lists.flat();
    },
    WELL_KNOWN_TTL_MS
  );
}

async function variantRows(query: string): Promise<SearchRow[]> {
  const found = await Promise.allSettled(queryVariants(query).map((variant) => tmdb.searchMulti(variant, 1)));
  return found.flatMap((result) => (result.status === "fulfilled" ? ((result.value.results ?? []) as unknown as SearchRow[]) : []));
}

/**
 * Titles close to a query that found little or nothing as typed, closest
 * first. Empty when nothing is close: a search for nonsense stays empty.
 */
export async function closestSearch(query: string): Promise<SearchRow[]> {
  const [variants, wellKnown] = await Promise.all([variantRows(query), wellKnownTitles().catch(() => [] as SearchRow[])]);
  return closestMatches(query, [...variants, ...wellKnown]).slice(0, MAX_CLOSEST);
}

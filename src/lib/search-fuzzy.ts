/**
 * Search that forgives a misspelling.
 *
 * TMDB matches whole words, and the start of the last one. "intersteller"
 * finds nothing, though "interstell" finds the film at once. So when a search
 * comes back empty, the query is asked again in looser forms (the last word
 * cut short, one word left out, two words joined), and whatever those find is
 * ranked by how close its title is to what was typed. Only close titles are
 * kept: a search for nonsense still finds nothing.
 */

/** A search with fewer results than this is topped up with close matches. */
export const FEW_RESULTS = 3;
/** No more looser forms than this are tried for one search. */
const MAX_VARIANTS = 6;
/** A word is never cut shorter than this: two letters match half the catalogue. */
const MIN_PREFIX = 3;
/** How alike a title must be to what was typed (0 to 1) to be offered as a close match. */
export const CLOSE_ENOUGH = 0.72;
/** A title word that begins with a typed word counts as this good a match for it. */
const PREFIX_MATCH = 0.9;
/** Leading articles say nothing about which title was meant. */
const ARTICLES: ReadonlySet<string> = new Set(["the", "a", "an"]);

/** Lower case, accents and punctuation removed, as a list of words. */
export function searchWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The looser forms of a query to try, most promising first. */
export function queryVariants(query: string): string[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const variants: string[] = [];
  const last = words[words.length - 1]!;
  const head = words.slice(0, -1);
  // The last word cut short: TMDB completes it. Errors gather at the end of a word.
  for (const cut of [1, 2, Math.floor(last.length / 2)]) {
    const prefix = last.slice(0, last.length - cut);
    if (cut > 0 && prefix.length >= MIN_PREFIX) variants.push([...head, prefix].join(" "));
  }
  // One word left out: the others find the title, and ranking brings it back.
  if (words.length > 1) {
    for (let skip = 0; skip < words.length; skip++) variants.push(words.filter((_, i) => i !== skip).join(" "));
  }
  // Two words that should have been one ("spider man" is fine, "inter stellar" is not).
  if (words.length === 2) variants.push(words.join(""));
  const typed = words.join(" ");
  return [...new Set(variants)].filter((variant) => variant !== typed && variant.length >= MIN_PREFIX).slice(0, MAX_VARIANTS);
}

/** Edits (insert, delete, replace, swap two neighbours) that turn one word into the other. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      const swapped = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
      if (swapped) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

function wordSimilarity(typed: string, word: string): number {
  if (typed === word) return 1;
  const alike = 1 - editDistance(typed, word) / Math.max(typed.length, word.length);
  return typed.length >= MIN_PREFIX && word.startsWith(typed) ? Math.max(alike, PREFIX_MATCH) : alike;
}

/** The words that identify a title: all of them, less a leading article. */
function meaningful(words: string[]): string[] {
  return words.length > 1 && ARTICLES.has(words[0]!) ? words.slice(1) : words;
}

/**
 * How close a title is to what was typed, 0 to 1: each typed word is matched
 * to the title word most like it, and the matches are averaged. A title's
 * extra words cost nothing, so "avangers" is close to "Avengers: Endgame".
 */
export function titleSimilarity(query: string, title: string): number {
  const typed = meaningful(searchWords(query));
  const words = searchWords(title);
  if (typed.length === 0 || words.length === 0) return 0;
  const joined = words.join("");
  const scores = typed.map((word) => Math.max(wordSimilarity(word, joined), ...words.map((candidate) => wordSimilarity(word, candidate))));
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

interface Titled {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  popularity?: number;
}

function bestSimilarity(query: string, row: Titled): number {
  const names = [row.title, row.name, row.original_title, row.original_name].filter((name): name is string => Boolean(name));
  return Math.max(0, ...names.map((name) => titleSimilarity(query, name)));
}

/**
 * The rows close enough to the query to be offered, closest first (the more
 * popular first among equals), each appearing once.
 */
export function closestMatches<T extends Titled>(query: string, rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const scored: Array<{ row: T; score: number }> = [];
  for (const row of rows) {
    const key = `${row.media_type ?? "movie"}-${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const score = bestSimilarity(query, row);
    if (score >= CLOSE_ENOUGH) scored.push({ row, score });
  }
  return scored.sort((a, b) => b.score - a.score || (b.row.popularity ?? 0) - (a.row.popularity ?? 0)).map((entry) => entry.row);
}

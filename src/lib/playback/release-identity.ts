/**
 * Is this release the title that was asked for?
 *
 * The torrent index is searched by IMDb id, and what it files under an id is
 * not always that film: a namesake from another year, a sequel that shares
 * its first word, a series episode under a film of the same name. Nothing
 * checked, so whichever ranked best on size and seeders was played under the
 * wrong poster. A release is now judged on the two things its name always
 * carries, the title and the year, against every name the title goes by.
 */

import type { MediaType } from "./types";

export interface TitleFacts {
  /** Every name the title goes by: its own, its original-language one, and others it is known under. */
  titles: readonly string[];
  /** The year it came out (a film) or first aired (a series). */
  year: number | null;
}

/** "unknown" is a name with no title in it to judge (a bare hash, a script the comparison cannot read). */
export type ReleaseVerdict = "match" | "mismatch" | "unknown";

/** A film's release may carry the year before or after its own (festival, then cinema; one country, then another). */
const YEAR_TOLERANCE = 1;

const YEAR = /(?<![a-z0-9])(19\d{2}|20\d{2})(?![a-z0-9])/g;
/** Where the technical part of a release name begins, once its year has been passed. */
const TECHNICAL =
  /(?<![a-z0-9])(?:2160p|1440p|1080[pi]|720p|576p|480p|4k|uhd|bluray|blu ray|bdrip|brrip|bdremux|remux|web|webrip|webdl|hdtv|hdrip|dvdrip|dvd|hdcam|x264|x265|h264|h265|h 264|h 265|hevc|avc|av1|xvid|divx|hdr|hdr10|dolby|atmos|10bit|8bit|imax)(?![a-z0-9])/;
/** The same for a name with no year, where a word like "web" may still be part of the title. */
const TECHNICAL_UNMISTAKABLE =
  /(?<![a-z0-9])(?:2160p|1440p|1080[pi]|720p|576p|480p|4k|uhd|bluray|blu ray|bdrip|brrip|bdremux|remux|webrip|webdl|web dl|hdtv|hdrip|dvdrip|hdcam|x264|x265|h264|h265|h 264|h 265|hevc|xvid|divx|10bit|ddp|dts|aac|ac3|mkv|mp4|avi)(?![a-z0-9])/;
/** Where a series release starts counting seasons and episodes. */
const SEASON =
  /(?<![a-z0-9])(?:s\d{1,2}(?:\s?e\d{1,3})?(?:\s?-\s?(?:s|e)?\d{1,3})?|seasons?\s?\d{1,2}(?:\s?(?:-|to|and)\s?\d{1,2})?|complete series|\d{1,2}x\d{2,3})(?![a-z0-9])/;
const EPISODE_TAG = /(?<![a-z0-9])s\d{1,2}\s?e\d{1,3}(?![a-z0-9])/;
/** A site or group stamped in front of the name. */
const LEADING_STAMP = /^(?:\s*(?:\[[^\]]*\]|www\.[a-z0-9.-]+|[a-z0-9-]+\.(?:org|com|net|to|cc|ws|me|is|eu|tv|bz)(?![a-z0-9.]))\s*[-|:]*\s*)+/i;
/** Two names for one release: a tracker's own language first, then the original. */
const NAME_SEPARATOR = /\s+(?:\/|\||aka)\s+/i;

/**
 * Words a release adds to a title that say which cut or copy it is, not which
 * film: "Dune 2021 IMAX" is Dune. Anything else left over ("Part Two",
 * "Jackson The Verdict") is another title.
 */
const EDITION_WORDS = new Set([
  "the", "a", "an", "uhd", "imax", "extended", "unrated", "uncut", "remastered", "restored", "directors", "director",
  "cut", "edition", "theatrical", "final", "special", "collectors", "anniversary", "proper", "repack", "limited",
  "internal", "redux", "open", "matte", "criterion", "hybrid", "dual", "audio", "multi", "complete", "series",
  "season", "version", "dc", "se", "3d", "4k", "hd",
]);
/** More of the same that only a series release uses: a whole run is still the show. */
const SERIES_WORDS = new Set([
  "tv", "trilogy", "integrale", "integral", "collection", "extras", "seasons", "saison", "saisons", "temporada",
  "temporadas", "stagione", "stagioni", "staffel", "completa", "anthology", "pack", "episodes", "show", "full",
  "specials", "uncensored", "mini", "miniseries",
]);
/** A release under another name is kept only if at least this share of a title's words are in it. */
const RELATED_SHARE = 0.5;
/** With no year to vouch for it, this share of the release's own words must be the title's as well. */
const RELATED_SHARE_UNDATED = 0.7;
/** Left over beside a title's words, these make it the next film, not a version of this one. */
const SEQUEL_WORDS = new Set(["2", "3", "4", "5", "6", "7", "8", "9", "ii", "iii", "iv", "vi", "vii", "viii", "part", "parte", "partie", "teil", "chapter", "vol", "volume"]);
/** Words this long may differ by a letter and still be the same word ("Ted Laso", "Parasites"). */
const FUZZY_MIN_LENGTH = 5;

/** Lower case, unaccented, punctuation to spaces: "Léon: The Professional" and "Leon.The.Professional" agree. */
export function normalizeTitle(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface ReleaseName {
  /** Normalized title, as far as the name states one. */
  title: string;
  /** The release year the name gives, if it gives one. */
  year: number | null;
  /** The name is of one episode or of seasons. */
  episodic: boolean;
}

/** Reads the title and year out of one release name. */
export function parseReleaseName(raw: string, mediaType: MediaType = "movie"): ReleaseName {
  const text = normalizeTitle(raw.replace(LEADING_STAMP, ""));
  const season = text.search(SEASON);
  // A year at the very start is part of the title ("2001 A Space Odyssey", "1917").
  const firstYear = [...text.matchAll(YEAR)].find((match) => match.index > 0);
  // After its year a name is technical; before one, only words no title uses end it.
  const from = firstYear ? firstYear.index : 0;
  const technicalAt = text.slice(from).search(firstYear ? TECHNICAL : TECHNICAL_UNMISTAKABLE);
  const ends = [technicalAt >= 0 ? from + technicalAt : -1, mediaType === "tv" ? season : -1].filter((index) => index >= 0);
  const head = ends.length ? text.slice(0, Math.min(...ends)) : text;
  // The year is the last one before the technical part: "Blade Runner 2049 2017".
  const years = [...head.matchAll(YEAR)].filter((match) => match.index > 0);
  const last = years[years.length - 1];
  return {
    title: (last ? head.slice(0, last.index) : head).trim(),
    year: last ? Number(last[1]) : null,
    episodic: season >= 0,
  };
}

function isEditionWord(word: string, mediaType: MediaType): boolean {
  return EDITION_WORDS.has(word) || (mediaType === "tv" && SERIES_WORDS.has(word));
}

/**
 * What is left of a release's title once a wanted title's words are taken
 * out of it; null when the wanted title is not all there.
 */
function leftover(release: string, wanted: string, mediaType: MediaType): string[] | null {
  const remaining = release.split(" ");
  for (const word of wanted.split(" ")) {
    const at = remaining.indexOf(word);
    if (at >= 0) remaining.splice(at, 1);
    else if (!isEditionWord(word, mediaType)) return null;
  }
  return remaining.filter((word) => !isEditionWord(word, mediaType));
}

/** The release's title is this one, give or take edition words. */
function sameTitle(release: string, wanted: string, mediaType: MediaType): boolean {
  if (!release || !wanted) return false;
  // Spacing is the release's own: "Spiderman" is "Spider-Man", "d Amelie" is "d'Amélie".
  if (release.replace(/ /g, "") === wanted.replace(/ /g, "")) return true;
  return leftover(release, wanted, mediaType)?.length === 0;
}

/** One letter apart at most. */
function nearlyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < FUZZY_MIN_LENGTH || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(longer.length === shorter.length ? i + 1 : i);
}

/**
 * Enough of some wanted title's words are in the release's for it to be a
 * version of the same name. A name with a fitting year needs half of the
 * title; one with no year must also be mostly the title itself, or "Michael
 * Jackson Live in Bucharest" would pass for "Michael".
 */
function isRelated(release: string, wanted: readonly string[], mediaType: MediaType, dated: boolean): boolean {
  const have = release.split(" ").filter((word) => !isEditionWord(word, mediaType));
  return wanted.some((title) => {
    const want = title.split(" ").filter((word) => !isEditionWord(word, mediaType));
    if (!want.length || !have.length) return false;
    const shared = want.filter((word) => have.some((other) => nearlyEqual(word, other))).length;
    if (shared / want.length < RELATED_SHARE) return false;
    const extra = have.filter((word) => !want.some((other) => nearlyEqual(word, other)));
    if (extra.some((word) => SEQUEL_WORDS.has(word))) return false;
    return dated ? shared / Math.min(want.length, have.length) >= RELATED_SHARE : shared / have.length >= RELATED_SHARE_UNDATED;
  });
}

/** The wanted title a release's own matches, if any. */
function matchedTitle(name: ReleaseName, wanted: readonly string[], mediaType: MediaType): string | null {
  for (const title of wanted) {
    if (sameTitle(name.title, title, mediaType)) return title;
    // A year that belongs to the title: "Wonder Woman 1984", released without its own.
    if (name.year !== null && sameTitle(`${name.title} ${name.year}`, title, mediaType)) return title;
    // An episode number left in the title of a series release without season tags ("Show - 47").
    if (mediaType === "tv" && sameTitle(name.title.replace(/(?:\s\d{1,4})+$/, ""), title, mediaType)) return title;
  }
  // Two of its names side by side: "Money Heist (La Casa de Papel)", "Nunca te sueltes (Never Let Go)".
  for (const title of wanted) {
    const rest = leftover(name.title, title, mediaType);
    if (rest?.length && wanted.some((other) => other !== title && sameTitle(rest.join(" "), other, mediaType))) return title;
  }
  return null;
}

/** Whether the year a release gives fits the title's; null when it gives none. */
function yearFits(year: number | null, facts: TitleFacts, mediaType: MediaType): boolean | null {
  if (year === null || facts.year === null) return null;
  // A series is named for the year it began; later seasons often carry their own.
  if (mediaType === "tv") return year >= facts.year - YEAR_TOLERANCE;
  return Math.abs(year - facts.year) <= YEAR_TOLERANCE;
}

/**
 * Judges one release name against the title that was asked for.
 *
 *   match     its title is one of the title's names, and its year (if it gives one) fits
 *   mismatch  its year is another film's, or its title is another's
 *   unknown   the right year under a variation of one of the title's names
 *             ("Marvel's The Avengers", "Batman: The Dark Knight"), or nothing
 *             readable at all
 */
export function judgeRelease(releaseName: string, facts: TitleFacts, mediaType: MediaType): ReleaseVerdict {
  const wanted = facts.titles.map(normalizeTitle).filter(Boolean);
  if (!wanted.length) return "unknown";
  const firstLine = releaseName.split("\n")[0] ?? "";
  if (mediaType === "movie" && EPISODE_TAG.test(normalizeTitle(firstLine))) return "mismatch";
  // A name can be given twice (a tracker's own language, then the original): the best reading of it stands.
  let verdict: ReleaseVerdict | null = null;
  for (const part of firstLine.split(NAME_SEPARATOR)) {
    const name = parseReleaseName(part, mediaType);
    if (!name.title) continue;
    const title = matchedTitle(name, wanted, mediaType);
    if (title !== null) {
      // The year is not a date when it is one of the title's own words.
      const dated = name.year !== null && !title.split(" ").includes(String(name.year));
      if (!dated || yearFits(name.year, facts, mediaType) !== false) return "match";
      verdict ??= "mismatch";
      continue;
    }
    // Another name: it has to be a version of one of the title's names, and not from another year.
    const year = yearFits(name.year, facts, mediaType);
    const vouched = year !== false && isRelated(name.title, wanted, mediaType, year === true);
    if (vouched) verdict = "unknown";
    else verdict ??= "mismatch";
  }
  return verdict ?? "unknown";
}

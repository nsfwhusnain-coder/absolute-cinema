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
  /** Every name the title goes by, its own first: then its original-language one, and others it is known under. */
  titles: readonly string[];
  /** The year it came out (a film) or first aired (a series). */
  year: number | null;
  /** The year each season of a series first aired, by season number. */
  seasonYears?: Readonly<Record<number, number>>;
  /** The name of each season that has one of its own ("Dressrosa", "Thousand-Year Blood War"), by season number. */
  seasonNames?: Readonly<Record<number, string>>;
  /** Anime: its run is cut into seasons differently from one catalogue to the next, so a season's number on a file is not this catalogue's. */
  anime?: boolean;
}

/** "unknown" is a name with no title in it to judge (a bare hash), or the right year under a variation of the title's name. */
export type ReleaseVerdict = "match" | "mismatch" | "unknown";

export interface ReleaseJudgement {
  verdict: ReleaseVerdict;
  /** An "unknown" that is a variation of the title's name, not a name with nothing in it to read. */
  related: boolean;
  /** The name says outright that it is something else: another year's film, a later part, an episode. */
  contradicts: boolean;
  /** It says so by its year: a namesake, not another part of the same thing. */
  anotherYear: boolean;
}

/** A film's release may carry the year before or after its own (festival, then cinema; one country, then another). */
const YEAR_TOLERANCE = 1;

const YEAR = /(?<![\p{L}\p{N}])(19\d{2}|20\d{2})(?![\p{L}\p{N}])/gu;
/** Where the technical part of a release name begins, once its year has been passed. */
const TECHNICAL =
  /(?<![\p{L}\p{N}])(?:2160p|1440p|1080[pi]|720p|576p|480p|\d{3,4}x\d{3,4}[pi]?|4k|uhd|bluray|blu ray|bdrip|brrip|bdremux|remux|web|webrip|webdl|hdtv|hdrip|dvdrip|dvd|hdcam|telesync|x264|x265|h264|h265|h 264|h 265|hevc|avc|av1|xvid|divx|hdr|hdr10|dolby|atmos|10bit|8bit|imax)(?![\p{L}\p{N}])/u;
/** The same for any part of a name, where a word like "web" may still be part of the title. */
const TECHNICAL_UNMISTAKABLE =
  /(?<![\p{L}\p{N}])(?:2160p|1440p|1080[pi]|720p|576p|480p|\d{3,4}x\d{3,4}[pi]?|4k|uhd|bluray|blu ray|bdrip|brrip|bdremux|remux|webrip|webdl|web dl|web dlrip|hdtv|hdrip|dvdrip|hdcam|telesync|x264|x265|h264|h265|h 264|h 265|hevc|xvid|divx|10bit|10 bit|ddp|dts|aac|ac3|mkv|mp4|avi)(?![\p{L}\p{N}])/u;
/** Where a series release starts counting seasons and episodes. */
const SEASON =
  /(?<![\p{L}\p{N}])(?:s\d{1,2}(?:p\d{1,2})?(?:\s?ep?\d{1,3}(?:v\d)?)?(?:\s?-\s?(?:s|e)?\d{1,3})?|(?:seasons?|saisons?|temporadas?|stagion[ei]|staffel|sezon)\s?\d{1,2}(?:\s?(?:-|to|and)\s?\d{1,2})?|\d{1,2}(?:a|o|e|er|re|eme|st|nd|rd|th)\s(?:seasons?|saisons?|temporadas?|stagion[ei]|staffel)|complete series|\d{1,2}x\d{2,3})(?![\p{L}\p{N}])/u;
const EPISODE_TAG = /(?<![\p{L}\p{N}])s\d{1,2}\s?ep?\d{1,3}(?:v\d)?(?![\p{L}\p{N}])/u;
/** A site or group stamped in front of the name. */
const LEADING_STAMP = /^(?:\s*(?:\[[^\]]*\]|www\.[a-z0-9.-]+|[a-z0-9-]+\.(?:org|com|net|to|cc|ws|me|is|eu|tv|bz)(?![a-z0-9.]))[\s_]*[-|:]*[\s_]*)+/i;
const FILE_EXTENSION = /\.(?:mkv|mp4|m4v|avi|webm|mov|wmv|ts)$/i;
/** After a name has begun, a square bracket opens its tags ("[BD 1080p]", "[Dual-Audio]"), never more of the title. */
const TAG_BRACKET = /[[【『]/;
/** A title that itself opens with a bracket, which is otherwise a group's stamp: "[REC] 2 (2009)". */
const OPENING_BRACKET = /^\s*\[([^\]]*)\]/;
/** A name written as tags from end to end, the title among them: "[Group][Title/Its Other Name][2021][1080P]". */
const ALL_BRACKETS = /^\s*(?:\[[^\]]*\]\s*){2,}(?:\.[a-z0-9]{2,4})?\s*$/i;
const BRACKET_GROUP = /\[([^\]]*)\]/g;
/** Two names for one release: a tracker's own language first, then the original. */
const NAME_SEPARATOR = /\s+(?:\/|\||aka)\s+|[\s.]a\.k\.a\.?[\s.]|\uff0f/i;
/** How many of a title's names one release is read as giving in a row. */
const NAMES_SIDE_BY_SIDE = 3;
/**
 * A release of several seasons, or of the whole run. It may carry the year
 * it was put together, long after the season asked for first aired.
 */
const RUN_OF_SEASONS =
  /(?<![\p{L}\p{N}])(?:s\d{1,2}\s?s?\d{1,2}|seasons?\s?\d{1,2}\s?(?:to|and)?\s?\d{1,2}|complete|collection|integrale?|completa|anthology)(?![\p{L}\p{N}])/u;
/**
 * A series name counting an episode and then going on in words: what follows
 * is the episode's own title, and a year in it is not the release's date
 * ("Episode 01 - To You, in 2000 Years").
 */
const EPISODE_THEN_TITLE = /(?<![\p{L}\p{N}])(?:(?:e|ep|episode|chapter) ?\d{1,4}|0\d{1,3})(?:v\d)?(?![\p{L}\p{N}]) +\p{L}/u;
/** What may stand between a season tag and the year a series release is dated by: more of the tag. */
const SEASON_TAG_WORD = /^(?:s\d{1,2}(?:ep?\d{1,3}(?:v\d)?)?|ep?\d{1,4}|\d{1,4}|seasons?|saisons?|temporadas?|stagion[ei]|staffel|sezon|to|and)$/;
/** A year the name opens with, when it is the release's date and not the title's first word ("2010.Inception.1920x800"). */
const LEADING_YEAR = /^(19\d{2}|20\d{2})[a-z]? (.+)$/;
/** A place in a list, in front of a name ("3. My Neighbor Totoro (1988)", "M22 Avengers Endgame (2019)"). */
const LEADING_INDEX = /^[a-z]{0,4}\d{1,3}[a-z]? (?=\D)/;
/** A genre one uploader files its films under, between the title and the year: "Vacation - Comedy 2015". */
const GENRE_BEFORE_YEAR =
  /\s+-\s+(?:(?:action|adventure|animation|anime|biography|comedy|crime|documentary|drama|family|fantasy|history|horror|musical|mystery|romance|sci-?fi|thriller|war|western)\s+){1,3}(?=\(?(?:19|20)\d{2}(?!\d))/i;
/** A round bracket opens tags too, when what it holds is technical: "(BD 1080p HEVC)". One holding a name or a year is the title's. */
const ROUND_BRACKET = /\(([^()]*)/g;
const TRAILING_YEAR = /^(.+) (19\d{2}|20\d{2})$/;
/** An episode counted through a whole run, the way anime is: "47", "0001", "EP12", "01v2". */
const EPISODE_NUMBER = /^(?:e|ep|episode)?\d{1,4}(?:v\d)?$/;
/** An episode's number written the way a counter is, not the way a title ends ("Area 51"): padded, prefixed, or in the hundreds. */
const WRITTEN_AS_COUNTER = /^(?:(?:e|ep|episode)\d{1,4}|0\d{1,3}|\d{3,4})(?:v\d)?$/;
/** Numbers that are a date or a picture height wherever they stand, never an episode. */
const NOT_AN_EPISODE = /^(?:19\d{2}|20\d{2}|2160|1080|720|576|480)$/;
const EPISODE_WORDS = new Set(["e", "ep", "episode", "episodio", "folge"]);
/** How many numbers in a series name are tried as the place its title ends. */
const EPISODE_NUMBERS_TRIED = 3;
const NON_LATIN = /[^\x00-\x7f]/;
/** Letters that are one of these with a stroke or a missing dot, which unaccenting does not undo: "Alıkara", "Jagten på". */
const PLAIN_LETTERS: Record<string, string> = { ı: "i", ł: "l", ø: "o", đ: "d", ß: "ss", æ: "ae", œ: "oe" };

/**
 * Words a release adds to a title that say which cut or copy it is, not which
 * film: "Dune 2021 IMAX" is Dune. Anything else left over ("Part Two",
 * "Jackson The Verdict") is another title.
 */
const EDITION_WORDS = new Set([
  "the", "a", "an", "uhd", "imax", "extended", "unrated", "uncut", "remastered", "remaster", "restored", "directors",
  "director", "cut", "edition", "theatrical", "final", "special", "collectors", "anniversary", "proper", "repack",
  "limited", "internal", "redux", "open", "matte", "criterion", "hybrid", "dual", "audio", "multi", "complete",
  "series", "season", "version", "dc", "se", "3d", "4k", "hd", "ext", "editions",
]);
/** What a film's release calls itself beside its name; on a series' release it is the film of the show, another title. */
const FILM_WORDS = new Set(["movie", "film"]);
/** Which anniversary an edition marks: "30th". */
const ORDINAL = /^\d{1,3}(?:st|nd|rd|th)$/;
/** More of the same that only a series release uses: a whole run is still the show. */
const SERIES_WORDS = new Set([
  "tv", "trilogy", "integrale", "integral", "collection", "extras", "seasons", "saison", "saisons", "temporada",
  "temporadas", "stagione", "stagioni", "staffel", "completa", "anthology", "pack", "episodes", "show", "full",
  "specials", "uncensored", "mini", "miniseries", "batch", "box", "boxset",
]);
/**
 * What a release says of its copy before the part that is plainly technical
 * begins ("Your Name (BD 1080p)", "Resident Evil 1080.mkv"). None is a word
 * a title is told from another by.
 */
const TAG_WORDS = new Set([
  "bd", "bdrip", "brrip", "bluray", "dvd", "dvdrip", "webrip", "webdl", "hdtv", "hdrip", "hdr", "hdr10", "sdr",
  "remux", "bdremux", "uhdrip", "jpbd", "dcp", "dcprip", "hevc", "avc", "x264", "x265", "h264", "h265", "av1", "aac",
  "ac3", "dts", "flac", "opus", "10bit", "8bit", "2160", "1080", "720", "480", "dubbed", "subbed", "subs", "multisub",
  "multisubs", "vostfr", "dublado", "legendado", "doblado", "subtitulado", "truefrench", "hdlight",
]);
/**
 * The language of a copy. Only after a title's last word: in front of one it
 * is the title's own ("The English Teacher" is not "Teacher").
 */
const LANGUAGE_WORDS = new Set([
  "english", "eng", "french", "vf", "vff", "german", "deutsch", "ger", "italian", "ita", "spanish", "espanol", "esp",
  "castellano", "latino", "lat", "japanese", "jap", "jpn", "korean", "kor", "hindi", "russian", "rus", "polish",
  "dutch", "portuguese", "dub", "sub",
]);
/** A revision of the same release: "v2". */
const REVISION = /^v\d$/;
/** The part of a season a series release holds: "P01". */
const SEASON_PART = /^p\d{1,2}$/;
/** A release under another name is kept only if at least this share of a title's words are in it. */
const RELATED_SHARE = 0.5;
/** With no year to vouch for it, this share of the release's own words must be the title's as well. */
const RELATED_SHARE_UNDATED = 0.7;
/** Left over beside a title's words, these make it the next film, not a version of this one. */
const SEQUEL_NUMBERS = new Set(["2", "3", "4", "5", "6", "7", "8", "9", "ii", "iii", "iv", "vi", "vii", "viii"]);
const PART_WORDS = new Set(["part", "parte", "partie", "teil", "chapter", "vol", "volume"]);
/** After a title, or after "Part", these name the first film, which is the one with no number. */
const FIRST_NUMBERS = new Set(["1", "i", "one"]);
/** "Movie 01" is the first film of several; a bare "01" after a title is an episode. */
const FIRST_FILM = /(?:^| )(?:movie|film) 0?1(?: |$)/;
/** After a film's title, the number of an episode: the series of the same name. */
const COUNTED_EPISODE = /^(?:(?:e|ep)\d{1,4}|0\d{1,3}|\d{1,4}v\d)$/;
/** The most episodes one file is taken to span ("01-02"). */
const EPISODE_SPAN_MAX = 3;
/** A word may differ by a letter from one this long and still be the same word ("Ted Laso", "Parasites"). */
const FUZZY_MIN_LENGTH = 5;

/** Lower case, unaccented, punctuation to spaces: "Léon: The Professional" and "Leon.The.Professional" agree. Every script is kept. */
export function normalizeTitle(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ıłøđßæœ]/g, (letter) => PLAIN_LETTERS[letter] ?? letter)
    .replace(/&/g, " and ")
    .replace(/['’`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface ReleaseName {
  /** Normalized title, as far as the name states one. */
  title: string;
  /** The release year the name gives, if it gives one. */
  year: number | null;
  /** The name is of one episode or of seasons. */
  episodic: boolean;
  /** The name is of several seasons at once. */
  run: boolean;
  /** What a film's name goes on to say between its year and its technical part: the rest of a title written round its year. */
  after: string;
}

/** The years in a normalized name. One at the very start is part of the title ("2001 A Space Odyssey", "1917"). */
function yearsIn(text: string): RegExpMatchArray[] {
  return [...text.matchAll(YEAR)].filter((match) => (match.index ?? 0) > 0);
}

/** A name, and the tags that follow it in brackets. */
function splitAtTags(name: string): { named: string; tags: string } {
  const square = name.slice(1).search(TAG_BRACKET) + 1;
  const round = [...name.matchAll(ROUND_BRACKET)].find((group) => (group.index ?? 0) > 0 && TECHNICAL_UNMISTAKABLE.test(normalizeTitle(group[1] ?? "")));
  const starts = [square, round?.index ?? 0].filter((index) => index > 0);
  const at = starts.length ? Math.min(...starts) : 0;
  return at > 0 ? { named: name.slice(0, at), tags: name.slice(at) } : { named: name, tags: "" };
}

/** Where the title's part of a normalized name ends: at its seasons, or where it turns technical. */
function titleEnd(text: string, mediaType: MediaType): number {
  const firstYear = yearsIn(text)[0];
  // After its year a name is technical; before one, only words no title uses end it.
  const afterYear = firstYear ? text.slice(firstYear.index).search(TECHNICAL) : -1;
  const ends = [
    text.search(TECHNICAL_UNMISTAKABLE),
    afterYear >= 0 ? (firstYear?.index ?? 0) + afterYear : -1,
    mediaType === "tv" ? text.search(SEASON) : -1,
  ].filter((index) => index >= 0);
  return ends.length ? Math.min(...ends) : text.length;
}

/** Reads the title and year out of one release name. */
export function parseReleaseName(raw: string, mediaType: MediaType = "movie"): ReleaseName {
  const { named, tags } = splitAtTags(raw.replace(LEADING_STAMP, "").replace(FILE_EXTENSION, "").replace(GENRE_BEFORE_YEAR, " "));
  const text = normalizeTitle(named);
  const end = titleEnd(text, mediaType);
  const head = text.slice(0, end);
  const rest = `${text.slice(end)} ${normalizeTitle(tags)}`;
  // The year is the last one before the technical part: "Blade Runner 2049 2017".
  const last = statedYear(yearsIn(head), head, mediaType);
  // With none there, the first one after it: "Inception [2010 BDRemux]", "Animals.WEB-DL.2026.1080p".
  const later = last ? undefined : laterYear(head, rest, mediaType);
  return {
    title: (last ? head.slice(0, last.index) : head).trim(),
    year: last ? Number(last[1]) : later ? Number(later[1]) : null,
    episodic: SEASON.test(text) || SEASON.test(rest),
    run: RUN_OF_SEASONS.test(text) || RUN_OF_SEASONS.test(rest),
    after: last && mediaType === "movie" ? head.slice((last.index ?? 0) + last[0].length).trim() : "",
  };
}

/**
 * The year a name is dated by, of the years in it. A series' run is given as
 * the years it spans ("2019-2020") and dated by the first; a film with two
 * years is a film whose title ends in one.
 */
function statedYear(years: RegExpMatchArray[], head: string, mediaType: MediaType): RegExpMatchArray | undefined {
  const last = years[years.length - 1];
  if (mediaType !== "tv" || !last) return last;
  if (EPISODE_THEN_TITLE.test(head.slice(0, last.index))) return undefined;
  const before = years[years.length - 2];
  const span = before && (before.index ?? 0) + before[0].length + 1 === last.index && Number(before[1]) < Number(last[1]);
  return span ? before : last;
}

/**
 * The year a name gives after its title's part. A series' comes straight
 * after its season tag ("S01E01 2023 2160p"): past an episode's own title it
 * is a word of that title ("S01E01 To You in 2016").
 */
function laterYear(head: string, rest: string, mediaType: MediaType): RegExpMatchArray | undefined {
  const year = yearsIn(` ${rest}`)[0];
  if (mediaType !== "tv" || !year) return year;
  if (EPISODE_THEN_TITLE.test(head)) return undefined;
  const between = ` ${rest}`.slice(0, year.index).split(" ");
  return between.every((word) => !word || SEASON_TAG_WORD.test(word) || isCopyWord(word, mediaType)) ? year : undefined;
}

interface NameReading extends ReleaseName {
  /** A second guess at how the name is laid out: it can find the title, but its not finding it says nothing. */
  guess: boolean;
}

/**
 * Every way one name can be read: as written, with a year it opens with taken
 * as its date, with its title taken as written round its year ("Top Gun
 * (2022) Maverick"), and with a bracket it opens with taken as the start of
 * its title.
 */
function readings(raw: string, mediaType: MediaType): NameReading[] {
  const written = parseReleaseName(raw, mediaType);
  const all: NameReading[] = [{ ...written, guess: false }];
  const led = written.year === null ? written.title.match(LEADING_YEAR) : null;
  if (led) all.push({ ...written, title: led[2] ?? "", year: Number(led[1]), guess: false });
  if (written.after) all.push({ ...written, title: `${written.title} ${written.after}`, after: "", guess: false });
  // The same with a year for the rest of the title: "Blade Runner (2017) 2049".
  const turned = written.year !== null && mediaType === "movie" ? written.title.match(TRAILING_YEAR) : null;
  if (turned) all.push({ ...written, title: `${turned[1]} ${written.year}`, year: Number(turned[2]), guess: true });
  if (OPENING_BRACKET.test(raw)) all.push({ ...parseReleaseName(raw.replace(OPENING_BRACKET, "$1 "), mediaType), guess: true });
  return all;
}

/** The names one line gives: one, or two either side of a separator, or each tag of a name that is all tags. */
function namesIn(line: string): string[] {
  if (!ALL_BRACKETS.test(line)) return line.split(NAME_SEPARATOR);
  // The first tag is the group's.
  return [...line.matchAll(BRACKET_GROUP)].slice(1).flatMap((group) => (group[1] ?? "").split("/"));
}

/** A word that says which copy a release is, not which title. */
function isCopyWord(word: string, mediaType: MediaType): boolean {
  if (EDITION_WORDS.has(word) || TAG_WORDS.has(word) || REVISION.test(word) || ORDINAL.test(word)) return true;
  return mediaType === "tv" ? SERIES_WORDS.has(word) || SEASON_PART.test(word) : FILM_WORDS.has(word);
}

/** A title's words without the ones any copy of it may add. */
function titleWords(title: string, mediaType: MediaType): string[] {
  return title.split(" ").filter((word) => word && !isCopyWord(word, mediaType));
}

/**
 * What is left of a release's title once a wanted title's words are taken
 * out of it; null when the wanted title is not all there. Words in another
 * script beside a title in Latin letters are that title again, translated.
 */
function leftover(release: string, wanted: string, mediaType: MediaType): string[] | null {
  const words = release.split(" ");
  const taken = new Set<number>();
  for (const word of wanted.split(" ")) {
    const at = words.findIndex((other, index) => other === word && !taken.has(index));
    if (at >= 0) taken.add(at);
    else if (!isCopyWord(word, mediaType)) return null;
  }
  const last = Math.max(-1, ...taken);
  const latin = !NON_LATIN.test(wanted);
  const says = (word: string, index: number) =>
    !isCopyWord(word, mediaType) && !(latin && NON_LATIN.test(word)) && !(index > last && LANGUAGE_WORDS.has(word));
  return words.filter((word, index) => !taken.has(index) && says(word, index));
}

/** Whether what a release adds to a title numbers it as a later part: "2", "Part Two", but not "Part 1". */
function numbersALaterPart(extra: readonly string[]): boolean {
  return extra.some((word, index) => SEQUEL_NUMBERS.has(word) || (PART_WORDS.has(word) && !FIRST_NUMBERS.has(extra[index + 1] ?? "")));
}

/** Whether what follows a title only numbers it as the first: "The Godfather Part I", "El padrino 1". */
function numbersTheFirst(extra: readonly string[], release: string): boolean {
  const [first, second] = extra;
  if (!first || extra.length > 2 || release.startsWith(`${first} `)) return false;
  if (extra.length === 2) return PART_WORDS.has(first) && FIRST_NUMBERS.has(second ?? "");
  return (first !== "one" && FIRST_NUMBERS.has(first)) || (first === "01" && FIRST_FILM.test(release));
}

/** The release's title is this one, give or take the words a copy of it adds. */
function sameTitle(release: string, wanted: string, mediaType: MediaType): boolean {
  if (!release || !wanted) return false;
  // Spacing is the release's own: "Spiderman" is "Spider-Man", "d Amelie" is "d'Amélie".
  if (release.replace(/ /g, "") === wanted.replace(/ /g, "")) return true;
  const extra = leftover(release, wanted, mediaType);
  return extra !== null && (extra.length === 0 || numbersTheFirst(extra, release));
}

/** One letter apart at most. */
function nearlyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.max(a.length, b.length) < FUZZY_MIN_LENGTH || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(longer.length === shorter.length ? i + 1 : i);
}

/** How a name's year sits with the title's: its own, the year either side, or none given. */
type YearFit = "exact" | "near" | "none";

/**
 * A release under a variation of one title's name: a brand in front of it
 * ("Marvel's The Avengers"), a word out of its middle ("The Godfather II"),
 * a misspelling. Another film of the same series is none of these: it ends
 * differently ("The Two Towers" for "The Fellowship of the Ring"), swaps a
 * word ("Your Fault" for "My Fault"), or adds a subtitle ("Catching Fire").
 */
function isVariationOf(have: readonly string[], want: readonly string[], year: YearFit): boolean {
  if (!want.length || !have.length) return false;
  const dated = year !== "none";
  // A letter's difference is a misspelling only where a year vouches for the name: undated, "Aliens" is not "Alien".
  const same = (word: string, other: string) => (dated ? nearlyEqual(word, other) : word === other);
  const among = (words: readonly string[]) => (word: string) => words.some((other) => same(word, other));
  const missing = want.filter((word) => !among(have)(word));
  const extra = have.filter((word) => !among(want)(word));
  const shared = want.length - missing.length;
  if (shared / want.length < RELATED_SHARE || (missing.length > 0 && extra.length > 0)) return false;
  if (numbersALaterPart(extra)) return false;
  // A shortened name is every part of a series at once: only the part's own year picks one out.
  if (missing.length > 0 && year === "near") return false;
  const ends = [want[0], want[want.length - 1]].every((word) => among(have)(word ?? "")) && among(want)(have[have.length - 1] ?? "");
  if (!ends) return false;
  // A name with a fitting year needs half of the title; one with no year must also be mostly the title itself.
  return dated ? shared / Math.min(want.length, have.length) >= RELATED_SHARE : shared / have.length >= RELATED_SHARE_UNDATED;
}

/** A title's words without a number that only says it is the first: "Infinity Castle Part 1" is "Infinity Castle". */
function withoutFirstMark(words: string[]): string[] {
  const last = words[words.length - 1] ?? "";
  if (words.length > 2 && PART_WORDS.has(words[words.length - 2] ?? "") && FIRST_NUMBERS.has(last)) return words.slice(0, -2);
  return words.length > 1 && last !== "one" && FIRST_NUMBERS.has(last) ? words.slice(0, -1) : words;
}

function isRelated(release: string, wanted: readonly string[], mediaType: MediaType, year: YearFit): boolean {
  const have = withoutFirstMark(titleWords(release, mediaType));
  return wanted.some((title) => isVariationOf(have, withoutFirstMark(titleWords(title, mediaType)), year));
}

/** Where a series name with no season tags ends its title, at an episode's number: "Show - 47", "Show 001 Pilot". */
function countedEpisodes(title: string): { show: string; from: number; to: number }[] {
  const words = title.split(" ");
  const counts = (word: string) => EPISODE_NUMBER.test(word) && !NOT_AN_EPISODE.test(word);
  const number = (word: string | undefined) => (word && counts(word) ? Number(word.replace(/^\D+|v\d$/g, "")) : null);
  const numbered = words.flatMap((word, index) => (index > 0 && number(word) !== null ? [index] : []));
  return numbered.slice(0, EPISODE_NUMBERS_TRIED).map((index) => {
    const from = number(words[index]) ?? 0;
    const next = number(words[index + 1]);
    return {
      show: words.slice(0, EPISODE_WORDS.has(words[index - 1] ?? "") ? index - 1 : index).join(" "),
      from,
      // Two episodes in one file: "01-02".
      to: next !== null && next > from && next - from < EPISODE_SPAN_MAX ? next : from,
    };
  });
}

/** The ways a release's title may be written that are still the title alone. */
function titleForms(name: ReleaseName, mediaType: MediaType): string[] {
  const forms = [name.title];
  // A year that belongs to the title: "Wonder Woman 1984", released without its own.
  if (name.year !== null) forms.push(`${name.title} ${name.year}`);
  // A dated name out of a numbered list: "3. My Neighbor Totoro (1988)".
  if (name.year !== null && LEADING_INDEX.test(name.title)) forms.push(name.title.replace(LEADING_INDEX, ""));
  // The year given twice, or the year made beside the year released: "Obsession 2025 2026".
  const twice = name.year !== null ? name.title.match(TRAILING_YEAR) : null;
  if (twice && Math.abs(Number(twice[2]) - (name.year ?? 0)) <= YEAR_TOLERANCE) forms.push(twice[1] ?? "");
  return mediaType === "tv" ? [...forms, ...countedEpisodes(name.title).map((counted) => counted.show)] : forms;
}

/** The wanted title a release's own matches, if any. */
function matchedTitle(name: ReleaseName, wanted: readonly string[], mediaType: MediaType): string | null {
  const forms = titleForms(name, mediaType);
  for (const title of wanted) {
    if (forms.some((form) => sameTitle(form, title, mediaType))) return title;
  }
  // Its names side by side: "Money Heist (La Casa de Papel)", "your name. / Kimi no Na wa. / 君の名は。".
  return wanted.find((title) => isOnlyNames(leftover(name.title, title, mediaType), wanted, mediaType, NAMES_SIDE_BY_SIDE - 1)) ?? null;
}

/** Whether what a release has beside one of the title's names is more of its names, and nothing else. */
function isOnlyNames(rest: string[] | null, wanted: readonly string[], mediaType: MediaType, more: number): boolean {
  if (!rest?.length || more < 1) return false;
  const beside = rest.join(" ");
  return wanted.some((other) => {
    if (sameTitle(beside, other, mediaType)) return true;
    const after = leftover(beside, other, mediaType);
    return after !== null && after.length < rest.length && isOnlyNames(after, wanted, mediaType, more - 1);
  });
}

/** What was asked for of a series: the season, when it is one. */
export interface Asked {
  season?: number;
}

/** The year the season asked for first aired; a first season's is the show's own. Null when not known. */
function seasonYear(facts: TitleFacts, asked: Asked | undefined): number | null {
  if (!asked?.season) return null;
  return facts.seasonYears?.[asked.season] ?? (asked.season === 1 ? facts.year : null);
}

/** Whether the year a release gives fits the title's; null when it gives none. */
function yearFits(name: ReleaseName, facts: TitleFacts, mediaType: MediaType, asked?: Asked): boolean | null {
  if (name.year === null || facts.year === null) return null;
  if (mediaType === "movie") return Math.abs(name.year - facts.year) <= YEAR_TOLERANCE;
  // A series is named for the year it began; later seasons often carry their own.
  if (name.year < facts.year - YEAR_TOLERANCE) return false;
  // A year after the season asked for aired is a later show of the same name ("One Piece 2023" for the 1999 one).
  const aired = name.run ? null : seasonYear(facts, asked);
  return aired === null || name.year <= aired + YEAR_TOLERANCE;
}

/**
 * A name some country gave the title that is only the start of its own: the
 * series' name, shared with every other part ("The Hunger Games" for
 * "The Hunger Games: Catching Fire").
 */
function isSeriesName(title: string, own: string, mediaType: MediaType): boolean {
  const words = titleWords(title, mediaType);
  const ownWords = titleWords(own, mediaType);
  return words.length < ownWords.length && words.every((word, index) => word === ownWords[index]);
}

type Reading = "match" | "related" | "other" | "another_year" | "another_part";

/** Judges one reading of a name. `wanted` is the title's names, normalized, its own first. */
function judgeName(name: ReleaseName, wanted: readonly string[], facts: TitleFacts, mediaType: MediaType, asked?: Asked): Reading {
  const own = wanted[0] ?? "";
  const title = matchedTitle(name, wanted, mediaType);
  // The year is not a date when it is one of the title's own words.
  const dated = name.year !== null && !(title ?? "").split(" ").includes(String(name.year));
  const fits = dated ? yearFits(name, facts, mediaType, asked) : null;
  if (fits === false) return "another_year";
  const year: YearFit = fits !== true ? "none" : facts.year === null || name.year === facts.year ? "exact" : "near";
  // A film series' name is this part only with this part's year. A show's short name is the show.
  const shared = (other: string) => mediaType === "movie" && isSeriesName(other, own, mediaType);
  if (title !== null && (year === "exact" || !shared(title))) return "match";
  // A series numbers its volumes and chapters the way a film numbers its sequels: only a film's say it is another.
  if (mediaType === "movie" && namesAnother(name.title, wanted)) return "another_part";
  // Another name: it has to be a variation of one of the title's own.
  return isRelated(name.title, wanted.filter((other) => !shared(other)), mediaType, year) ? "related" : "other";
}

/** A film's name that is one of the title's and then says which other it is: a later part, or an episode of the series. */
function namesAnother(title: string, wanted: readonly string[]): boolean {
  return wanted.some((other) => {
    const extra = leftover(title, other, "movie");
    if (!extra) return false;
    if (extra.length === 1 && COUNTED_EPISODE.test(extra[0] ?? "")) return true;
    // A later part: a number the title does not carry itself.
    const numbered = other.split(" ").some((word) => SEQUEL_NUMBERS.has(word) || PART_WORDS.has(word));
    return !numbered && numbersALaterPart(extra);
  });
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
const NOTHING_TO_READ: ReleaseJudgement = { verdict: "unknown", related: false, contradicts: false, anotherYear: false };

export function judgeReleaseName(releaseName: string, facts: TitleFacts, mediaType: MediaType, asked?: Asked): ReleaseJudgement {
  const wanted = [...new Set(facts.titles.map(normalizeTitle).filter(Boolean))];
  if (!wanted.length) return { ...NOTHING_TO_READ };
  const firstLine = releaseName.split("\n")[0] ?? "";
  if (mediaType === "movie" && EPISODE_TAG.test(normalizeTitle(firstLine))) return { ...NOTHING_TO_READ, verdict: "mismatch", contradicts: true };
  // A name can be given twice (a tracker's own language, then the original): the best reading of it stands.
  let verdict: ReleaseVerdict | null = null;
  let anotherYear = false;
  let anotherPart = false;
  for (const name of namesIn(firstLine).flatMap((part) => readings(part, mediaType))) {
    if (!name.title) continue;
    const reading = judgeName(name, wanted, facts, mediaType, asked);
    if (reading === "match") return { ...NOTHING_TO_READ, verdict: "match" };
    if (name.guess) continue;
    if (reading === "related") verdict = "unknown";
    else verdict ??= "mismatch";
    anotherYear ||= reading === "another_year";
    anotherPart ||= reading === "another_part";
  }
  const wrong = verdict === "mismatch";
  return { verdict: verdict ?? "unknown", related: verdict === "unknown", contradicts: wrong && (anotherYear || anotherPart), anotherYear: wrong && anotherYear };
}

export function judgeRelease(releaseName: string, facts: TitleFacts, mediaType: MediaType, asked?: Asked): ReleaseVerdict {
  return judgeReleaseName(releaseName, facts, mediaType, asked).verdict;
}

/**
 * The episode a series file counts itself as when it carries no season tag
 * ("Naruto - 001 - Enter Naruto", "One Piece EP0640"), as the span it covers;
 * null when its name is not the show's followed by a number.
 */
export function countedEpisode(fileName: string, facts: TitleFacts): { from: number; to: number } | null {
  const wanted = [...new Set(facts.titles.map(normalizeTitle).filter(Boolean))];
  const line = fileName.split("\n")[0] ?? "";
  for (const name of namesIn(line).flatMap((part) => readings(part, "tv"))) {
    const counted = countedEpisodes(name.title).find((entry) => wanted.some((title) => sameTitle(entry.show, title, "tv")));
    if (counted) return { from: counted.from, to: counted.to };
  }
  return null;
}

/** A show's name cut short has to keep at least this much of it to be known by it ("Boruto"). */
const SHORT_NAME_MIN_LENGTH = 4;

/** A name a show's files are numbered under: its own, with or without more (a season's, an arc's), cut short, or its initials. */
function isNameOfShow(show: string, wanted: readonly string[]): boolean {
  const compact = show.replace(/ /g, "");
  return wanted.some((title) => {
    const whole = title.replace(/ /g, "");
    const initials = title.split(" ").map((word) => word[0]).join("");
    if (compact.includes(whole) || (compact.length >= SHORT_NAME_MIN_LENGTH && whole.includes(compact))) return true;
    return initials.length > 1 && compact === initials;
  });
}

/**
 * True when an anime file counts itself as an episode of something by another
 * name: "Barto no Himitsu no Heya! - 01" out of a One Piece batch, "Dressrosa
 * 02" out of a recut. A file named for the episode alone ("01 - Asteroid
 * Blues", "Episode 1 A Peacetime Reward") counts nothing.
 */
export function countsAnotherShow(fileName: string, facts: TitleFacts): boolean {
  const wanted = [...new Set(facts.titles.map(normalizeTitle).filter(Boolean))];
  const words = parseReleaseName(fileName.split("\n")[0] ?? "", "tv").title.split(" ");
  const first = words[0] ?? "";
  if (/^\d+$/.test(first) || EPISODE_WORDS.has(first) || EPISODE_NUMBER.test(first)) return false;
  const at = words.findIndex((word, index) => index > 0 && WRITTEN_AS_COUNTER.test(word) && !NOT_AN_EPISODE.test(word));
  if (at < 0) return false;
  const show = words.slice(0, EPISODE_WORDS.has(words[at - 1] ?? "") ? at - 1 : at).join(" ");
  return Boolean(show) && !isNameOfShow(show, wanted) && !isRelated(show, wanted, "tv", "none");
}

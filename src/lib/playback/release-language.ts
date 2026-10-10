/**
 * What a release name says about its audio.
 *
 * A release is named `Title.Year.Tags-GROUP`, and the tags say which language
 * the audio is in when it is not the original: `TRUEFRENCH`, `VFF`, `iTA`,
 * `LATINO`, `Hindi.Dubbed`, `CZ dab`, a Russian tracker's name. `MULTI` and
 * `DUAL` mean several languages in one file, usually a dub beside the
 * original. A name with none of these is the original audio.
 *
 * Only the tags are read, never the title: "The French Dispatch" is not a
 * French release. The tags begin at the year, the episode or the resolution.
 */

export interface ReleaseAudio {
  /** Audio languages the name states (ISO 639-1), in the order found. Empty when it states none. */
  languages: string[];
  /** The name says the file carries more than one audio language. */
  multi: boolean;
  /** The name says the audio is a dub. */
  dubbed: boolean;
  /** Subtitles in another language are the point of the release, and usually burned into the picture. */
  foreignSubs: boolean;
}

/** How a release's audio relates to the language the title was made in. */
export type ReleaseAudioKind =
  /** States the original language and nothing else. */
  | "original"
  /** States nothing: the original, by convention. */
  | "unstated"
  /** Several languages; the original is usually one of them, but only a remux can choose it. */
  | "multi"
  /** Another language only. */
  | "dub";

/** Tags that only ever mean a language in a release name. */
const LANGUAGE_TAGS: Readonly<Record<string, string>> = {
  eng: "en",
  truefrench: "fr", vff: "fr", vfq: "fr", vf: "fr", vf2: "fr", vfi: "fr", vof: "fr", fre: "fr",
  deutsch: "de", ger: "de",
  ita: "it",
  espanol: "es", "español": "es", castellano: "es", latino: "es", esp: "es", spa: "es",
  dublado: "pt", ptbr: "pt", pt: "pt", nacional: "pt",
  rus: "ru",
  ukr: "uk",
  pldub: "pl", lektor: "pl",
  cesky: "cs",
  hun: "hu",
  turkce: "tr", dublaj: "tr",
  hin: "hi",
  swe: "sv",
  jap: "ja", jpn: "ja",
  kor: "ko",
  chi: "zh",
  bgaudio: "bg",
};

/**
 * Language names. An episode's own title can contain one ("The French
 * Mistake"), so between the episode number and the resolution a name counts
 * only when it is written the way a tag is (FRENCH, iTALiAN), not as a word.
 */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  english: "en", french: "fr", german: "de", italian: "it", spanish: "es", portuguese: "pt", russian: "ru",
  ukrainian: "uk", polish: "pl", czech: "cs", slovak: "sk", hungarian: "hu", turkish: "tr", hindi: "hi",
  tamil: "ta", telugu: "te", malayalam: "ml", bengali: "bn", kannada: "kn", marathi: "mr", punjabi: "pa", urdu: "ur",
  arabic: "ar", persian: "fa", farsi: "fa", hebrew: "he", dutch: "nl", flemish: "nl", swedish: "sv",
  norwegian: "no", danish: "da", finnish: "fi", japanese: "ja", korean: "ko", chinese: "zh", mandarin: "zh",
  cantonese: "zh", greek: "el", romanian: "ro", bulgarian: "bg", serbian: "sr", croatian: "hr", thai: "th",
  vietnamese: "vi", indonesian: "id",
};

/** Two-letter codes, read only in capitals ("EN/FR/ES", "(CZ/EN)"): in lower case they are words. */
const LANGUAGE_CODES: Readonly<Record<string, string>> = {
  EN: "en", FR: "fr", ES: "es", RU: "ru", PL: "pl", NL: "nl", CZ: "cs", SK: "sk",
};

/** Groups and trackers whose releases carry a Russian voice-over, whatever else the name says. */
const RUSSIAN_SOURCES = /rutracker|rutor|lostfilm|newstudio|hdrezka|jaskier|alexfilm|baibako|coldfilm|ideafilm|novafilm|kerob|nnmclub/;
const CYRILLIC = /[Ѐ-ӿ]/;

/**
 * Flags a torrent index adds beneath a release name (two regional-indicator
 * letters each), by country code. One or two flags are the audio: "🇪🇸" under
 * a Spanish release, "🇬🇧 / 🇮🇹" under an ITA.ENG one. A longer row is the
 * subtitles: an ordinary English WEB-DL carries twenty of them.
 */
const FLAG_LANGUAGES: Readonly<Record<string, string>> = {
  gb: "en", us: "en", fr: "fr", de: "de", at: "de", it: "it", es: "es", mx: "es", ar: "es", br: "pt", pt: "pt",
  ru: "ru", ua: "uk", pl: "pl", cz: "cs", sk: "sk", hu: "hu", tr: "tr", in: "hi", jp: "ja", kr: "ko",
  cn: "zh", tw: "zh", hk: "zh", nl: "nl", se: "sv", no: "no", dk: "da", fi: "fi", gr: "el", ro: "ro",
  bg: "bg", sa: "ar", ae: "ar", eg: "ar", ir: "fa", il: "he", th: "th", vn: "vi", id: "id", rs: "sr", hr: "hr",
};
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const REGIONAL_INDICATOR_A = 0x1f1e6;
/** More flags than this beneath a name list its subtitles, not its audio. */
const MAX_AUDIO_FLAGS = 2;

/** "🇫🇷" → "fr": each regional indicator is a letter, offset from A. */
function flagCountry(flag: string): string {
  return [...flag].map((symbol) => String.fromCharCode(97 + symbol.codePointAt(0)! - REGIONAL_INDICATOR_A)).join("");
}

const MULTI_TAGS: ReadonlySet<string> = new Set(["multi", "multilang", "dual", "2audio", "mvo", "dvo", "avo"]);
const DUB_TAGS: ReadonlySet<string> = new Set(["dubbed", "dub", "dab", "dabing", "dublado", "doblado", "doblaje", "dublaj", "dubbing", "lektor", "pldub"]);
/** Subtitles are the release's point: burned in (HC, KORSUB) or shipped switched on (VOSTFR). */
const FOREIGN_SUB_TAGS: ReadonlySet<string> = new Set([
  "hc", "hardsub", "hardsubs", "hardcoded", "korsub", "korsubs", "subtitulado", "vostfr", "vost", "subfrench", "swesub", "nlsubs", "nlsubbed", "dksubs",
]);
/** A language beside one of these is the subtitles' language, not the audio's. */
const SUBTITLE_WORDS: ReadonlySet<string> = new Set(["sub", "subs", "subbed", "subtitle", "subtitles", "subtitulado", "esub", "esubs", "msub", "msubs"]);

const TITLE_END = /^(?:(?:19|20)\d{2}|s\d{1,2}(?:e\d{1,3})?|\d{1,2}x\d{2,3}|season|\d{3,4}p|4k|uhd)$/;
const EPISODE_MARK = /^(?:s\d{1,2}(?:e\d{1,3})?|\d{1,2}x\d{2,3}|season)$/;
const RESOLUTION = /^(?:\d{3,4}p|4k|uhd)$/;
/** "French": a capital and then lower case, the way a word in a title is written. */
const WRITTEN_AS_A_WORD = /^\p{Lu}\p{Ll}+$/u;

/** One piece of a release name, as written and in lower case. */
interface Token {
  raw: string;
  tag: string;
}

function tokens(title: string): Token[] {
  return title
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((raw) => ({ raw, tag: raw.toLowerCase() }));
}

/** The tokens after the title: from the first year, episode or resolution on. All of them when there is no such mark. */
function tagTokens(all: Token[]): Token[] {
  const start = all.findIndex((token) => TITLE_END.test(token.tag));
  return start < 0 ? all : all.slice(start);
}

function isSubtitleLanguage(tags: Token[], index: number): boolean {
  return SUBTITLE_WORDS.has(tags[index - 1]?.tag ?? "") || SUBTITLE_WORDS.has(tags[index + 1]?.tag ?? "");
}

/**
 * Where an episode's title may sit: after the episode number and before the
 * resolution. Zero-width for a film, or a name with no resolution to end it.
 */
function episodeTitleSpan(tags: Token[]): { from: number; to: number } {
  const episode = tags.findIndex((token) => EPISODE_MARK.test(token.tag));
  const resolution = tags.findIndex((token) => RESOLUTION.test(token.tag));
  return episode >= 0 && resolution > episode ? { from: episode, to: resolution } : { from: 0, to: 0 };
}

/** The audio language one token states, if it states one. */
function languageOf(tags: Token[], index: number, title: { from: number; to: number }): string | undefined {
  const { raw, tag } = tags[index]!;
  if (isSubtitleLanguage(tags, index)) return undefined;
  if (LANGUAGE_TAGS[tag]) return LANGUAGE_TAGS[tag];
  if (LANGUAGE_CODES[raw]) return LANGUAGE_CODES[raw];
  const name = LANGUAGE_NAMES[tag];
  if (!name) return undefined;
  const inEpisodeTitle = index > title.from && index < title.to;
  const besideAMarker = [tags[index - 1]?.tag, tags[index + 1]?.tag].some((near) => DUB_TAGS.has(near ?? "") || MULTI_TAGS.has(near ?? "") || near === "audio");
  return inEpisodeTitle && WRITTEN_AS_A_WORD.test(raw) && !besideAMarker ? undefined : name;
}

/** "MULTi" says several audio languages, unless what follows says it is the subtitles there are several of. */
function saysSeveralAudio(tags: Token[]): boolean {
  return tags.some((token, index) => MULTI_TAGS.has(token.tag) && !SUBTITLE_WORDS.has(tags[index + 1]?.tag ?? ""));
}

export function parseReleaseAudio(title: string): ReleaseAudio {
  const tags = tagTokens(tokens(title));
  const span = episodeTitleSpan(tags);
  const languages: string[] = [];
  const add = (code: string | undefined) => {
    if (code && !languages.includes(code)) languages.push(code);
  };
  tags.forEach((_token, index) => add(languageOf(tags, index, span)));
  const flags = title.match(FLAG) ?? [];
  if (flags.length <= MAX_AUDIO_FLAGS) for (const flag of flags) add(FLAG_LANGUAGES[flagCountry(flag)]);
  const lower = title.toLowerCase();
  if (RUSSIAN_SOURCES.test(lower) || CYRILLIC.test(title)) add("ru");
  return {
    languages,
    // "German.DL" is German beside the original (alone, DL is only half of WEB-DL).
    multi: saysSeveralAudio(tags) || /german[ ._-]?dl\b/.test(lower) || /(?:dual|multi)[ ._-]?[aá]udio/.test(lower),
    dubbed: tags.some((token) => DUB_TAGS.has(token.tag)),
    foreignSubs: tags.some((token) => FOREIGN_SUB_TAGS.has(token.tag)),
  };
}

/** English is the original wherever the title's own language is not known. */
const DEFAULT_ORIGINAL = "en";

export function releaseAudioKind(audio: ReleaseAudio, originalLanguage?: string | null): ReleaseAudioKind {
  const original = (originalLanguage || DEFAULT_ORIGINAL).toLowerCase();
  const several = audio.multi || audio.languages.length > 1;
  if (audio.languages.length === 0) {
    if (audio.multi) return "multi";
    return audio.dubbed ? "dub" : "unstated";
  }
  if (several) return "multi";
  if (audio.languages[0] === original) return audio.dubbed ? "dub" : "original";
  return "dub";
}

/**
 * True for a release nobody who wants the original should be given while a
 * better one exists: a dub, or one with another language's subtitles over it.
 */
export function isUnwantedRelease(title: string, originalLanguage?: string | null): boolean {
  const audio = parseReleaseAudio(title);
  return audio.foreignSubs || releaseAudioKind(audio, originalLanguage) === "dub";
}

/** True when the name carries the marks a release name has (a year, an episode, a resolution). */
export function looksLikeReleaseName(text: string): boolean {
  return tokens(text).some((token) => TITLE_END.test(token.tag));
}

/**
 * The audio language a release name states, as a single code: the language of
 * a dub, "en" for English, "xx" for several languages or an unnamed dub, and
 * "und" when the name states nothing.
 */
export function releaseAudioCode(title: string): string {
  const audio = parseReleaseAudio(title);
  if (audio.multi || audio.languages.length > 1) return "xx";
  if (audio.languages.length === 1) return audio.languages[0]!;
  return audio.dubbed ? "xx" : "und";
}

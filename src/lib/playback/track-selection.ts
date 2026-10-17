import type {
  AudioPreference,
  SubtitlePreference,
} from "@/lib/profile-preferences";

export interface SelectableMediaTrack {
  id: number;
  name?: string;
  lang?: string;
  default?: boolean;
  forced?: boolean;
}

export interface AudioTrackSelection {
  preference: AudioPreference;
  originalLanguage?: string | null;
  preferredLanguage?: string | null;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  eng: "en",
  jpn: "ja",
  spa: "es",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  ita: "it",
  por: "pt",
  kor: "ko",
  hin: "hi",
  zho: "zh",
  chi: "zh",
  ara: "ar",
  ben: "bn",
  bul: "bg",
  ces: "cs",
  cze: "cs",
  dan: "da",
  dut: "nl",
  nld: "nl",
  ell: "el",
  gre: "el",
  fin: "fi",
  heb: "he",
  hun: "hu",
  ind: "id",
  may: "ms",
  msa: "ms",
  nor: "no",
  pol: "pl",
  ron: "ro",
  rum: "ro",
  rus: "ru",
  swe: "sv",
  tam: "ta",
  tel: "te",
  tha: "th",
  tur: "tr",
  ukr: "uk",
  urd: "ur",
  vie: "vi",
};

export function normalizeTrackLanguage(value?: string | null): string {
  const normalized = (value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "";
  const base = normalized.split("-")[0] ?? normalized;
  return LANGUAGE_ALIASES[base] ?? base;
}

/**
 * Track names that say which language they are, whatever the tag says: a
 * Spanish dub named "Castellano" but tagged eng, or a dub with no tag at all,
 * which Matroska reads as English.
 */
const NAMED_LANGUAGES: ReadonlyArray<readonly [string, RegExp]> = [
  ["es", /(?<!\p{L})(spanish|espa[nñ]ol|castellano|latino|latin american)(?!\p{L})/iu],
  ["it", /(?<!\p{L})(italian|italiano)(?!\p{L})/iu],
  ["fr", /(?<!\p{L})(french|fran[cç]ais|vff|vfq|vf2|truefrench)(?!\p{L})/iu],
  ["de", /(?<!\p{L})(german|deutsch)(?!\p{L})/iu],
  ["ru", /(?<!\p{L})(russian|русский|дубляж|многоголосый|двухголосый|одноголосый)(?!\p{L})/iu],
  ["uk", /(?<!\p{L})(ukrainian|українська)(?!\p{L})/iu],
  ["pt", /(?<!\p{L})(portuguese|portugu[eê]s|brazilian|dublado)(?!\p{L})/iu],
  ["pl", /(?<!\p{L})(polish|polski|lektor)(?!\p{L})/iu],
  ["tr", /(?<!\p{L})(turkish|türkçe)(?!\p{L})/iu],
  ["hi", /(?<!\p{L})(hindi)(?!\p{L})/iu],
  ["ja", /(?<!\p{L})(japanese)(?!\p{L})/iu],
  ["ko", /(?<!\p{L})(korean)(?!\p{L})/iu],
  ["zh", /(?<!\p{L})(chinese|mandarin|cantonese)(?!\p{L})/iu],
  ["ar", /(?<!\p{L})(arabic)(?!\p{L})/iu],
];

/** The language a track's name says it is, when it names one. */
export function namedTrackLanguage(name?: string | null): string | null {
  if (!name) return null;
  for (const [code, pattern] of NAMED_LANGUAGES) if (pattern.test(name)) return code;
  return null;
}

function trackText(track: SelectableMediaTrack): string {
  return `${track.lang ?? ""} ${track.name ?? ""}`.toLowerCase();
}

function isLanguage(track: SelectableMediaTrack, language?: string | null): boolean {
  const target = normalizeTrackLanguage(language);
  if (!target) return false;
  const named = namedTrackLanguage(track.name);
  // The name wins over the tag when it says another language.
  if (named && named !== target) return false;
  if (named === target) return true;
  const actual = normalizeTrackLanguage(track.lang);
  if (actual === target) return true;
  const name = (track.name ?? "").toLowerCase();
  if (target === "en") return /\b(english|eng)\b/.test(name);
  return name.includes(target);
}

export function isCommentaryOrDescriptionTrack(
  track: SelectableMediaTrack
): boolean {
  return /commentary|audio description|audio described|descriptive audio|director.?s comments|narration/.test(
    trackText(track)
  );
}

function usableAudioTracks(
  tracks: readonly SelectableMediaTrack[]
): readonly SelectableMediaTrack[] {
  const normal = tracks.filter((track) => !isCommentaryOrDescriptionTrack(track));
  return normal.length > 0 ? normal : tracks;
}

function firstLanguageMatch(
  tracks: readonly SelectableMediaTrack[],
  language?: string | null
): SelectableMediaTrack | undefined {
  const matches = tracks.filter((track) => isLanguage(track, language));
  return matches.find((track) => track.default) ?? matches[0];
}

/** Original audio first, then English, without auto-selecting commentary. */
export function selectAudioTrack(
  tracks: readonly SelectableMediaTrack[],
  selection: AudioTrackSelection
): SelectableMediaTrack | null {
  if (tracks.length === 0) return null;
  const usable = usableAudioTracks(tracks);
  const original = selection.originalLanguage;
  const preferred = selection.preferredLanguage;
  const languageOrder =
    selection.preference === "english"
      ? ["en", original, preferred]
      : selection.preference === "preferred"
        ? [preferred, original, "en"]
        : [original, "en", preferred];

  for (const language of languageOrder) {
    const match = firstLanguageMatch(usable, language);
    if (match) return match;
  }
  return usable.find((track) => track.default) ?? usable[0] ?? null;
}

/** The language the viewer wants to hear for this title ("" when it cannot be known). */
export function wantedAudioLanguage(selection: AudioTrackSelection): string {
  const { preference, originalLanguage, preferredLanguage } = selection;
  const wanted = preference === "english" ? "en" : preference === "preferred" ? preferredLanguage : originalLanguage;
  return normalizeTrackLanguage(wanted);
}

/**
 * True when a file certainly has no audio in the wanted language: every track
 * states its language and none of them is it. A track that states nothing may
 * be the one, so a file with any such track is never called lacking.
 */
export function lacksWantedAudio(
  tracks: ReadonlyArray<{ language?: string | null; name?: string | null }>,
  selection: AudioTrackSelection
): boolean {
  const wanted = wantedAudioLanguage(selection);
  if (!wanted || tracks.length === 0) return false;
  // A track's name says its language over its tag (see namedTrackLanguage).
  const languages = tracks.map((track) => namedTrackLanguage(track.name) ?? normalizeTrackLanguage(track.language));
  if (languages.some((language) => !language || language === "und")) return false;
  return !languages.includes(wanted);
}

export function isForcedSubtitleTrack(track: SelectableMediaTrack): boolean {
  return Boolean(track.forced) || /\bforced\b/.test(trackText(track));
}

function isAccessibilitySubtitleTrack(track: SelectableMediaTrack): boolean {
  return /\b(sdh|cc)\b|hearing.?impaired|closed captions/.test(trackText(track));
}

/** English full subtitles first; SDH/CC next; forced tracks only as a last resort. */
export function selectSubtitleTrack(
  tracks: readonly SelectableMediaTrack[],
  preference: SubtitlePreference
): SelectableMediaTrack | null {
  if (preference === "off" || tracks.length === 0) return null;
  const english = tracks.filter((track) => isLanguage(track, "en"));
  const full = english.filter(
    (track) =>
      !isForcedSubtitleTrack(track) && !isAccessibilitySubtitleTrack(track)
  );
  const accessibility = english.filter(
    (track) =>
      !isForcedSubtitleTrack(track) && isAccessibilitySubtitleTrack(track)
  );
  const forced = english.filter(isForcedSubtitleTrack);
  return (
    full.find((track) => track.default) ??
    full[0] ??
    accessibility.find((track) => track.default) ??
    accessibility[0] ??
    forced.find((track) => track.default) ??
    forced[0] ??
    null
  );
}

import { tmdb } from "@/lib/tmdb";
import gzip from "zlib";
import { languageName } from "@/lib/language-name";

export interface SubtitleTrackOption {
  id: string;
  label: string;
  language: string;
  subLanguageId?: string;
  format: string;
  downloadUrl: string;
  vttUrl: string;
  isDefault?: boolean;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Titles whose subtitle lists are kept; the oldest is dropped beyond this. */
const CACHE_MAX_ENTRIES = 500;
const subtitleCache = new Map<string, { timestamp: number; tracks: SubtitleTrackOption[] }>();
/** A subtitle file is a few hundred KB at most; anything far bigger is not one. */
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * The only hosts subtitle files are fetched from: the OpenSubtitles service
 * the list comes from. Anything else (an internal address above all) is
 * refused, so the download route cannot be used to reach other machines.
 */
const SUBTITLE_HOST_SUFFIXES = [".strem.io", ".opensubtitles.org", ".opensubtitles.com"];

export function isAllowedSubtitleUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return SUBTITLE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
}

function rememberTracks(key: string, tracks: SubtitleTrackOption[]): void {
  subtitleCache.delete(key);
  subtitleCache.set(key, { timestamp: Date.now(), tracks });
  while (subtitleCache.size > CACHE_MAX_ENTRIES) {
    const oldest = subtitleCache.keys().next().value;
    if (oldest === undefined) break;
    subtitleCache.delete(oldest);
  }
}

/** Reads a response body, giving up past `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const LANGUAGE_NAMES: Record<string, string> = {
  eng: "English",
  en: "English",
  spa: "Spanish",
  es: "Spanish",
  fre: "French",
  fra: "French",
  fr: "French",
  ger: "German",
  deu: "German",
  de: "German",
  ita: "Italian",
  it: "Italian",
  por: "Portuguese",
  pt: "Portuguese",
  pob: "Portuguese (BR)",
  rus: "Russian",
  ru: "Russian",
  ara: "Arabic",
  ar: "Arabic",
  jpn: "Japanese",
  ja: "Japanese",
  kor: "Korean",
  ko: "Korean",
  chi: "Chinese",
  zho: "Chinese",
  zh: "Chinese",
  hin: "Hindi",
  hi: "Hindi",
  tur: "Turkish",
  tr: "Turkish",
  vie: "Vietnamese",
  vi: "Vietnamese",
  pol: "Polish",
  pl: "Polish",
  dut: "Dutch",
  nld: "Dutch",
  nl: "Dutch",
  swe: "Swedish",
  sv: "Swedish",
  nor: "Norwegian",
  no: "Norwegian",
  dan: "Danish",
  da: "Danish",
  fin: "Finnish",
  fi: "Finnish",
  gre: "Greek",
  ell: "Greek",
  el: "Greek",
  heb: "Hebrew",
  he: "Hebrew",
  ind: "Indonesian",
  id: "Indonesian",
  tha: "Thai",
  th: "Thai",
};

export function getLanguageDisplayName(code: string, rawName?: string): string {
  const normalized = (code || "").trim().toLowerCase();
  if (LANGUAGE_NAMES[normalized]) return LANGUAGE_NAMES[normalized];
  if (rawName && rawName.trim()) return rawName.trim();
  // Anything else (HRV, RON, UKR, ...) through the shared table and Intl, not a raw code.
  const named = languageName(normalized);
  return named && named.toLowerCase() !== normalized ? named : normalized.toUpperCase() || "Unknown";
}

/**
 * Converts raw SubRip (SRT) or VTT string into clean standard WebVTT format.
 * Strips HTML ads/watermarks and normalizes timestamp formats.
 */
export function convertSrtToVtt(srtContent: string): string {
  if (!srtContent || !srtContent.trim()) return "WEBVTT\n\n";

  const text = srtContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (text.startsWith("WEBVTT")) {
    return text;
  }

  const timestampRegex = /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/;
  const lines = text.split("\n");
  const output: string[] = ["WEBVTT", ""];

  let inCue = false;
  let currentCueText: string[] = [];
  let currentTimestamp = "";

  // Promotional lines subtitle sites insert. Matched on site names and on
  // credit lines that start that way, never on ordinary words: "That was a
  // great advertisement." is dialogue.
  const isAdLine = (line: string): boolean => {
    const lower = line.toLowerCase().replace(/<[^>]+>/g, "").trim();
    return (
      /opensubtitles|osdb\.link|addic7ed|yify-?subtitles|subscene|podnapisi|www\.[a-z0-9-]+\.(com|org|net)/.test(lower) ||
      /^(subtitles|subtitle|subs|captions|captioned|synced?|sync and corrections|ripped|corrected|translated|transcript)\b.*\bby\b/.test(lower) ||
      /^(downloaded from|support us and become vip|advertise your product|watch (it )?online)/.test(lower)
    );
  };

  const flushCue = () => {
    if (currentTimestamp && currentCueText.length > 0) {
      const cleanLines = currentCueText.filter((line) => !isAdLine(line));
      if (cleanLines.length > 0) {
        output.push(currentTimestamp);
        output.push(cleanLines.join("\n"));
        output.push("");
      }
    }
    currentCueText = [];
    currentTimestamp = "";
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inCue) {
        flushCue();
        inCue = false;
      }
      continue;
    }

    const tsMatch = trimmed.match(timestampRegex);
    if (tsMatch) {
      flushCue();
      inCue = true;
      currentTimestamp = `${tsMatch[1]}.${tsMatch[2]} --> ${tsMatch[3]}.${tsMatch[4]}`;
      continue;
    }

    if (/^\d+$/.test(trimmed) && !inCue) {
      continue;
    }

    if (inCue) {
      currentCueText.push(trimmed);
    }
  }

  flushCue();
  return output.join("\n");
}

export async function getImdbIdFromTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv"
): Promise<string | null> {
  // Uses the shared TMDB client so a key saved in Settings works, not only .env.
  try {
    const ids = await tmdb.externalIds(tmdbId, mediaType);
    return ids.imdb_id || null;
  } catch {
    return null;
  }
}

export async function fetchSubtitlesForTitle(options: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  imdbId?: string | null;
  season?: number;
  episode?: number;
  preferredLanguage?: string;
}): Promise<SubtitleTrackOption[]> {
  const { tmdbId, mediaType, season, episode } = options;
  const cacheKey = `${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}`;

  const cached = subtitleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.tracks;
  }

  let imdbId = options.imdbId;
  if (!imdbId) {
    imdbId = await getImdbIdFromTmdb(tmdbId, mediaType);
  }

  if (!imdbId) {
    return [];
  }

  const queryUrl =
    mediaType === "tv"
      ? `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}:${season ?? 1}:${episode ?? 1}.json`
      : `https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`;

  try {
    const res = await fetch(queryUrl, {
      headers: {
        "User-Agent": "AbsoluteCinema/1.0",
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      return [];
    }

    const data = await res.json();
    const items = (data.subtitles || []) as Array<{
      id: string;
      url: string;
      lang: string;
      SubEncoding?: string;
    }>;

    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const tracksByLang = new Map<string, SubtitleTrackOption>();
    const seenUrls = new Set<string>();

    for (const item of items) {
      if (!item.url || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      const langCode = (item.lang || "eng").toLowerCase();
      const langName = getLanguageDisplayName(langCode);

      const count = [...tracksByLang.keys()].filter((k) => k.startsWith(langCode)).length;
      if (count >= 3) continue;

      const suffix = count === 0 ? "" : ` [${count + 1}]`;
      const key = `${langCode}${suffix}`;

      const vttUrl = `/api/subtitles/vtt?url=${encodeURIComponent(item.url)}&id=${item.id}`;

      tracksByLang.set(key, {
        id: `sub_${item.id}`,
        label: `${langName}${suffix}`,
        language: langCode === "pob" ? "pt-BR" : langCode,
        subLanguageId: langCode,
        format: "srt",
        downloadUrl: item.url,
        vttUrl,
        isDefault: (langCode === "eng" || langCode === "en") && count === 0,
      });
    }

    const tracks = [...tracksByLang.values()].sort((a, b) => {
      if (a.language.startsWith("en") && !b.language.startsWith("en")) return -1;
      if (!a.language.startsWith("en") && b.language.startsWith("en")) return 1;
      if (a.language.startsWith("es") && !b.language.startsWith("es")) return -1;
      if (!a.language.startsWith("es") && b.language.startsWith("es")) return 1;
      return a.label.localeCompare(b.label);
    });

    rememberTracks(cacheKey, tracks);
    return tracks;
  } catch (err) {
    console.error("[subtitles] failed to fetch subtitles:", err);
    return [];
  }
}

export async function downloadAndConvertVtt(downloadUrl: string): Promise<string | null> {
  try {
    // Redirects are followed by hand so every hop is held to the same hosts.
    let target = downloadUrl;
    let res: Response | null = null;
    const signal = AbortSignal.timeout(8000);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedSubtitleUrl(target)) return null;
      res = await fetch(target, {
        headers: { "User-Agent": "AbsoluteCinema/1.0" },
        redirect: "manual",
        signal,
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      await res.body?.cancel().catch(() => undefined);
      target = new URL(location, target).toString();
      res = null;
    }

    if (!res?.ok) return null;

    const buffer = await readCapped(res, MAX_SUBTITLE_BYTES);
    if (!buffer) return null;
    let rawText = "";

    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      // maxOutputLength: a small compressed file must not inflate into gigabytes.
      const decompressed = gzip.gunzipSync(buffer, { maxOutputLength: MAX_SUBTITLE_BYTES * 4 });
      rawText = decompressed.toString("utf-8");
    } else {
      rawText = buffer.toString("utf-8");
    }

    return convertSrtToVtt(rawText);
  } catch (err) {
    console.error("[subtitles] failed to download/convert VTT:", err);
    return null;
  }
}

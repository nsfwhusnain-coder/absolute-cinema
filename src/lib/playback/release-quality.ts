/**
 * Picture quality of one release, judged from its file rather than its label.
 *
 * `release-scorer.ts` says how a release was mastered. This module says how
 * much picture is really in the file that will play. Two releases can both
 * read "1080p" and differ several-fold in detail, and a "2160p" can be an
 * upscale of a 1080p master, so the resolution tag alone says little. The
 * model here is:
 *
 *  - a video bitrate, from the file size and runtime with the audio tracks
 *    taken out, because audio is not picture;
 *  - bits per pixel, which divides that bitrate by resolution and codec so a
 *    2 Mbit/s HEVC frame and a 6 Mbit/s H.264 frame compare fairly;
 *  - flags for things that make a release look better than it plays
 *    (upscaled, interpolated, hardcoded subtitles, starved, ...);
 *  - a tier that puts flagged releases behind normal ones without removing
 *    them, because a flagged copy may be the only copy that exists.
 *
 * Nothing here rejects a release. A demoted release stays in the roster and
 * ranks below every release that is not demoted.
 *
 * Pure and dependency-free: no network, no clock, no Node modules.
 */

import {
  ANIME_BLURAY_GROUP_TIERS,
  ANIME_LQ_GROUPS,
  ANIME_WEB_GROUP_TIERS,
  HD_BLURAY_GROUP_TIERS,
  LQ_GROUPS,
  LQ_TITLE_TERMS,
  REMUX_GROUP_TIERS,
  STREAMING_SERVICES,
  UHD_BLURAY_GROUP_TIERS,
  WEB_GROUP_TIERS,
} from "./release-quality-lists";

export type QualityHeight = 720 | 1080 | 2160;
export type QualityCodec = "h264" | "hevc" | "av1" | "unknown";

export interface ReleaseQualityInput {
  /** Torrent or release name. */
  releaseTitle: string;
  /** File inside a pack, when known. Scanned for flags and group names too. */
  fileName?: string;
  /** Resolution bucket already parsed by the caller. */
  height: QualityHeight;
  codec: QualityCodec;
  /** Size of the file that will play, not of the pack. */
  sizeBytes?: number | null;
  /** TMDB runtime of the film or episode. */
  runtimeMinutes?: number | null;
  /**
   * Whether the caller considers the title anime. Enables the anime group
   * tiers and the anime low-quality list. Defaults to false.
   */
  anime?: boolean;
}

export type QualityFlag =
  | "upscaled"
  | "interpolated"
  | "hardsub"
  | "starved"
  | "lq-group"
  | "dv-only"
  | "heavy"
  | "remux"
  | "downscaled-4k"
  | "repack"
  | "hybrid";

export interface ReleaseQuality {
  /** Height the picture really has detail for: an upscaled or starved "2160p" is 1080. */
  effectiveHeight: QualityHeight;
  /**
   * 3 normal, 2 heavy (too high a bitrate to stream smoothly), 1 flagged
   * (starved, upscaled, interpolated, hardsub or dv-only). Higher is better.
   */
  tier: 1 | 2 | 3;
  /**
   * Fine score inside a tier; higher is better. Roughly 0..800, kept to one
   * decimal place. Rounding to whole numbers would tie releases that the
   * rules separate by a fraction of a point.
   */
  score: number;
  flags: QualityFlag[];
  /** Estimated average video bitrate in Mbit/s, or null without a size and runtime. */
  videoMbps: number | null;
  /** H.264-equivalent bits per pixel per frame at `effectiveHeight`, or null when unknown. */
  bpp: number | null;
  /** Short human-readable reasons, for logs. */
  reasons: string[];
}

/** Below this many bits per pixel the picture visibly loses detail to compression. */
export const BPP_STARVED = 0.05;
/** At or above this many bits per pixel extra bitrate buys little visible detail. */
export const BPP_SATURATED = 0.15;

/**
 * Mbit/s above which a stream is too heavy to read smoothly over a single
 * debrid connection. Measured at the height the file is actually encoded at.
 */
export const HEAVY_MBPS: Readonly<Record<QualityHeight, number>> = { 720: 20, 1080: 30, 2160: 50 };

/** Points for group reputation within each source category, by tier. */
export const GROUP_TIER_POINTS = {
  remux: [60, 40, 20],
  uhdBluray: [50, 30, 15],
  hdBluray: [50, 30, 15],
  web: [40, 25, 10],
  animeBluray: [60, 52, 45, 38, 30, 22, 15, 8],
  animeWeb: [40, 32, 25, 18, 10, 5],
} as const;

/** A group that is tiered, but for a different source than this release's, still earns this. */
const GROUP_MISMATCH_POINTS = 10;
const LQ_GROUP_POINTS = -60;

const FRAME_RATE = 24;
const PIXELS_PER_FRAME: Readonly<Record<QualityHeight, number>> = {
  720: 1280 * 720,
  1080: 1920 * 1080,
  2160: 3840 * 2160,
};

/**
 * Newer codecs reach the same picture at lower bitrate, so their bitrate is
 * scaled up to an H.264 equivalent before it is turned into bits per pixel.
 */
const CODEC_EFFICIENCY: Readonly<Record<QualityCodec, number>> = {
  h264: 1.0,
  hevc: 2.0,
  av1: 2.3,
  unknown: 1.0,
};

const CODEC_LABEL: Readonly<Record<QualityCodec, string>> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  unknown: "codec unknown",
};

/** Share of the total bitrate that audio may take, however large its estimate. */
const AUDIO_CAP_SHARE = 0.6;
/** The video bitrate never falls below this share of the total. */
const MIN_VIDEO_SHARE = 0.4;

/** Points for picture detail. Saturated detail earns all of them; starved detail earns none. */
const DETAIL_POINTS = 400;
/** Detail share used when the bitrate is unknown: unknown size is not evidence of a bad file. */
const UNKNOWN_DETAIL_SHARE = 0.5;

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

const TRUEHD_PATTERN = /\btrue[ ._-]?hd\b/i;
const TRUEHD_OR_ATMOS_PATTERN = /\btrue[ ._-]?hd\b|\batmos\b/i;
const DD_PLUS_PATTERN = /\bddp|\bdd\+|e[ ._-]?ac[ ._-]?3|dolby[ ._-]?digital[ ._-]?plus/i;
const DTS_HD_PATTERN = /\bdts[ ._-]?(hd|x|ma)\b|\bdts[ ._-]?hd[ ._-]?ma\b/i;
const LOSSLESS_PCM_PATTERN = /\bflac\b|\bpcm\b|\blpcm\b/i;
const DTS_PATTERN = /\bdts\b/i;
const AC3_PATTERN = /\bac[ ._-]?3\b|\bdd[ ._-]?[257][ ._.]?[01]\b|\bdd\b/i;
const AAC_OPUS_PATTERN = /\baac(?:[ ._-]?[1-7](?:[ ._-]?[01])?)?\b|\bopus\b/i;

/**
 * Estimated audio bitrate in Mbit/s, taken from the first track name found.
 * Atmos over DD+ is the lossy object-based track, about 768 kbit/s, so it is
 * estimated as DD+ rather than as TrueHD.
 */
function estimateAudioMbps(text: string): number {
  if (TRUEHD_OR_ATMOS_PATTERN.test(text)) {
    return !TRUEHD_PATTERN.test(text) && DD_PLUS_PATTERN.test(text) ? 0.768 : 4.0;
  }
  if (DTS_HD_PATTERN.test(text)) return 3.0;
  if (LOSSLESS_PCM_PATTERN.test(text)) return 1.5;
  if (DTS_PATTERN.test(text)) return 1.5;
  if (DD_PLUS_PATTERN.test(text)) return 0.64;
  if (AC3_PATTERN.test(text)) return 0.448;
  if (AAC_OPUS_PATTERN.test(text)) return 0.256;
  return 0.4;
}

/**
 * Average video bitrate in Mbit/s, or null without a usable size and runtime.
 * The audio estimate is capped so it can never swallow most of a low-bitrate
 * file, which would make the picture look starved when it is not.
 */
function estimateVideoMbps(
  sizeBytes: number | null | undefined,
  runtimeMinutes: number | null | undefined,
  text: string
): number | null {
  if (sizeBytes == null || runtimeMinutes == null) return null;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return null;
  const totalMbps = (sizeBytes * 8) / (runtimeMinutes * 60) / 1_000_000;
  const audioMbps = Math.min(estimateAudioMbps(text), AUDIO_CAP_SHARE * totalMbps);
  return Math.max(totalMbps - audioMbps, totalMbps * MIN_VIDEO_SHARE);
}

function bitsPerPixel(videoMbps: number | null, codec: QualityCodec, height: QualityHeight): number | null {
  if (videoMbps === null) return null;
  return (videoMbps * 1_000_000 * CODEC_EFFICIENCY[codec]) / (PIXELS_PER_FRAME[height] * FRAME_RATE);
}

// ---------------------------------------------------------------------------
// Flag patterns
// ---------------------------------------------------------------------------

/**
 * Upscale markers, from the TRaSH "Upscaled" rules. An "AI" token counts only
 * next to a quality token, because "A.I." and "AI" in a film title are common.
 */
const UPSCALE_PATTERNS: readonly RegExp[] = [
  /\b(AIUS)\b/i,
  /\b(GuyZo|BR-GuyZo)\b/i,
  /\b((?:Upscale)?Re-?graded?)\b/i,
  /\b(The[ ._-]?Upscaler)\b/i,
  /\b(AI[ ._-]?Enhanced?|UPS(?:UHD)?|Upscaled?(?:[ ._-]?UHD)?|UpRez|AI[ ._-]?Upscal\w*)\b/i,
  /\bAI\b(?=[ ._-]+(?:AV1|HEVC|x265|H\.?265|2160p|4K|UHD|SDR|HDR|\d+\s?Mbps))/i,
  /(?:2160p|4K|UHD|BluRay)[ ._-]+AI\b/i,
];

/** "IMAX Enhanced" is a Dolby marketing phrase, not an upscale. */
const IMAX_ENHANCED_PATTERN = /\bIMAX[ ._-]Enhanced\b/gi;
const INTERPOLATED_PATTERN = /\b(?:rife|interpolat\w*|svp|60\s?fps|120\s?fps|50\s?fps)\b/i;
const HARDSUB_UPPER_PATTERN = /\bHC\b/;
const HARDSUB_PATTERN = /\b(?:HARDCODED|KORSUB|HC[ ._-]?SUBS?)\b/i;
const DOLBY_VISION_PATTERN = /\b(?:dv|dovi|dolby[ .]?vision)\b/i;
const HDR_BASE_PATTERN = /\bHDR(?:10)?(?:\+|plus)?\b/i;
const HULU_PATTERN = /\bhulu\b/i;
const WEB_ANY_PATTERN = /\bweb(?:[ ._-]?(?:dl|rip))?\b/i;
const REMUX_PATTERN = /\b(?:bd|br|uhd)?[ ._-]?remux\b/i;
const DOWNSCALED_4K_PATTERN = /\b(?:DS4K|4K[ ._-]?to[ ._-]?1080|from[ ._-]?4K|2160p[ ._-]?to[ ._-]?1080p)\b/i;
const REPACK_PATTERN = /\b(?:repack\d?|proper\d?|rerip)\b/i;
const HYBRID_PATTERN = /\bhybrid\b/i;

type Source = "remux" | "bluray" | "webdl" | "webrip" | "web" | "bdrip" | "hdtv" | "dvd" | "none";

const BLURAY_PATTERN = /\b(?:blu[ ._-]?ray|bluray|bd(?:remux)?|uhd[ ._-]?bd)\b/i;
const WEBDL_PATTERN = /\bweb[ ._-]?dl\b|\bwebdl\b/i;
const WEBRIP_PATTERN = /\bweb[ ._-]?rip\b/i;
const WEB_BARE_PATTERN = /\bweb\b/i;
const BDRIP_PATTERN = /\b(?:bd|br)[ ._-]?rip\b/i;
const HDTV_PATTERN = /\b(?:hd|pd)[ ._-]?tv\b/i;
const DVD_PATTERN = /\bdvd(?:[ ._-]?rip)?\b/i;

/** Points per source. Exclusive: a release has one source, the first pattern that matches. */
const SOURCE_RULES: Readonly<Record<Source, { points: number; label: string }>> = {
  remux: { points: 120, label: "remux" },
  bluray: { points: 60, label: "bluray" },
  webdl: { points: 60, label: "WEB-DL" },
  webrip: { points: 10, label: "WEBRip" },
  web: { points: 30, label: "WEB" },
  bdrip: { points: -20, label: "BDRip" },
  hdtv: { points: -60, label: "HDTV" },
  dvd: { points: -150, label: "DVD" },
  none: { points: -30, label: "untagged" },
};

const HDR10_PLUS_PATTERN = /\bHDR10(?:\+|[ ._-]?plus)/i;
const HDR10_PLUS_PATTERN_ALL = /\bHDR10(?:\+|[ ._-]?plus)/gi;
const HDR_FALLBACK_PATTERN = /\bHDR(?:10)?\b/i;
/** Atmos, lossless and DTS-HD / DTS-X tracks: the audio tier that earns the top bonus. */
const AUDIO_TOP_PATTERN = /\btrue[ ._-]?hd\b|\batmos\b|\bdts[ ._-]?(?:hd|x|ma)\b|\bflac\b|\blpcm\b/i;
/** Lossy but still respectable tracks. */
const AUDIO_MID_PATTERN = /\bddp|\bdd\+|e[ ._-]?ac[ ._-]?3|dolby[ ._-]?digital[ ._-]?plus|\bdts\b/i;

/**
 * Patterns use \b, and \b treats "_" as a word character, which would break
 * "WEB_DL" and "x264_GROUP". Underscores are read as spaces for every flag
 * and source test. Group names keep their underscores ("Nep_Blanc"), so group
 * matching works from the raw title instead.
 */
function scanText(raw: string): string {
  return raw.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Groups and titles
// ---------------------------------------------------------------------------

const EXTENSION_PATTERN = /\.(?:mkv|mp4|avi|m4v|webm)$/i;
const BRACKETED_TAIL_PATTERN = /^\[(.+)\]$/;
const BRACKETED_GROUP_PATTERN = /\[([^\]]+)\]/g;

/**
 * Names that could be the release group, most specific first.
 *
 * The group is what follows the last dash, but multi-word groups such as
 * "Half-Baked" or "Okay-Subs" contain dashes too, so every dash-delimited tail
 * is a candidate. A bracketed group such as "[YTS.MX]" yields both the whole
 * name and its first dotted part, so "YTS" matches the list.
 */
function groupCandidates(title: string): string[] {
  const stem = title.trim().replace(EXTENSION_PATTERN, "");
  const names: string[] = [];
  const parts = stem.split("-");
  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(i).join("-").trim();
    const bracketed = BRACKETED_TAIL_PATTERN.exec(tail);
    names.push(...(bracketed ? bracketNames(bracketed[1]) : [tail]));
  }
  for (const match of stem.matchAll(BRACKETED_GROUP_PATTERN)) names.push(...bracketNames(match[1]));
  return names.filter((name) => name.length > 0);
}

function bracketNames(inner: string): string[] {
  const base = inner.split(".")[0];
  return base && base !== inner ? [inner, base] : [inner];
}

interface GroupTable {
  readonly index: ReadonlyMap<string, number>;
  readonly points: readonly number[];
}

/** Lower-cased name to its best (lowest-numbered) tier. */
function buildGroupTable(tiers: readonly (readonly string[])[], points: readonly number[]): GroupTable {
  const index = new Map<string, number>();
  tiers.forEach((names, tier) => {
    for (const name of names) {
      const key = name.toLowerCase();
      if (!index.has(key)) index.set(key, tier);
    }
  });
  return { index, points };
}

const REMUX_TABLE = buildGroupTable(REMUX_GROUP_TIERS, GROUP_TIER_POINTS.remux);
const UHD_TABLE = buildGroupTable(UHD_BLURAY_GROUP_TIERS, GROUP_TIER_POINTS.uhdBluray);
const HD_TABLE = buildGroupTable(HD_BLURAY_GROUP_TIERS, GROUP_TIER_POINTS.hdBluray);
const WEB_TABLE = buildGroupTable(WEB_GROUP_TIERS, GROUP_TIER_POINTS.web);
const ANIME_BLURAY_TABLE = buildGroupTable(ANIME_BLURAY_GROUP_TIERS, GROUP_TIER_POINTS.animeBluray);
const ANIME_WEB_TABLE = buildGroupTable(ANIME_WEB_GROUP_TIERS, GROUP_TIER_POINTS.animeWeb);

function lowerCaseSet(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map((name) => name.toLowerCase()));
}

const LQ_SET = lowerCaseSet(LQ_GROUPS);
const ANIME_LQ_SET = lowerCaseSet(ANIME_LQ_GROUPS);

interface NamedTier {
  readonly name: string;
  readonly tier: number;
}

function findTier(table: GroupTable, names: readonly string[]): NamedTier | null {
  let best: NamedTier | null = null;
  for (const name of names) {
    const tier = table.index.get(name.toLowerCase());
    if (tier !== undefined && (best === null || tier < best.tier)) best = { name, tier };
  }
  return best;
}

/** Returns the low-quality reason, or null when the release is not low quality. */
function lowQualityReason(names: readonly string[], text: string, anime: boolean): string | null {
  for (const name of names) {
    const key = name.toLowerCase();
    if (LQ_SET.has(key)) return `LQ group ${name}`;
    if (anime && ANIME_LQ_SET.has(key)) return `LQ group ${name}`;
  }
  return LQ_TITLE_TERMS.some((pattern) => pattern.test(text)) ? "LQ title term" : null;
}

// ---------------------------------------------------------------------------
// Score parts
// ---------------------------------------------------------------------------

interface ScorePart {
  readonly points: number;
  readonly reason: string;
}

function signed(points: number): string {
  const shown = Number.isInteger(points) ? String(points) : points.toFixed(1);
  return points > 0 ? `+${shown}` : shown;
}

function sourceOf(text: string): Source {
  if (REMUX_PATTERN.test(text)) return "remux";
  if (BLURAY_PATTERN.test(text)) return "bluray";
  if (WEBDL_PATTERN.test(text)) return "webdl";
  if (WEBRIP_PATTERN.test(text)) return "webrip";
  // A bare WEB tag with a streaming service is a direct platform rip, which is WEB-DL in all but name.
  if (WEB_BARE_PATTERN.test(text)) return streamingService(text) ? "webdl" : "web";
  if (BDRIP_PATTERN.test(text)) return "bdrip";
  if (HDTV_PATTERN.test(text)) return "hdtv";
  if (DVD_PATTERN.test(text)) return "dvd";
  return "none";
}

function isWebSource(source: Source): boolean {
  return source === "webdl" || source === "webrip" || source === "web";
}

function streamingService(text: string): string | null {
  const match = STREAMING_SERVICES.find((service) => service.pattern.test(text));
  return match ? match.name : null;
}

/** Points for group reputation, or null when the group is unknown or low quality. */
function groupPart(
  names: readonly string[],
  source: Source,
  height: QualityHeight,
  anime: boolean
): ScorePart | null {
  const expected: { table: GroupTable; label: string }[] = [];
  const known: GroupTable[] = [REMUX_TABLE, UHD_TABLE, HD_TABLE, WEB_TABLE];

  if (source === "remux") expected.push({ table: REMUX_TABLE, label: "remux" });
  else if (source === "bluray") {
    expected.push(
      height === 2160 ? { table: UHD_TABLE, label: "UHD Blu-ray" } : { table: HD_TABLE, label: "HD Blu-ray" }
    );
  } else if (isWebSource(source)) expected.push({ table: WEB_TABLE, label: "WEB" });

  if (anime) {
    known.push(ANIME_BLURAY_TABLE, ANIME_WEB_TABLE);
    // A remux is also a Blu-ray master, so anime Blu-ray reputation applies to both.
    if (source === "remux" || source === "bluray") expected.push({ table: ANIME_BLURAY_TABLE, label: "anime Blu-ray" });
    if (isWebSource(source)) expected.push({ table: ANIME_WEB_TABLE, label: "anime WEB" });
  }

  let best: ScorePart | null = null;
  for (const { table, label } of expected) {
    const hit = findTier(table, names);
    if (!hit) continue;
    const points = table.points[hit.tier];
    if (best === null || points > best.points) {
      best = { points, reason: `group ${hit.name} ${label} T${hit.tier + 1} ${signed(points)}` };
    }
  }
  if (best) return best;

  for (const table of known) {
    const hit = findTier(table, names);
    if (hit) {
      return {
        points: GROUP_MISMATCH_POINTS,
        reason: `group ${hit.name} is tiered for another source ${signed(GROUP_MISMATCH_POINTS)}`,
      };
    }
  }
  return null;
}

/** HDR points at 2160p. DV with an HDR10 fallback is the strongest; plain DV or HDR is the weakest. */
function hdrPart(text: string): ScorePart | null {
  const dolbyVision = DOLBY_VISION_PATTERN.test(text);
  const hdr10Plus = HDR10_PLUS_PATTERN.test(text);
  // HDR10+ is tested apart so its "HDR10" prefix is not read as a plain HDR10 fallback.
  const plainHdr = HDR_FALLBACK_PATTERN.test(text.replace(HDR10_PLUS_PATTERN_ALL, " "));
  if (dolbyVision && (plainHdr || hdr10Plus)) return { points: 30, reason: "HDR DV with an HDR10 fallback +30" };
  if (hdr10Plus) return { points: 25, reason: "HDR HDR10+ +25" };
  if (dolbyVision) return { points: 20, reason: "HDR DV +20" };
  if (plainHdr) return { points: 20, reason: "HDR HDR10 +20" };
  return null;
}

function audioPart(text: string): ScorePart | null {
  if (AUDIO_TOP_PATTERN.test(text)) return { points: 15, reason: "audio TrueHD/Atmos/DTS-HD/FLAC/LPCM +15" };
  if (AUDIO_MID_PATTERN.test(text)) return { points: 8, reason: "audio DD+/E-AC-3/DTS +8" };
  return null;
}

const FLAG_REASONS: Readonly<Record<QualityFlag, string>> = {
  upscaled: "flag upscaled: AI or upscale tag",
  interpolated: "flag interpolated: frame-rate interpolation tag",
  hardsub: "flag hardsub: hardcoded subtitles",
  starved: "flag starved: bits per pixel below 0.05 at its shown height",
  "lq-group": "flag lq-group: low-quality group or title",
  "dv-only": "flag dv-only: Dolby Vision with no HDR10 fallback on a WEB source",
  heavy: "flag heavy: bitrate above the streaming ceiling",
  remux: "flag remux",
  "downscaled-4k": "flag downscaled-4k: 1080p cut from a 4K master",
  repack: "flag repack: corrected re-release",
  hybrid: "flag hybrid",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True when the release carries any upscale marker, after the IMAX phrase is set aside. */
function isUpscaled(text: string): boolean {
  const scanned = text.replace(IMAX_ENHANCED_PATTERN, " ");
  return UPSCALE_PATTERNS.some((pattern) => pattern.test(scanned));
}

/**
 * Quality assessment for one release. Pure and deterministic.
 *
 * The effective height is decided from the bitrate at the file's own height.
 * Bits per pixel, the starved flag and the score are then recomputed at the
 * effective height, so a 4K file demoted to 1080p is judged as the 1080p
 * picture it really is.
 */
export function assessRelease(input: ReleaseQualityInput): ReleaseQuality {
  const raw = `${input.releaseTitle} ${input.fileName ?? ""}`;
  const text = scanText(raw);
  const anime = input.anime === true;
  const codec = input.codec;
  const names = [
    ...groupCandidates(input.releaseTitle),
    ...(input.fileName ? groupCandidates(input.fileName) : []),
  ];

  const videoMbps = estimateVideoMbps(input.sizeBytes, input.runtimeMinutes, text);
  const nativeBpp = bitsPerPixel(videoMbps, codec, input.height);
  const upscaled = isUpscaled(text);
  const starvedAtNative = nativeBpp !== null && nativeBpp < BPP_STARVED;

  const demoted = input.height === 2160 && (upscaled || starvedAtNative);
  const effectiveHeight: QualityHeight = demoted ? 1080 : input.height;
  const bpp = bitsPerPixel(videoMbps, codec, effectiveHeight);
  const starved = bpp !== null && bpp < BPP_STARVED;

  const interpolated = INTERPOLATED_PATTERN.test(text);
  const hardsub = HARDSUB_UPPER_PATTERN.test(text) || HARDSUB_PATTERN.test(text);
  const dvOnly =
    DOLBY_VISION_PATTERN.test(text) &&
    !HDR_BASE_PATTERN.test(text) &&
    WEB_ANY_PATTERN.test(text) &&
    !HULU_PATTERN.test(text);
  const heavy = videoMbps !== null && videoMbps > HEAVY_MBPS[input.height];
  const source = sourceOf(text);
  const service = streamingService(text);
  const lqReason = lowQualityReason(names, text, anime);
  const downscaled4k = input.height === 1080 && DOWNSCALED_4K_PATTERN.test(text);
  const repack = REPACK_PATTERN.test(text);
  const hybrid = HYBRID_PATTERN.test(text);

  const flags: QualityFlag[] = [];
  if (upscaled) flags.push("upscaled");
  if (interpolated) flags.push("interpolated");
  if (hardsub) flags.push("hardsub");
  if (starved) flags.push("starved");
  if (lqReason) flags.push("lq-group");
  if (dvOnly) flags.push("dv-only");
  if (heavy) flags.push("heavy");
  if (source === "remux") flags.push("remux");
  if (downscaled4k) flags.push("downscaled-4k");
  if (repack) flags.push("repack");
  if (hybrid) flags.push("hybrid");

  const flagged = upscaled || interpolated || hardsub || dvOnly || starved;
  const tier: 1 | 2 | 3 = flagged ? 1 : heavy ? 2 : 3;

  const detailShare =
    bpp === null ? UNKNOWN_DETAIL_SHARE : Math.min(1, Math.max(0, (bpp - BPP_STARVED) / (BPP_SATURATED - BPP_STARVED)));
  const detail = detailShare * DETAIL_POINTS;

  const reasons: string[] = [];
  if (demoted) {
    if (upscaled && starvedAtNative) reasons.push("2160p upscaled and starved at 4K, ranked as 1080p");
    else if (upscaled) reasons.push("2160p upscaled, ranked as 1080p");
    else reasons.push(`2160p starved at 4K (bpp ${nativeBpp?.toFixed(3)}), ranked as 1080p`);
  }

  const parts: ScorePart[] = [];
  if (bpp === null || videoMbps === null) {
    parts.push({ points: detail, reason: `bitrate unknown, detail neutral ${signed(detail)}` });
  } else {
    parts.push({
      points: detail,
      reason: `bpp ${bpp.toFixed(3)} at ${effectiveHeight}p `
        + `(${CODEC_LABEL[codec]} ${videoMbps.toFixed(1)} Mbit/s) ${signed(detail)}`,
    });
  }

  const sourceRule = SOURCE_RULES[source];
  parts.push({ points: sourceRule.points, reason: `source ${sourceRule.label} ${signed(sourceRule.points)}` });

  if (lqReason) {
    parts.push({ points: LQ_GROUP_POINTS, reason: `${lqReason} ${signed(LQ_GROUP_POINTS)}` });
  } else {
    const group = groupPart(names, source, input.height, anime);
    if (group) parts.push(group);
  }

  if (effectiveHeight === 2160) {
    const hdr = hdrPart(text);
    if (hdr) parts.push(hdr);
  }

  const audio = audioPart(text);
  if (audio) parts.push(audio);
  if (repack) parts.push({ points: 10, reason: "repack +10" });
  if (hybrid) parts.push({ points: 10, reason: "hybrid +10" });
  if (service && isWebSource(source)) parts.push({ points: 15, reason: `streaming service ${service} +15` });
  if (downscaled4k) parts.push({ points: 20, reason: "downscaled 4K on 1080p +20" });

  for (const flag of flags) reasons.push(FLAG_REASONS[flag]);
  for (const part of parts) reasons.push(part.reason);

  const total = parts.reduce((sum, part) => sum + part.points, 0);
  return {
    effectiveHeight,
    tier,
    score: Math.round(total * 10) / 10,
    flags,
    videoMbps,
    bpp,
    reasons,
  };
}

/**
 * Array.sort comparator: negative when `a` is the better release.
 *
 * Order: effective height, then tier, then score, then video bitrate (an
 * unknown bitrate sorts last). Equal releases compare as 0.
 */
export function compareReleaseQuality(a: ReleaseQuality, b: ReleaseQuality): number {
  if (a.effectiveHeight !== b.effectiveHeight) return b.effectiveHeight - a.effectiveHeight;
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.score !== b.score) return b.score - a.score;
  if (a.videoMbps === b.videoMbps) return 0;
  if (a.videoMbps === null) return 1;
  if (b.videoMbps === null) return -1;
  return b.videoMbps - a.videoMbps;
}

/**
 * Torrentio index client for the PREMIUM debrid tier.
 *
 * Torrentio is keyed by IMDb id, not TMDB id — callers must resolve imdb id
 * first (see `resolveImdbId`). We always request Torrentio with the owner's
 * Real-Debrid token baked into the path's config segment
 * (`/realdebrid=<token>/stream/...`) so Torrentio itself does the
 * add/select/cache-check server-side and only ever surfaces INSTANT (cached)
 * results — the deprecated `/torrents/instantAvailability` RD endpoint is
 * never used (see realdebrid.ts for why).
 *
 * Real fetch, bounded timeout, never throws — callers get `[]` on any failure
 * (network, malformed JSON, TMDB miss) so a Torrentio outage never breaks the
 * existing embed roster. The list also says how the index answered (see
 * `torrentioOutcomeOf`), so `[]` from a failed request is not mistaken for a
 * title that has no releases.
 *
 * CANDIDATE SELECTION — a popular title's RD-configured Torrentio response
 * typically has 150-224 fully cached streams, but they skew heavily toward
 * 4K HEVC/HDR remuxes (often MKV): a flat "top 8 by resolution" truncation
 * (the old behavior) can miss every browser-safe H.264 release entirely, even
 * though 14-37 usually exist per title. So candidates are now: parsed, judged
 * for picture quality by `assessRelease` (release-quality.ts) with the title's
 * runtime, bucketed by compatibility and effective resolution (an upscaled or
 * starved 4K is a 1080p candidate), ranked within each class by that quality,
 * then capped PER CLASS (`PER_CLASS_CAP`) so the returned pool always has
 * representation across classes instead of being dominated by whichever class
 * happens to have the most raw entries. Native 720p is kept only as an
 * availability fallback when no higher native release survives.
 *
 * CONTAINER — MKV/WebM candidates are kept in the resolved inventory. No
 * browser opens them directly (see `isBrowserPlayableContainer`), but they are
 * no longer dead: the app remuxes them to fMP4 with a stream copy, which
 * preserves resolution and codec, so a 4K MKV plays at 4K. `container` and
 * `codec` are carried to the client, where `sourceDelivery` turns them into
 * direct / remux / unavailable. Container therefore affects DELIVERY COST
 * only; the codec is what decides which browsers can play a release at all,
 * and it alone drives `compat`.
 */
import { tmdb } from "@/lib/tmdb";
import { cachedFetch } from "@/lib/server-cache";
import type { TitleFacts } from "../release-identity";
import { identify } from "./title-gate";
import type { MediaType } from "../types";
import { isMoviePackRelease } from "../source-facts";
import { isCaptureRelease } from "../release-scorer";
import { assessRelease, compareReleaseQuality, type ReleaseQuality } from "../release-quality";
import { isUnwantedRelease, parseReleaseAudio, releaseAudioKind } from "../release-language";
import { tvQueryIndex } from "../tv-index";

export { isMoviePackRelease };

const TORRENTIO_BASE = (process.env.TORRENTIO_BASE || "https://torrentio.strem.fun").replace(
  /\/+$/,
  ""
);

export type ReleaseCodec = "h264" | "hevc" | "av1" | "unknown";
export type ReleaseContainer = "mp4" | "mkv" | "webm" | "mov" | "unknown";
export type ReleaseCompat = "native" | "safari";
export type ReleaseAudioCodec =
  | "aac"
  | "ac3"
  | "eac3"
  | "dts"
  | "truehd"
  | "flac"
  | "opus"
  | "mp3"
  | "unknown";

export interface ParsedRelease {
  /** 2160, 1080, some lower value, or null when no resolution token was found. */
  resolutionHeight: number | null;
  codec: ReleaseCodec;
  audioCodec: ReleaseAudioCodec;
  multiAudio: boolean;
  hdr: boolean;
  container: ReleaseContainer;
  /**
   * "native" = plays in any Chromium/Firefox browser: H.264 progressive
   * MP4/MOV with no HDR, OR AV1-in-MP4/MOV (AV1 has been Chrome/Firefox-
   * native for years; it is NOT reliably Safari-playable — Safari's AV1
   * support is recent/partial and absent on iOS entirely as of this
   * writing, the opposite situation from HEVC). "safari" = HEVC, HDR/DV, or
   * MKV/WebM — Chrome typically can't decode/demux this; only Safari
   * (AVFoundation) reliably can for the MP4/MOV cases.
   *
   * NOTE (honesty caveat): this value is ALSO set to "safari" for MKV/WebM
   * releases purely for backward-compat with the sibling TorBox tier's own
   * file-eligibility heuristic (torbox.ts calls `parseReleaseTitle` directly
   * on actual resolved filenames) — but MKV is NOT actually Safari-playable;
   * no browser, including Safari, can play the MKV container. Any caller
   * that surfaces a source straight to a `<video>` tag (this module's own
   * `isBrowserPlayableContainer`, consumed by source-quality.ts's
   * `isSourcePlayableHere`) MUST check `container` separately — a MKV/WebM
   * release is never "playable somewhere" in the native sense and is
   * production-unavailable while the legacy transcoder is disabled. Conversely, a
   * caller that cares about AV1-on-old-Safari specifically should gate on
   * `codec === "av1"` itself (a browser/version capability check) rather
   * than assuming `compat === "native"` means every engine can decode it —
   * this field only encodes the Chrome/Firefox-vs-Safari split, not every
   * individual browser/version's real decode matrix.
   */
  compat: ReleaseCompat;
}

export interface DebridCandidate extends ParsedRelease {
  /** First line of the release title/name (drop the seeders/size/source footer Torrentio appends). */
  title: string;
  /**
   * 4K/1080p are the preferred premium rungs. Native 720p is retained only
   * as an availability fallback when no browser-playable higher rung exists.
   */
  resolutionHeight: 720 | 1080 | 2160;
  infoHash?: string;
  /** 0-based file index within the torrent (Stremio addon protocol convention). */
  fileIdx?: number;
  /** The name of that file, as the index gives it: a service that lists a torrent's files in its own order is asked for the file by this. */
  fileName?: string;
  /** Already resolved to a direct-playable link by the RD-configured Torrentio index (path 2a). */
  url?: string;
  /** Parsed from Torrentio's "👤 N" seeders footer — 0 when absent. Real-world demand/health signal used for in-class ranking. */
  seeders: number;
  /** Selected file size from Torrentio's footer, when present. */
  sizeBytes?: number;
  /** A dub, or a picture with another language's subtitles over it: kept only when nothing else exists. */
  unwantedAudio?: boolean;
  /** Several audio languages in one file: the original is in there, but only a remux can choose it. */
  severalAudio?: boolean;
  /** Nothing in its name says outright that it is the title: kept, behind the releases that do say so. */
  unverified?: boolean;
  /**
   * The picture this release really holds, judged from its name, size and the
   * title's runtime (see release-quality.ts). Its `effectiveHeight` is also the
   * `resolutionHeight` above, so an upscale competes at the height it shows.
   */
  quality?: ReleaseQuality;
}

interface TorrentioStreamRaw {
  name?: string;
  title?: string;
  infoHash?: string;
  fileIdx?: number;
  url?: string;
  behaviorHints?: { filename?: string; bingeGroup?: string };
}

interface TorrentioResponseRaw {
  streams?: TorrentioStreamRaw[];
}

/**
 * Codec tokens. The separator between "H" and the number is `[.\s_-]?` rather
 * than `\.?` because Torrentio's title line has already had dots flattened to
 * spaces by the time we see it: real cached releases arrive as
 * "Dark S01E01 Secrets 2160p NF WEB-DL DUAL DDP5 1 Atmos H 265-Kitsune", and
 * "H 265" matched nothing. An unrecognised codec at 4K defaults to "safari"
 * (see `compat` below), so every miss here is a 4K row silently marked
 * unavailable — including the H 264 ones, which would have played.
 */
const HEVC_PATTERN = /x\s?265|hevc|h[.\s_-]?265/i;
const AV1_PATTERN = /\bav0?1\b/i;
const H264_PATTERN = /x\s?264|h[.\s_-]?264|avc1?/i;
const TRUEHD_AUDIO_PATTERN = /\btrue[ ._-]?hd\b/i;
const DTS_AUDIO_PATTERN = /\bdts(?:[ ._-]?(?:hd|x|ma))?\b/i;
const EAC3_AUDIO_PATTERN = /\be[ ._-]?ac[ ._-]?3\b|\bddp(?:\d|\b)|dolby[ ._-]?digital[ ._-]?plus/i;
const AC3_AUDIO_PATTERN = /\bac[ ._-]?3\b|\bdd(?:2|5|7)(?:[ ._-]?1)?\b|dolby[ ._-]?digital\b/i;
const FLAC_AUDIO_PATTERN = /\bflac\b/i;
const OPUS_AUDIO_PATTERN = /\bopus\b/i;
const AAC_AUDIO_PATTERN = /\baac(?:2|5|7)?(?:[ ._-]?1)?\b/i;
const MP3_AUDIO_PATTERN = /\bmp3\b/i;
const MULTI_AUDIO_PATTERN = /\bdual(?:[ ._-]?audio)?\b|\bmulti(?:[ ._-]?audio)?\b|\b2[ ._-]?audio\b/i;
const HDR_PATTERN = /\bhdr(?:10\+?)?\b|dolby\s?vision|\bdv\b/i;
const MKV_PATTERN = /\.mkv\b|\bmkv\b/i;
const MP4_PATTERN = /\.mp4\b|\bmp4\b/i;
const WEBM_PATTERN = /\.webm\b|\bwebm\b/i;
const MOV_PATTERN = /\.mov\b|\bmov\b/i;
/** REMUX releases are near-universally packaged as MKV even when the title never says ".mkv" literally — LIVE DATA confirms many 4K releases are exactly this shape. Only applied when no explicit container token was already found. */
const REMUX_PATTERN = /\bremux\b/i;
/**
 * `2160p` is a real resolution tag. A bare `4K` is a marketing word, and it
 * turns up in names that carry an explicit 1080p tag as well — a live roster
 * for Inception offers "Inception - Directors Cut 2010 Eng Ita Multi-Subs 4K
 * 1080p", which is a 1080p file. Reading that as 2160p is not a cosmetic
 * mislabel: it is the top-ranked member of the native-2160 class (MP4 beats
 * the MKV alternative on container), so it takes the one 4K roster slot a
 * Chrome session can actually use and leaves the genuine 4K AV1 release
 * sitting behind it unused.
 */
const RESOLUTION_2160_EXPLICIT_PATTERN = /2160p/i;
const RESOLUTION_4K_MARKETING_PATTERN = /\b4k\b/i;
const RESOLUTION_1080_PATTERN = /1080p/i;
const RESOLUTION_ANY_PATTERN = /(\d{3,4})p/i;
const SEEDERS_PATTERN = /👤[^\d]*(\d+)/;
const SIZE_PATTERN = /(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB)\b/i;
/** Torrentio's footer size is the selected file; a size in the release name is often the whole pack. */
const FILE_SIZE_PATTERN = /💾\s*(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB)\b/i;
/* The capture pattern moved to release-scorer.ts so the drop below and the
   ranking penalty there cannot drift apart. It is slightly broader now
   (hdtc, and separators inside telesync/telecine/camrip). */
const MOVIE_NON_FEATURE_PATTERN =
  /\b(?:featurettes?|bonus(?:es)?|extras?|soundtracks?|deleted[ ._-]?scenes?|imdb[ ._-]*top[ ._-]*\d+)\b/i;

const TEN_BIT_PATTERN = /\b10[\s._-]?bits?\b/i;
const HI10_PATTERN = /\bhi10p?\b/i;

/**
 * 10-bit H.264 ("Hi10P", common in anime encodes) is decodable by no browser.
 * Only an explicit AVC/x264 tag (or "Hi10") counts: plain "10bit" releases
 * are usually HEVC, which plays where the device supports it.
 */
export function isHi10AvcRelease(text: string): boolean {
  if (HI10_PATTERN.test(text)) return true;
  return TEN_BIT_PATTERN.test(text) && H264_PATTERN.test(text) && !HEVC_PATTERN.test(text) && !AV1_PATTERN.test(text);
}

/**
 * Pure title/filename classifier — no network. Exported for unit testing
 * against real sample release-name conventions.
 */
export function parseReleaseTitle(text: string): ParsedRelease {
  const t = text || "";

  let resolutionHeight: number | null;
  // Explicit 2160p wins outright; an explicit 1080p beats a bare "4K"; a bare
  // "4K" with no competing tag is still the best evidence available.
  if (RESOLUTION_2160_EXPLICIT_PATTERN.test(t)) resolutionHeight = 2160;
  else if (RESOLUTION_1080_PATTERN.test(t)) resolutionHeight = 1080;
  else if (RESOLUTION_4K_MARKETING_PATTERN.test(t)) resolutionHeight = 2160;
  else {
    const m = t.match(RESOLUTION_ANY_PATTERN);
    resolutionHeight = m ? Number(m[1]) : null;
  }

  const codec: ReleaseCodec = HEVC_PATTERN.test(t)
    ? "hevc"
    : AV1_PATTERN.test(t)
      ? "av1"
      : H264_PATTERN.test(t)
        ? "h264"
        : "unknown";

  // Order is significant: TrueHD/DTS/E-AC-3 names often also contain generic
  // Dolby/DD tokens. Preserve the most specific codec evidence available.
  const audioCodec: ReleaseAudioCodec = TRUEHD_AUDIO_PATTERN.test(t)
    ? "truehd"
    : DTS_AUDIO_PATTERN.test(t)
      ? "dts"
      : EAC3_AUDIO_PATTERN.test(t)
        ? "eac3"
        : AC3_AUDIO_PATTERN.test(t)
          ? "ac3"
          : FLAC_AUDIO_PATTERN.test(t)
            ? "flac"
            : OPUS_AUDIO_PATTERN.test(t)
              ? "opus"
              : AAC_AUDIO_PATTERN.test(t)
                ? "aac"
                : MP3_AUDIO_PATTERN.test(t)
                  ? "mp3"
                  : "unknown";
  const multiAudio = MULTI_AUDIO_PATTERN.test(t);

  const hdr = HDR_PATTERN.test(t);
  let container: ReleaseContainer;
  if (MKV_PATTERN.test(t)) container = "mkv";
  else if (MP4_PATTERN.test(t)) container = "mp4";
  else if (WEBM_PATTERN.test(t)) container = "webm";
  else if (MOV_PATTERN.test(t)) container = "mov";
  else if (REMUX_PATTERN.test(t)) container = "mkv";
  else container = "unknown";

  // HEVC/HDR/DV/MKV/WebM make this release a Chrome-decode risk — 4K HDR
  // remuxes are almost always HEVC-in-MKV and only decode in Safari. (MKV
  // itself isn't actually Safari-playable either — see the `compat` doc
  // comment above and `isBrowserPlayableContainer` below, which is the real
  // gate callers surfacing a source directly must use.)
  //
  // AV1 is the OPPOSITE case from HEVC: AV1-in-MP4/MOV is Chrome/Firefox-
  // native (software/hardware AV1 decode has been standard there for years)
  // and NOT reliably Safari-playable (Safari's AV1 support is recent/
  // partial, e.g. Apple Silicon Macs only, no iOS Safari support at all as
  // of this writing) — so it must NOT be folded into the same "safari"
  // bucket as HEVC. `codec: "av1"` is preserved either way so a Safari-
  // specific AV1 decode gate (browser/version capability check, not a
  // container/codec-class heuristic) can still be layered on top of this by
  // whatever ranks/gates sources for playback.
  // Compat is the browser-decode hint. HEVC/HDR/MKV/WebM → "safari" (only
  // Safari/HW-Chrome decode them). Additionally, at 4K (2160) with an UNKNOWN
  // codec, default to "safari" — the overwhelming majority of 4K releases are
  // HEVC/HDR (H.264 4K is essentially nonexistent), so treating an untagged 4K
  // release as "native" would mislead Chrome users into picking a source that
  // won't play. This matches the live data: 95%+ of 4K is HEVC. At 1080p,
  // unknown stays "native" (most 1080p is H.264, and the "unknown" tier was
  // explicitly kept eligible — see isBrowserPlayableContainer).
  //
  // Container is deliberately NOT part of this. It used to be: MKV and WebM
  // forced "safari", which put every H.264/AV1 MKV in the same bucket as an
  // x265 HDR remux and sank it behind `sortCandidates`/`selectTopPerClass`.
  // The result was visible on nearly every title - exactly ONE 4K row, the
  // HEVC one, because the decodable 4K releases were all MKV and therefore
  // classified as Safari-only. Since a stream copy now makes MKV playable
  // everywhere (see sourceDelivery/remux), the container decides HOW a source
  // is delivered, not WHO can watch it. Only the codec constrains that.
  const compat: ReleaseCompat =
    codec === "h264" || codec === "av1"
      ? "native"
      : codec === "hevc"
        ? "safari"
        : // Unknown codec — fall back to the release-shape heuristics, unchanged.
          hdr || resolutionHeight === 2160
          ? "safari"
          : "native";

  return {
    resolutionHeight,
    codec,
    audioCodec,
    multiAudio,
    hdr,
    container,
    compat,
  };
}

/**
 * Keep 720p in the candidate inventory as a last-resort native fallback.
 * Anything lower (or unresolved) remains out of scope.
 */
export function isEligibleDebridQuality(height: number | null): height is 720 | 1080 | 2160 {
  return height === 720 || height === 1080 || height === 2160;
}

/**
 * Buckets heights the release scene uses besides the three rungs: 4:3 Blu-ray
 * rips of older anime are "800p", which is HD and belongs with 720p.
 */
export function debridHeightBucket(height: number | null): number | null {
  if (height != null && height > 720 && height < 900) return 720;
  return height;
}

/**
 * Explicit stereoscopic layout tokens. A release carrying one of these stores
 * two eye views inside a normal-looking 1080p frame, so it plays as a squashed
 * side-by-side (or over-under) pair in any ordinary player.
 */
const STEREO_LAYOUT_PATTERN =
  /\b(?:h[-. _]?sbs|full[-. _]?sbs|half[-. _]?sbs|sbs|h[-. _]?ou|half[-. _]?ou|full[-. _]?ou|over[-. _]?under|side[-. _]?by[-. _]?side|anaglyph|vr180|180vr|mvc)\b/i;
/** Russian scene descriptions used by the same stereoscopic releases. */
const STEREO_CYRILLIC_PATTERN = /стереопара|горизонтальная стерео|вертикальная стерео/i;
/** A bare "3D" tag that sits in the RELEASE section, i.e. after the year. */
const STEREO_3D_AFTER_YEAR_PATTERN = /\b(?:19|20)\d{2}\b.*?\b3[-. _]?d\b/i;
/** "3D" immediately qualifying a source token, e.g. "... 3D BluRay 1080p". */
const STEREO_3D_BEFORE_SOURCE_PATTERN =
  /\b3[-. _]?d\b[ ._-]*(?:blu[-. _]?ray|bd[-. _]?rip|bdrip|brrip|web[-. _]?dl|webrip|hdtv|remux|x\s?26[45]|h[.\s_-]?26[45]|hevc)/i;

/**
 * True when a release is stereoscopic 3D / VR rather than ordinary flat video.
 *
 * Measured against live Torrentio data: 12 of 134 candidates across five
 * popular films were 3D — 4 of 11 for Gravity — and `parseReleaseTitle` reported
 * every one of them as a plain `height=1080 codec=h264`, indistinguishable from
 * a normal release. They therefore won native slots and played back as the
 * reported "two images side by side" video.
 *
 * The bare-"3D" rules are deliberately positional rather than a blanket match,
 * so a film whose actual TITLE contains 3D ("Spy Kids 3-D: Game Over") is not
 * wrongly excluded — its "3D" precedes the year and qualifies no source token.
 * A false positive only drops one candidate from a pool; a false negative hands
 * the viewer an unwatchable stream, so the rules lean toward catching layout
 * tokens outright.
 */
export function isStereoscopicRelease(text: string): boolean {
  const t = text || "";
  if (STEREO_LAYOUT_PATTERN.test(t)) return true;
  if (STEREO_CYRILLIC_PATTERN.test(t)) return true;
  if (STEREO_3D_AFTER_YEAR_PATTERN.test(t)) return true;
  return STEREO_3D_BEFORE_SOURCE_PATTERN.test(t);
}

/**
 * Bits per pixel below which a file holds no picture worth a resolve attempt,
 * whatever its name claims. release-quality.ts flags a file below its own
 * `BPP_STARVED`; this lower floor is the point where the picture is blocks.
 */
const STARVED_FLOOR_BPP = 0.02;

/**
 * Drops starved files whenever another release of their class is not starved.
 * Without a runtime or a size there is no bitrate, so nothing is dropped. A
 * class whose releases are all starved keeps them, because one of them may be
 * the only copy of the title.
 */
export function filterStarvedCandidates(candidates: DebridCandidate[]): DebridCandidate[] {
  const isStarved = (candidate: DebridCandidate) =>
    candidate.quality?.bpp != null && candidate.quality.bpp < STARVED_FLOOR_BPP;
  const soundClasses = new Set(
    candidates.filter((candidate) => !isStarved(candidate)).map(candidateClass)
  );
  return candidates.filter((candidate) => !isStarved(candidate) || !soundClasses.has(candidateClass(candidate)));
}

/**
 * The real, absolute NATIVE browser-playability gate — MKV plays in NO
 * browser (not even Safari) and WebM movie releases are exotic/unsupported
 * enough to treat the same way. MP4/MOV are the only containers a `<video>`
 * tag can consume directly; "unknown" (no explicit container token in the
 * title) is kept eligible since the overwhelming majority of untagged
 * WEB-DL/HDTV encodes are MP4 in practice — never fabricated as literally
 * "mp4", just not excluded.
 *
 * NOTE: this is not used to drop inventory candidates here. The canonical
 * consumer is `isSourcePlayableHere` in source-quality.ts, which folds the
 * container and codec checks into one client-facing direct-play answer.
 */
export function isBrowserPlayableContainer(container: ReleaseContainer): boolean {
  return container !== "mkv" && container !== "webm";
}

/** File extension on the unrestricted CDN URL is ground truth. */
export function containerFromDirectUrl(url: string): ReleaseContainer | undefined {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
    if (/\.mkv$/.test(pathname)) return "mkv";
    if (/\.webm$/.test(pathname)) return "webm";
    if (/\.mp4$/.test(pathname)) return "mp4";
    if (/\.mov$/.test(pathname)) return "mov";
  } catch {
    /* opaque URL stays unknown */
  }
  return undefined;
}

/**
 * Title heuristics (especially a bare "REMUX") lose to the actual file.
 * Switching Poseidon used to remux a playable MP4 because the torrent name
 * said REMUX/MKV.
 */
export function effectiveReleaseContainer(
  url: string,
  parsed?: ReleaseContainer
): ReleaseContainer | undefined {
  const fromUrl = containerFromDirectUrl(url);
  if (fromUrl) return fromUrl;
  if (parsed && parsed !== "unknown") return parsed;
  return parsed;
}

/**
 * Real-Debrid rows the player can attach as progressive files. MKV/WebM and
 * DTS/TrueHD/FLAC always take the remux worker, which is why switching to
 * Poseidon/Kronos felt like "packaging." Those files stay out of the RD
 * roster so every debrid chip starts immediately.
 */
export function isDirectPlayDebridRelease(
  container?: ReleaseContainer,
  audioCodec?: ReleaseAudioCodec
): boolean {
  if (container && !isBrowserPlayableContainer(container)) return false;
  if (audioCodec === "dts" || audioCodec === "truehd" || audioCodec === "flac") {
    return false;
  }
  return true;
}

/** Parsed from Torrentio's "👤 N" seeders footer (see sample titles in the test suite) — 0 when absent, never thrown on malformed text. */
export function parseSeeders(text: string): number {
  const m = (text || "").match(SEEDERS_PATTERN);
  return m ? Number(m[1]) : 0;
}

/** Parse Torrentio's selected-file size footer into bytes. */
export function parseSizeBytes(text: string): number | null {
  const match = (text || "").match(FILE_SIZE_PATTERN) ?? (text || "").match(SIZE_PATTERN);
  if (!match?.[1] || !match[2]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "gib" || unit === "gb"
      ? 1024 ** 3
      : 1024 ** 2;
  const bytes = value * multiplier;
  return Number.isFinite(bytes) ? Math.round(bytes) : null;
}

function compatRank(c: DebridCandidate): number {
  return c.compat === "native" ? 0 : 1;
}

/**
 * Container order, used only as a tie-break between releases of equal picture
 * quality. MP4 and MOV play as they are. An untagged file usually does too.
 * An MKV or WebM needs a stream copy first, so it comes last.
 */
function containerRank(c: DebridCandidate): number {
  if (c.container === "mp4" || c.container === "mov") return 0;
  return c.container === "mkv" || c.container === "webm" ? 2 : 1;
}

/**
 * The quality a candidate is ordered by. Every parsed candidate has one; a
 * candidate without one is neutral: its own height, the middle tier, and the
 * score an unknown-bitrate WEB or Blu-ray release earns (half the detail points
 * plus its source points).
 */
export function candidateQuality(c: DebridCandidate): ReleaseQuality {
  return (
    c.quality ?? {
      effectiveHeight: c.resolutionHeight,
      tier: 3,
      score: 260,
      flags: [],
      videoMbps: null,
      bpp: null,
      reasons: [],
    }
  );
}

/**
 * Order inside one class (same compatibility and height). A release that names
 * the title comes first, then one in the original language alone, then the
 * better picture (see `compareReleaseQuality`). After that come MP4/MOV, then
 * the seeders, then the bigger file.
 */
function compareWithinClass(a: DebridCandidate, b: DebridCandidate): number {
  // A release that names the title comes before one kept only because
  // nothing in its name says it is another: the second is a guess, and a
  // wrong guess plays another film under this one's poster.
  const verifiedDiff = (a.unverified ? 1 : 0) - (b.unverified ? 1 : 0);
  if (verifiedDiff !== 0) return verifiedDiff;
  // A release in the original language alone comes before one that only
  // contains it: played directly, a multi-language file starts on
  // whichever track its maker put first, which is usually the dub.
  const severalDiff = (a.severalAudio ? 1 : 0) - (b.severalAudio ? 1 : 0);
  if (severalDiff !== 0) return severalDiff;
  const qualityDiff = compareReleaseQuality(candidateQuality(a), candidateQuality(b));
  if (qualityDiff !== 0) return qualityDiff;
  const containerDiff = containerRank(a) - containerRank(b);
  if (containerDiff !== 0) return containerDiff;
  const seederDiff = b.seeders - a.seeders;
  if (seederDiff !== 0) return seederDiff;
  return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
}

/** Native-compatible releases first, then resolution, then `compareWithinClass`. */
function sortCandidates(list: DebridCandidate[]): DebridCandidate[] {
  return [...list].sort(
    (a, b) =>
      compatRank(a) - compatRank(b) ||
      b.resolutionHeight - a.resolutionHeight ||
      compareWithinClass(a, b)
  );
}

type CandidateClass =
  | "native-2160"
  | "safari-2160"
  | "native-1080"
  | "safari-1080"
  | "native-720"
  | "safari-720";

/**
 * Per-class caps for the returned candidate pool — sums to `MAX_CANDIDATES`.
 * "native-1080" gets the deepest cap ("several native 1080p" in the roster +
 * headroom for resolve-attempt fallbacks); native-2160 and safari-2160 get
 * enough depth for a fallback attempt or two without over-fetching a class
 * that's inherently scarce (native 4K) or already huge (safari 4K).
 */
const PER_CLASS_CAP: Record<CandidateClass, number> = {
  "native-2160": 5,
  // Deep enough that the 4K encodes with the most picture per frame survive
  // the quality ranking, and placeholders among them no longer exhaust the pool.
  "safari-2160": 20,
  "native-1080": 20,
  "safari-1080": 8,
  // One RD roster slot consumes this class only when no higher native slot
  // is available. Keep several candidates so validation can fall through.
  "native-720": 5,
  // Older shows and anime often exist only as 720p MKV; remux plays them.
  "safari-720": 4,
};
/** Total candidate pool bound — see module header for why this replaced a flat top-8 cut. */
const MAX_CANDIDATES = Object.values(PER_CLASS_CAP).reduce((sum, n) => sum + n, 0);

function candidateClass(c: DebridCandidate): CandidateClass {
  return `${c.compat}-${c.resolutionHeight}` as CandidateClass;
}

/**
 * Ranks the full eligible (1080p+, MKV/WebM included — see module header)
 * pool by picture quality, then keeps only the top N per class so the returned
 * roster always has representation across native/safari × 1080/2160 instead
 * of being swamped by whichever class Torrentio happens to return the most of
 * (usually 4K HEVC/HDR remuxes, often MKV).
 *
 * Container no longer gates a release. An MKV plays after a stream copy, so the
 * container only decides between releases of equal picture quality.
 */
function selectTopPerClass(candidates: DebridCandidate[]): DebridCandidate[] {
  const buckets = new Map<CandidateClass, DebridCandidate[]>();
  for (const c of candidates) {
    const key = candidateClass(c);
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  const out: DebridCandidate[] = [];
  for (const key of Object.keys(PER_CLASS_CAP) as CandidateClass[]) {
    const cap = PER_CLASS_CAP[key];
    const ranked = (buckets.get(key) ?? []).sort(compareWithinClass);
    out.push(...ranked.slice(0, cap));
  }
  return sortCandidates(out);
}

export const ANIME_ORIGINAL_LANGUAGE = "ja";
/** Shares the cache entry content-class.ts fills for the same title. */
const ORIGINAL_LANGUAGE_TTL_MS = 6 * 60 * 60 * 1000;

/** The language a title was made in, from TMDB; null when it cannot be had (dubs are then judged against English). */
export async function resolveOriginalLanguage(tmdbId: number, mediaType: MediaType): Promise<string | null> {
  try {
    const details = await cachedFetch(
      `tmdb-anime-signals:${mediaType}:${tmdbId}`,
      () => tmdb.animeSignals(mediaType, tmdbId),
      ORIGINAL_LANGUAGE_TTL_MS
    );
    return details.original_language || null;
  } catch {
    return null;
  }
}

/** TMDB -> IMDb id. Torrentio (and Real-Debrid magnets generally) are keyed by imdb id. */
export async function resolveImdbId(tmdbId: number, mediaType: MediaType): Promise<string | null> {
  try {
    const result = await tmdb.externalIds(tmdbId, mediaType);
    return result?.imdb_id || null;
  } catch {
    return null;
  }
}

export interface FetchTorrentioParams {
  imdbId: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  /** Real-Debrid token baked into the Torrentio config path segment (2a). */
  rdToken: string;
  /** The language the title was made in (ISO 639-1); English when not given. Dubs are judged against it. */
  originalLanguage?: string | null;
  /** What the title is known as: releases of another title are dropped. Not checked when absent. */
  facts?: TitleFacts | null;
  /** How long the title runs, in minutes: a file's bitrate is judged from it. Not judged when absent. */
  runtimeMinutes?: number | null;
  /** An anime title: its releases are judged against the anime release-group tables. */
  anime?: boolean;
}

export interface FetchTorrentioNoDebridParams {
  imdbId: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  originalLanguage?: string | null;
  facts?: TitleFacts | null;
  /** How long the title runs, in minutes: a file's bitrate is judged from it. Not judged when absent. */
  runtimeMinutes?: number | null;
  /** An anime title: its releases are judged against the anime release-group tables. */
  anime?: boolean;
}

/** Which title a response is being read for. */
interface WantedTitle {
  facts: TitleFacts | null;
  season?: number;
  episode?: number;
}

/** `stream/movie/<imdb>.json` or `stream/series/<imdb>:<s>:<e>.json` — the resource path, identical for the configured and un-configured endpoints. */
export function buildKindPath(params: {
  imdbId: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
}): string {
  const season = tvQueryIndex(params.season);
  const episode = tvQueryIndex(params.episode);
  return params.mediaType === "tv"
    ? `stream/series/${params.imdbId}:${season}:${episode}.json`
    : `stream/movie/${params.imdbId}.json`;
}

/** How the index answered one request. "ok" means at least one stream came back; "empty" is a valid answer that lists none. */
export type TorrentioOutcome = "ok" | "empty" | "http_error" | "timeout" | "network_error" | "bad_json";
/** Which request a fetch report is about: the Real-Debrid-configured title lookup, the un-configured one, or a Kitsu entry. */
export type TorrentioEndpoint = "configured" | "unconfigured" | "kitsu";
/** One index request as the server records it. A type alias, so it passes as an event's fields. */
export type TorrentioFetchInfo = {
  endpoint: TorrentioEndpoint;
  outcome: TorrentioOutcome;
  status?: number;
  ms: number;
  count: number;
  retried: boolean;
};

/**
 * Timings of the index request. Exported so a test can exercise a timeout or
 * the retry without waiting out the real values.
 */
export const torrentioTiming = {
  /** Abort a single index request after this long. */
  timeoutMs: 8_000,
  /** Wait this long before asking again after an answer that was not streams. */
  retryDelayMs: 1_200,
  /** A first attempt that took longer than this is not retried: the index is slow, and asking again would only double the wait. */
  noRetryAfterMs: 6_000,
};

/**
 * Where a rejection is also sent, and where each index request is reported,
 * when something is listening. This file is bundled for the browser too (the
 * player reads release names with it), so it cannot reach the server's event
 * log itself: the debrid resolver sets these.
 */
export const torrentioEvents: {
  onOtherTitleRejected: ((rejection: Record<string, unknown>) => void) | null;
  /** Called once per logical request with its final outcome. Never carries the URL or a token. */
  onFetch: ((info: TorrentioFetchInfo) => void) | null;
} = {
  onOtherTitleRejected: null,
  onFetch: null,
};

/** The outcome of the index request each returned list came from, keyed by the list itself. */
const outcomes = new WeakMap<DebridCandidate[], TorrentioOutcome>();

/** How the index answered the request that produced `list`; undefined for a list no index request produced. */
export function torrentioOutcomeOf(list: DebridCandidate[]): TorrentioOutcome | undefined {
  return outcomes.get(list);
}

/** Tags `list` with the outcome of the index request it came from. */
export function setTorrentioOutcome(list: DebridCandidate[], outcome: TorrentioOutcome): DebridCandidate[] {
  outcomes.set(list, outcome);
  return list;
}

/** True when the index could not be asked successfully. "empty" is not a failure: the index answered, and it has nothing. */
export function isTorrentioIndexFailure(outcome: TorrentioOutcome | undefined): boolean {
  return outcome === "http_error" || outcome === "timeout" || outcome === "network_error" || outcome === "bad_json";
}

/** One index request as it ended: its outcome, and the streams it listed when it answered with a list. */
interface IndexAnswer {
  outcome: TorrentioOutcome;
  status?: number;
  count: number;
  /** Set for "ok" and "empty" answers only. */
  data: TorrentioResponseRaw | null;
}

/** Streams listed by an index body, or null when the body is not an index answer at all. */
function indexStreamCount(body: unknown): number | null {
  const streams = (body as TorrentioResponseRaw | null)?.streams;
  return Array.isArray(streams) ? streams.length : null;
}

/** The outcome of a request that ended with an error. Timeouts and aborts are the index being too slow; a body that will not parse is the index answering badly. */
function failureOutcome(error: unknown): TorrentioOutcome {
  if (error instanceof SyntaxError) return "bad_json";
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error";
}

/** One attempt at the index. Never throws. */
async function askIndexOnce(url: string): Promise<IndexAnswer> {
  let status: number | undefined;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(torrentioTiming.timeoutMs),
      cache: "no-store",
    });
    status = res.status;
    if (!res.ok) return { outcome: "http_error", status, count: 0, data: null };
    const body: unknown = JSON.parse(await res.text());
    const count = indexStreamCount(body);
    if (count === null) return { outcome: "bad_json", status, count: 0, data: null };
    return { outcome: count > 0 ? "ok" : "empty", status, count, data: body as TorrentioResponseRaw };
  } catch (error) {
    return { outcome: failureOutcome(error), status, count: 0, data: null };
  }
}

/** The same index URL under a query no cached answer carries, so the retry reaches the index rather than an edge cache. */
function withCacheBuster(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}retry=${Date.now()}`;
}

/**
 * One logical index request. An answer that is not streams is asked for once
 * more after a short wait: an empty answer is often a transient edge-cached
 * one, and an error or timeout is often momentary. A first attempt that
 * already took long is not retried. The request is reported once, with the
 * outcome that stands. Never throws.
 */
async function askIndex(url: string, endpoint: TorrentioEndpoint): Promise<IndexAnswer> {
  const started = Date.now();
  let answer = await askIndexOnce(url);
  const retried = answer.outcome !== "ok" && Date.now() - started <= torrentioTiming.noRetryAfterMs;
  if (retried) {
    await new Promise((resolve) => setTimeout(resolve, torrentioTiming.retryDelayMs));
    answer = await askIndexOnce(withCacheBuster(url));
  }
  torrentioEvents.onFetch?.({
    endpoint,
    outcome: answer.outcome,
    status: answer.status,
    ms: Date.now() - started,
    count: answer.count,
    retried,
  });
  return answer;
}

/** Candidates from an index answer, tagged with how the index answered. An answer that lists no streams yields none. */
function candidatesFrom(
  answer: IndexAnswer,
  parse: (data: TorrentioResponseRaw) => DebridCandidate[]
): DebridCandidate[] {
  return setTorrentioOutcome(answer.data ? parse(answer.data) : [], answer.outcome);
}

/**
 * Shared parse + filter (1080p+ only) + quality judgment + per-class rank/bound
 * (see `selectTopPerClass`) of a raw Torrentio response. Identical for both
 * endpoints. Each kept release is judged by `assessRelease` against the title's
 * runtime, so the bitrate it is ordered by is the one the file really has.
 * MKV/WebM candidates are KEPT (see module header) — their `container`/`codec`
 * are carried through unchanged so downstream (RD slot selection, TorBox's own
 * candidate reuse, and ultimately the client's `isSourcePlayableHere`) can
 * present them honestly without auto-selecting an incompatible release.
 */
function parseTorrentioStreams(
  data: TorrentioResponseRaw,
  configuredDebrid: boolean,
  mediaType: MediaType,
  originalLanguage?: string | null,
  wanted?: WantedTitle,
  runtimeMinutes: number | null = null,
  anime = false
): DebridCandidate[] {
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const candidates: DebridCandidate[] = [];
  const otherTitles: string[] = [];
  for (const s of streams) {
    // Configured responses contain instant `[RD+]` rows and non-cached
    // `[RD download]` rows. The latter still require a torrent transfer and
    // their resolve links can be placeholders, so they are never ready.
    if (configuredDebrid && /^\[RD download\]/i.test(s.name?.trim() ?? "")) {
      continue;
    }
    const text = `${s.title ?? ""} ${s.name ?? ""} ${s.behaviorHints?.filename ?? ""}`;
    if (isCaptureRelease(text)) continue;
    if (mediaType === "movie" && MOVIE_NON_FEATURE_PATTERN.test(text)) {
      continue;
    }
    if (mediaType === "movie" && isMoviePackRelease(text)) {
      continue;
    }
    const parsed = parseReleaseTitle(text);
    const height = debridHeightBucket(parsed.resolutionHeight);
    const sizeBytes = parseSizeBytes(text);
    if (!isEligibleDebridQuality(height)) continue;
    // Stereoscopic 3D/VR parses as ordinary 1080p but plays as a squashed
    // side-by-side pair. Never let one occupy a slot.
    if (isStereoscopicRelease(text)) continue;
    if (isHi10AvcRelease(text)) continue;

    const rawTitle = (s.title ?? s.name ?? "Unknown release").split("\n")[0]?.trim();
    // The index files releases under an id by their names, and gets some
    // wrong: a namesake, a sequel, one film out of a collection of fifty.
    const identity = wanted
      ? identify(wanted.facts, {
          mediaType,
          release: rawTitle ?? "",
          fileName: s.behaviorHints?.filename,
          season: wanted.season,
          episode: wanted.episode,
        })
      : "verified";
    if (identity === "wrong") {
      // With the file it was judged by: the release name alone does not say why.
      otherTitles.push(s.behaviorHints?.filename ? `${rawTitle ?? ""}  ||  ${s.behaviorHints.filename}` : (rawTitle ?? ""));
      continue;
    }
    const quality = assessRelease({
      releaseTitle: rawTitle ?? "",
      fileName: s.behaviorHints?.filename,
      height,
      codec: parsed.codec,
      sizeBytes,
      runtimeMinutes,
      anime,
    });
    candidates.push({
      ...parsed,
      // An upscaled or starved 4K competes at the height its picture shows, so it never takes a 4K slot.
      resolutionHeight: quality.effectiveHeight,
      title: rawTitle || "Unknown release",
      infoHash: s.infoHash ?? extractInfoHashFromResolveUrl(s.url),
      fileIdx: s.fileIdx,
      ...(s.behaviorHints?.filename ? { fileName: s.behaviorHints.filename } : {}),
      url: s.url,
      seeders: parseSeeders(text),
      ...(sizeBytes != null ? { sizeBytes } : {}),
      ...(isUnwantedRelease(text, originalLanguage) ? { unwantedAudio: true } : {}),
      ...(releaseAudioKind(parseReleaseAudio(text), originalLanguage) === "multi" ? { severalAudio: true } : {}),
      // With no names to check against, nothing is verified and nothing is ranked down for it.
      ...(identity === "unverified" && wanted?.facts ? { unverified: true } : {}),
      quality,
    });
  }
  if (otherTitles.length) {
    const rejection = {
      mediaType,
      wanted: wanted?.facts?.titles[0],
      year: wanted?.facts?.year,
      rejected: otherTitles.length,
      kept: candidates.length,
      sample: otherTitles.slice(0, 3),
    };
    console.info(JSON.stringify({ event: "debrid_other_title_rejected", ...rejection }));
    torrentioEvents.onOtherTitleRejected?.(rejection);
  }
  return selectTopPerClass(filterStarvedCandidates(inOriginalLanguage(candidates))).slice(0, MAX_CANDIDATES);
}

/**
 * Drops dubs, and releases with another language's subtitles over the
 * picture, whenever anything else was found. A French or Russian release used
 * to take a quality slot on size and seeders alone and then play as if it
 * were the original. When a dub is all there is, it is still better than
 * nothing to play.
 */
export function inOriginalLanguage<T extends { unwantedAudio?: boolean }>(candidates: T[]): T[] {
  const wanted = candidates.filter((candidate) => !candidate.unwantedAudio);
  return wanted.length > 0 ? wanted : candidates;
}

/**
 * Torrentio's RD-configured response sometimes omits `infoHash` even though
 * its resolve-proxy URL carries the same stable hash. Recover only the known
 * path shape; the credential segment is neither returned nor logged.
 */
export function extractInfoHashFromResolveUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/resolve\/realdebrid\/[^/]+\/([a-f0-9]{40})(?:\/|$)/i);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function wantedFrom(params: FetchTorrentioNoDebridParams): WantedTitle | undefined {
  return params.facts === undefined ? undefined : { facts: params.facts, season: params.season, episode: params.episode };
}

/** Fetch + parse + filter (1080p+ only; MKV/WebM kept, not dropped) + per-class rank/bound (~30-40 total, see `PER_CLASS_CAP`). Never throws. */
export async function fetchTorrentioCandidates(
  params: FetchTorrentioParams
): Promise<DebridCandidate[]> {
  try {
    const configSegment = `realdebrid=${encodeURIComponent(params.rdToken)}`;
    const kindPath = buildKindPath(params);
    const url = `${TORRENTIO_BASE}/${configSegment}/${kindPath}`;
    const answer = await askIndex(url, "configured");
    return candidatesFrom(answer, (data) =>
      parseTorrentioStreams(
        data,
        true,
        params.mediaType,
        params.originalLanguage,
        wantedFrom(params),
        params.runtimeMinutes ?? null,
        params.anime === true
      )
    );
  } catch {
    // The answer could not be read into candidates: a failed index, not one with no releases.
    return setTorrentioOutcome([], "bad_json");
  }
}

/**
 * Same as `fetchTorrentioCandidates`, keyed by a Kitsu entry and its own
 * episode number (how most anime is indexed). With no Real-Debrid token the
 * index is asked unconfigured, as `fetchTorrentioCandidatesNoDebrid` asks it.
 * Never throws.
 */
export async function fetchTorrentioKitsuCandidates(params: {
  kitsuId: number;
  episode: number;
  rdToken?: string;
  facts?: TitleFacts | null;
  runtimeMinutes?: number | null;
}): Promise<DebridCandidate[]> {
  try {
    const configSegment = params.rdToken ? `/realdebrid=${encodeURIComponent(params.rdToken)}` : "";
    const url = `${TORRENTIO_BASE}${configSegment}/stream/series/kitsu:${params.kitsuId}:${params.episode}.json`;
    const answer = await askIndex(url, "kitsu");
    // Kitsu indexes anime, whose original language is Japanese. Its episodes
    // are numbered through the whole run, so only the show is checked.
    const wanted = params.facts === undefined ? undefined : { facts: params.facts };
    return candidatesFrom(answer, (data) =>
      parseTorrentioStreams(
        data,
        Boolean(params.rdToken),
        "tv",
        ANIME_ORIGINAL_LANGUAGE,
        wanted,
        params.runtimeMinutes ?? null,
        true
      )
    );
  } catch {
    // The answer could not be read into candidates: a failed index, not one with no releases.
    return setTorrentioOutcome([], "bad_json");
  }
}

/**
 * Un-configured Torrentio scrape (NO debrid token in the URL) — hits
 * `${TORRENTIO_BASE}/stream/...` directly. Returns the same raw
 * `DebridCandidate[]` (infoHash + parsed release), but each candidate's
 * `url` is a bare magnet/undefined rather than an RD resolve-proxy link, so
 * there is never any debrid token to leak. This is the candidate source for
 * the sibling TorBox tier when Real-Debrid is NOT configured — TorBox needs
 * only the provider-agnostic infoHashes, which it then feeds to its own
 * cache-check/add/requestdl flow on api.torbox.app. NO third-party token
 * (RD or TorBox) is ever placed in this request. Never throws.
 */
export async function fetchTorrentioCandidatesNoDebrid(
  params: FetchTorrentioNoDebridParams
): Promise<DebridCandidate[]> {
  try {
    const url = `${TORRENTIO_BASE}/${buildKindPath(params)}`;
    const answer = await askIndex(url, "unconfigured");
    return candidatesFrom(answer, (data) =>
      parseTorrentioStreams(
        data,
        false,
        params.mediaType,
        params.originalLanguage,
        wantedFrom(params),
        params.runtimeMinutes ?? null,
        params.anime === true
      )
    );
  } catch {
    // The answer could not be read into candidates: a failed index, not one with no releases.
    return setTorrentioOutcome([], "bad_json");
  }
}

/**
 * Release provenance scoring: how well a release was mastered, independent of
 * whether this browser can play it.
 *
 * The in-class ranking in debrid/torrentio.ts orders releases by the picture
 * their files hold (release-quality.ts), so the score below is not on that
 * path. It describes mastering alone (provenance, audio tier, HDR, dual audio)
 * for a caller that wants that view. It deliberately says nothing about codec
 * or container: those are deliverability questions, and source-quality.ts
 * answers them with real per-browser decode probes. Scoring codec here too
 * would double-count, and would fight that layer (a naive "HEVC is better" rule
 * would promote exactly the releases Chrome cannot decode).
 *
 * `isCaptureRelease` is the part the ranking uses: cam and telesync rips are
 * dropped in `parseTorrentioStreams`, and this module holds the pattern so the
 * drop and the score cannot drift apart. The score still treats a capture as
 * worthless, because torbox.ts runs `parseReleaseTitle` on resolved filenames,
 * which never pass through that drop.
 */

import type { ReleaseAudioCodec } from "./debrid/torrentio";

export type ReleaseProvenance =
  | "remux"
  | "bluray"
  | "webdl"
  | "webrip"
  | "hdtv"
  | "dvd"
  | "capture"
  | "unknown";

/**
 * Cam, telesync and telecine. A bare `\bts\b` is deliberately absent — "ts"
 * appears in scene tags and show titles far too often to be evidence of
 * anything, and the cost of a false positive here is burying a legitimate
 * release under a four-figure penalty.
 */
const CAPTURE_PATTERN =
  /\b(?:hd[ ._-]?ts|hdcam|cam[ ._-]?rip|\bcam\b|tele[ ._-]?sync|tele[ ._-]?cine|hdtc)\b/i;

const REMUX_PATTERN = /\bremux\b/i;
const BLURAY_PATTERN = /\bblu[ ._-]?ray\b|\bbd(?:rip|mv|remux)?\b|\bbrrip\b|\bbdr\b/i;
const WEBDL_PATTERN = /\bweb[ ._-]?dl\b|\bwebdl\b|\bamzn\b|\bnf\b|\bdsnp\b|\bhmax\b|\batvp\b/i;
const WEBRIP_PATTERN = /\bweb[ ._-]?rip\b|\bwebrip\b|\bweb\b/i;
const HDTV_PATTERN = /\bhd[ ._-]?tv\b|\bpdtv\b|\bdsr\b/i;
const DVD_PATTERN = /\bdvd(?:rip|scr|r)?\b|\bxvid\b/i;

/**
 * Order is significant and runs most-specific first.
 *
 * Capture is tested before everything because those releases frequently
 * impersonate a better tier in the same name ("1080p HDCAM"), and a REMUX
 * label is tested before BluRay because every REMUX is also a Blu-ray source.
 * WEB-DL precedes WEBRip because the bare `\bweb\b` fallback in the WEBRip
 * pattern would otherwise swallow every WEB-DL.
 */
export function classifyProvenance(title: string): ReleaseProvenance {
  const t = title || "";
  if (CAPTURE_PATTERN.test(t)) return "capture";
  if (REMUX_PATTERN.test(t)) return "remux";
  if (WEBDL_PATTERN.test(t)) return "webdl";
  if (BLURAY_PATTERN.test(t)) return "bluray";
  if (WEBRIP_PATTERN.test(t)) return "webrip";
  if (HDTV_PATTERN.test(t)) return "hdtv";
  if (DVD_PATTERN.test(t)) return "dvd";
  return "unknown";
}

/** True for cam/telesync/telecine rips. */
export function isCaptureRelease(title: string): boolean {
  return CAPTURE_PATTERN.test(title || "");
}

/**
 * A capture is never worth watching when any alternative exists, so the
 * penalty is an order of magnitude larger than every other term of the score
 * (no non-capture release reaches `RELEASE_QUALITY_MAX_SCORE`). It is a penalty
 * rather than a filter on purpose: for an obscure or brand-new title a cam is
 * sometimes the only thing in existence, and a roster of one bad row still
 * beats an empty roster — it simply must never win while anything else is
 * available.
 */
const CAPTURE_PENALTY = -1000;

/**
 * Mastering tiers. Unknown sits level with WEBRip rather than at the bottom:
 * most release names carry no source tag at all, and an absent label is not
 * evidence of a bad encode.
 */
const PROVENANCE_SCORE: Record<ReleaseProvenance, number> = {
  remux: 90,
  bluray: 60,
  webdl: 55,
  webrip: 20,
  unknown: 20,
  hdtv: 8,
  dvd: 0,
  capture: CAPTURE_PENALTY,
};

/** Lossless and object-based tracks first; lossy tiers by bitrate envelope. */
const AUDIO_SCORE: Record<ReleaseAudioCodec, number> = {
  truehd: 14,
  dts: 12,
  flac: 12,
  eac3: 8,
  ac3: 5,
  aac: 3,
  opus: 3,
  mp3: 0,
  unknown: 0,
};

const HDR_BONUS = 10;
const MULTI_AUDIO_BONUS = 4;

/**
 * Ceiling for a non-capture release: 90 + 14 + 10 + 4. Mastering alone, and
 * not on the ranking path: release-quality.ts ranks by the picture a file holds.
 */
export const RELEASE_QUALITY_MAX_SCORE = 118;

export interface ReleaseQualityInput {
  /** Release title/filename — the only provenance evidence available. */
  title: string;
  audioCodec: ReleaseAudioCodec;
  multiAudio: boolean;
  hdr: boolean;
}

/**
 * Mastering quality for one release, `CAPTURE_PENALTY`..`RELEASE_QUALITY_MAX_SCORE`.
 *
 * Pure and dependency-free so it can be unit-tested against real release names
 * without a network or a DOM.
 */
export function releaseQualityScore(input: ReleaseQualityInput): number {
  const provenance = classifyProvenance(input.title);
  if (provenance === "capture") return CAPTURE_PENALTY;
  return (
    PROVENANCE_SCORE[provenance] +
    AUDIO_SCORE[input.audioCodec] +
    (input.hdr ? HDR_BONUS : 0) +
    (input.multiAudio ? MULTI_AUDIO_BONUS : 0)
  );
}

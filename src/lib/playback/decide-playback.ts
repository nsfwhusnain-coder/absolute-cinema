export type { PlaybackDecision };
import type { PlaybackDecision, PlaybackSource } from "./types";
import {
  isEnglishPreferredSource,
  isHouseholdStartLanguage,
  sourceAudioLanguageCode,
  sourceAudioLanguageRank,
} from "./source-facts";
import { bitrateSustainabilityRank, isSourcePlayableHere, sourceDelivery, normalizedBitrate } from "./source-quality";
import { supportsHev1Files } from "./decode-capability";
import { isNeverAutoDefaultUrl } from "./poison-url";
import { isMoviePackRelease } from "./debrid/torrentio";
import { filterHighQualitySources } from "./quality-floor";

export const STARTUP_UHD_HEIGHT = 2160;
export const HD_FLOOR_HEIGHT = 1080;

export interface DecidePlaybackOptions {
  preferredProvider?: string | null;
  preferredHeight?: "auto" | number | null;
  fourKStartup?: "fast" | "maximum" | null;
  contentClass?: string | null;
  failedIds?: readonly string[] | ReadonlySet<string>;
  remuxAvailable?: boolean;
}

function failedSet(ids: readonly string[] | ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (!ids) return new Set();
  if (ids instanceof Set) return ids;
  return new Set(ids);
}

function sourceMaxHeight(source: PlaybackSource): number {
  if (typeof source.maxHeight === "number" && source.maxHeight > 0) {
    return source.maxHeight;
  }
  const raw = source.quality;
  if (!raw || raw === "auto") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isDirectHd(source: PlaybackSource): boolean {
  return (
    sourceDelivery(source) === "direct" &&
    sourceMaxHeight(source) >= HD_FLOOR_HEIGHT
  );
}

export function isPackSource(source: PlaybackSource): boolean {
  return (
    source.titleMatch === "pack" ||
    isMoviePackRelease(source.label || (source as { title?: string }).title || "")
  );
}

/**
 * Several languages in one file, and a remux to choose among them: it starts
 * in the one the viewer wants (the remuxer is told which), where the same
 * file played as it is starts on whichever track its maker put first. Left
 * out of the language pool, a 4K or 1080p debrid file of this kind lost the
 * start to any web stream labelled English, whatever its quality.
 */
function choosesItsAudio(source: PlaybackSource): boolean {
  return source.multiAudio === true && sourceDelivery(source) === "remux";
}

/**
 * Household language policy:
 * English preferred titles stay in the auto pool when stamped English;
 * unlabeled direct HD is allowed as a fallback so native sources can start.
 */
export function autoLanguagePool(
  sources: readonly PlaybackSource[],
  contentClass?: string | null
): PlaybackSource[] {
  const preferredEn = sources.filter((source) =>
    isEnglishPreferredSource(source, contentClass) || choosesItsAudio(source)
  );

  // Preserve 4K / UHD and Direct HD streams with unlabeled (und) audio alongside English streams
  const undHdOr4K = sources.filter(
    (source) =>
      (sourceAudioLanguageCode(source) === "und" || !source.audioLanguage) &&
      (sourceMaxHeight(source) >= HD_FLOOR_HEIGHT || isDirectHd(source))
  );

  if (preferredEn.length) {
    if (undHdOr4K.length) return [...preferredEn, ...undHdOr4K];
    return preferredEn;
  }

  const unlabeled = sources.filter((source) => {
    const code = sourceAudioLanguageCode(source);
    return code === "und" || code === "xx";
  });
  const animeOriginal = sources.filter(
    (source) => sourceAudioLanguageRank(source, contentClass) >= 1
  );
  if (unlabeled.length) return unlabeled;
  if (animeOriginal.length) return animeOriginal;
  return [...sources];
}

/** Collection dumps never auto-play when a single-title row exists. */
export function autoIdentityPool(
  sources: readonly PlaybackSource[]
): PlaybackSource[] {
  const singles = sources.filter((source) => !isPackSource(source));
  return singles.length ? singles : [...sources];
}

function isDirectHdSource(source: PlaybackSource): boolean {
  return isDirectHd(source) && isHouseholdStartLanguage(source);
}

function isEnglishRemuxUhd(
  source: PlaybackSource,
  contentClass?: string | null
): boolean {
  return (
    sourceDelivery(source) === "remux" &&
    sourceMaxHeight(source) >= STARTUP_UHD_HEIGHT &&
    isEnglishPreferredSource(source, contentClass)
  );
}

const STARTS_AS_IS = 2;
const STARTS_REMUXED = 1;
const MAY_NOT_START = 0;

/**
 * How sure a source is to start: as it is, once remuxed, or perhaps not at
 * all. The last is an HEVC MP4 on a browser that refuses `hev1` files
 * (Safari): the file may be tagged `hev1` or `hvc1` and nothing says which
 * before it is opened, where a remuxed file is always written as `hvc1`.
 */
function startConfidence(source: PlaybackSource): number {
  if (sourceDelivery(source) !== "direct") return STARTS_REMUXED;
  const gamble = source.type === "mp4" && source.codec === "hevc" && !supportsHev1Files();
  return gamble ? MAY_NOT_START : STARTS_AS_IS;
}

function heightTier(height: number): number {
  if (height >= STARTUP_UHD_HEIGHT) return 4;
  if (height >= HD_FLOOR_HEIGHT) return 3;
  if (height >= 720) return 2;
  if (height <= 0) return 1;
  return 0;
}

function isAutoEligible(source: PlaybackSource): boolean {
  if (!isSourcePlayableHere(source)) return false;
  if (source.verified === false) return false;
  if (source.probe?.ok === false) return false;
  if (isNeverAutoDefaultUrl(source.url)) return false;
  return true;
}

function autoQualityPool(sources: readonly PlaybackSource[]): PlaybackSource[] {
  const eligible = sources.filter(isAutoEligible);
  return filterHighQualitySources(eligible.length ? eligible : [...sources]);
}

function compareForAutoStart(
  a: PlaybackSource,
  b: PlaybackSource,
  options: DecidePlaybackOptions,
  targetHeight: DecidePlaybackOptions["preferredHeight"]
): number {
  const aH = sourceMaxHeight(a);
  const bH = sourceMaxHeight(b);
  const explicit = typeof targetHeight === "number" ? targetHeight : null;

  if (explicit != null) {
    const aMeet = aH >= explicit ? 1 : 0;
    const bMeet = bH >= explicit ? 1 : 0;
    if (aMeet !== bMeet) return bMeet - aMeet;
  }

  // Highest resolution tier wins: 4K (4) > 1080p (3) > 720p (2) > auto/probed (1)
  const aTier = heightTier(aH);
  const bTier = heightTier(bH);
  if (aTier !== bTier) return bTier - aTier;
  if (aTier !== 1 && aH !== bH) return bH - aH;

  // A debrid file before a web stream of the same height, even one that has to
  // be remuxed first: the remux is a second or two of startup on a CDN that
  // holds its speed, where web streams are the ones that stall mid-film. With
  // direct-first here, devices that needed the remux started on a web stream
  // while the debrid file sat unused.
  const aDebrid = a.origin === "debrid" ? 1 : 0;
  const bDebrid = b.origin === "debrid" ? 1 : 0;
  if (aDebrid !== bDebrid) return bDebrid - aDebrid;

  const aStart = startConfidence(a);
  const bStart = startConfidence(b);
  if (aStart !== bStart) return bStart - aStart;

  const rate = normalizedBitrate(b) - normalizedBitrate(a);
  if (rate !== 0) return rate;

  const pref = (options.preferredProvider || "").trim().toLowerCase();
  if (pref) {
    const aPref = `${a.provider} ${a.label}`.toLowerCase().includes(pref) ? 1 : 0;
    const bPref = `${b.provider} ${b.label}`.toLowerCase().includes(pref) ? 1 : 0;
    if (aPref !== bPref) return bPref - aPref;
  }
  return a.id.localeCompare(b.id);
}

function pickFrom(
  sources: readonly PlaybackSource[],
  options: DecidePlaybackOptions,
  height: DecidePlaybackOptions["preferredHeight"]
): PlaybackSource | null {
  const pool = autoQualityPool(sources).filter(
    (source) => isAutoEligible(source) || isSourcePlayableHere(source)
  );
  if (!pool.length) return null;
  return [...pool].sort((a, b) => compareForAutoStart(a, b, options, height))[0] ?? null;
}

/**
 * The auto-start decider.
 * Always prioritizes highest available decodable resolution (4K > 1080p > 720p).
 */
export function decidePlayback(
  sources: readonly PlaybackSource[],
  options: DecidePlaybackOptions = {}
): PlaybackDecision {
  const live = sources.filter((source) => !failedSet(options.failedIds).has(source.id));
  const remuxAllowed = options.remuxAvailable !== false;
  const deliverable = remuxAllowed
    ? live
    : live.filter((s) => sourceDelivery(s) !== "remux");
  // A file on a CDN measured too slow to carry it opens late and then stalls:
  // it is not started while anything else will play, a shorter file included.
  const carried = deliverable.filter((source) => bitrateSustainabilityRank(source) >= 0);
  const playableLive = carried.length ? carried : deliverable;

  const roster = autoLanguagePool(
    autoIdentityPool(playableLive),
    options.contentClass
  );
  if (!roster.length) {
    return { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  // Direct 4K check
  const identity = autoIdentityPool(playableLive);
  const fourKDirect = pickFrom(
    identity.filter(
      (source) =>
        sourceMaxHeight(source) >= STARTUP_UHD_HEIGHT &&
        sourceDelivery(source) === "direct" &&
        isHouseholdStartLanguage(source)
    ),
    options,
    STARTUP_UHD_HEIGHT
  );
  if (fourKDirect) {
    return { immediate: fourKDirect, deferredFourK: null, reason: "ranked_best" };
  }

  // Remux 4K check (if remux allowed)
  if (remuxAllowed) {
    const fourKRemux = pickFrom(
      identity.filter(
        (source) =>
          sourceMaxHeight(source) >= STARTUP_UHD_HEIGHT &&
          sourceDelivery(source) === "remux" &&
          (isHouseholdStartLanguage(source) || choosesItsAudio(source))
      ),
      options,
      STARTUP_UHD_HEIGHT
    );
    if (fourKRemux) {
      return { immediate: fourKRemux, deferredFourK: null, reason: "ranked_best" };
    }
  }

  // Best ranked source in roster (highest quality available)
  const best = pickFrom(roster, options, options.preferredHeight);
  if (!best) {
    return { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  return { immediate: best, deferredFourK: null, reason: "ranked_best" };
}

export function decideImmediateSource(
  sources: readonly PlaybackSource[],
  options: DecidePlaybackOptions = {}
): PlaybackSource | null {
  return decidePlayback(sources, options).immediate;
}

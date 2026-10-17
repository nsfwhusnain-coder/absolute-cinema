/**
 * What a title's search found, as one record per title (docs/TELEMETRY.md,
 * `web` / `discovery_summary`) and as the live counts of the same search.
 *
 * `buildDiscoverySummary` is pure: it is given an answer's sources and says
 * what was asked, and it never copies a source's link. `noteDiscovery` is the
 * one place the route calls: it claims the title for its ten-minute window,
 * takes the debrid timings the resolver left for it, and counts the search.
 */
import type { MediaType, PlaybackSource } from "../playback/types";
import { parseMaxHeight, sourceMaxHeight } from "../playback/source-quality";
import { parseDebridPlaybackSourceId } from "../playback/debrid/debrid-source-id";
import { isAllDebridConfigured } from "../playback/debrid/alldebrid";
import { isRealDebridConfigured } from "../playback/debrid/realdebrid";
import { isTorBoxConfigured } from "../playback/debrid/torbox";
import { qualityBucket, type QualityBucket } from "../metrics";
import { discoveryOutcomes, discoverySources, discoveryUpscaled, serviceLabel } from "./web-metrics";
import { debridTimingsOf } from "./debrid-timing";
import { ClaimSet } from "./expiring-map";
import { titleKey, type TitleRef } from "./title-key";

/** At most one summary per title in this long. */
const SUMMARY_WINDOW_MS = 10 * 60 * 1000;
/** Titles remembered for the window; past this the oldest are forgotten first. */
const SUMMARY_TITLES_MAX = 4000;
/** A release title is kept this long at most: it names a release, never a page. */
const RELEASE_TITLE_MAX_CHARS = 200;
const LINK_LIKE = /:\/\/|www\./i;
/** The height a flagged 4K picture is judged at. */
const UPSCALE_HEIGHT = 1080;
const FOUR_K = 2160;

/** The best a search found: 2160, 1080 and 720 are the rungs; "sd" is anything lower. */
export type DiscoveryOutcome = "2160" | "1080" | "720" | "sd" | "web_only" | "nothing";

/** Debrid flags counted as verdicts, and the name each one is counted under. */
const JUDGED_FLAGS: Readonly<Record<string, string>> = {
  upscaled: "upscaled",
  starved: "starved",
  hardsub: "hardsub",
  interpolated: "interpolated",
  "dv-only": "dvOnly",
};

/** Flags that mean a 4K release shows no more than 1080p of picture. */
const DEMOTING_FLAGS = ["upscaled", "starved"];

export interface DiscoveryTimings {
  realDebridMs?: number;
  allDebridMs?: number;
  first1080Ms?: number;
  first2160Ms?: number;
  providersMs?: number;
}

const TIMING_KEYS = ["realDebridMs", "allDebridMs", "first1080Ms", "first2160Ms", "providersMs"] as const;

export interface DiscoveryContext {
  mediaType: MediaType;
  tmdbId: number;
  season?: number | null;
  episode?: number | null;
  want4k: boolean;
  qualityHint: string | number | null;
  cache: boolean;
  indexFailed: boolean;
  timings?: DiscoveryTimings;
}

/** The debrid file the search would start on: the tallest, then the best judged, then the best scored. */
export interface DiscoveryBest {
  provider: string;
  height: number | null;
  effectiveHeight: number | null;
  tier: number | null;
  score: number | null;
  flags: string[];
  bitrateBps: number | null;
  sizeBytes: number | null;
  codec: string | null;
  container: string | null;
  releaseTitle: string | null;
}

export interface DiscoverySummary {
  mediaType: MediaType;
  tmdbId: number;
  season: number | null;
  episode: number | null;
  want4k: boolean;
  qualityHint: string | number | null;
  outcome: DiscoveryOutcome;
  /** Per provider, the count of its files and streams per quality bucket. */
  found: Record<string, Record<string, number>>;
  best: DiscoveryBest | null;
  /** Per debrid provider, the count of its files per verdict. */
  judged: Record<string, Record<string, number>>;
  cache: boolean;
  indexFailed: boolean;
  timings: DiscoveryTimings;
}

/** One source as the summary counts it. */
export interface ClassifiedSource {
  provider: string;
  origin: "debrid" | "web";
  /** The height the release claims: its name's, or the file's own. */
  claimedHeight: number;
  /** The height its picture shows: a 4K flagged upscaled or starved shows 1080. */
  effectiveHeight: number;
  bucket: QualityBucket;
}

/** The debrid service a debrid source came from, as the lower-case name the metrics use. */
function debridServiceOf(source: PlaybackSource): string {
  const fromId = parseDebridPlaybackSourceId(source.id)?.provider;
  if (fromId) return fromId;
  // The display name is the fallback: "Debrid" is Real-Debrid's.
  const name = source.provider.toLowerCase();
  if (name.includes("torbox")) return "torbox";
  if (name.includes("alldebrid")) return "alldebrid";
  return "realdebrid";
}

export function classifyDiscoverySource(source: PlaybackSource): ClassifiedSource {
  const isDebrid = source.origin === "debrid";
  // Annotation lowers a flagged 4K's maxHeight to 1080, so the name keeps the claim.
  const current = sourceMaxHeight(source);
  const named = source.releaseTitle ? parseMaxHeight(source.releaseTitle) : 0;
  const claimedHeight = Math.max(current, named);
  const flagged = (source.qualityFlags ?? []).some((flag) => DEMOTING_FLAGS.includes(flag));
  const demoted = isDebrid && claimedHeight >= FOUR_K && flagged;
  const effectiveHeight = demoted ? UPSCALE_HEIGHT : current;
  return {
    provider: isDebrid ? debridServiceOf(source) : serviceLabel(source.provider),
    origin: isDebrid ? "debrid" : "web",
    claimedHeight,
    effectiveHeight,
    bucket: qualityBucket(effectiveHeight),
  };
}

/**
 * The outcome a height gives. 1440 counts as 1080: the rungs are the picture a
 * viewer picks, and only a real 2160 may read as 4K. A height nothing gave
 * counts as sd, since nothing about the file says it is more.
 */
export function outcomeOfHeight(height: number): "2160" | "1080" | "720" | "sd" {
  const bucket = qualityBucket(height);
  if (bucket === "2160") return "2160";
  if (bucket === "1440" || bucket === "1080") return "1080";
  if (bucket === "720") return "720";
  return "sd";
}

/** The verdicts one debrid file earns: its tier, and one for each judged flag it carries. */
function verdictsOf(source: PlaybackSource): string[] {
  const verdicts: string[] = [];
  if (source.qualityTier !== undefined) verdicts.push(`tier${source.qualityTier}`);
  for (const flag of source.qualityFlags ?? []) {
    const verdict = JUDGED_FLAGS[flag];
    if (verdict) verdicts.push(verdict);
  }
  return verdicts;
}

/** A release name as the record keeps it, or null when it is a link or too long to be a name. */
export function safeReleaseTitle(title: string | undefined): string | null {
  if (!title || LINK_LIKE.test(title)) return null;
  return title.slice(0, RELEASE_TITLE_MAX_CHARS);
}

/** True when `a` should be the search's best file over `b`: the taller picture, then the higher tier, then the higher score. */
function ranksAbove(a: PlaybackSource, b: PlaybackSource, aHeight: number, bHeight: number): boolean {
  if (aHeight !== bHeight) return aHeight > bHeight;
  const tierA = a.qualityTier ?? 0;
  const tierB = b.qualityTier ?? 0;
  if (tierA !== tierB) return tierA > tierB;
  return (a.qualityScore ?? 0) > (b.qualityScore ?? 0);
}

function count(table: Record<string, Record<string, number>>, row: string, column: string, by = 1): void {
  const cells = (table[row] ??= {});
  cells[column] = (cells[column] ?? 0) + by;
}

function knownTimings(timings: DiscoveryTimings | undefined): DiscoveryTimings {
  const known: DiscoveryTimings = {};
  for (const key of TIMING_KEYS) {
    const value = timings?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) known[key] = Math.round(value);
  }
  return known;
}

/**
 * The record of one settled search. `sources` are the answer's sources as they
 * were ranked; the summary holds counts, the best file's facts and no link.
 */
export function buildDiscoverySummary(sources: readonly PlaybackSource[], context: DiscoveryContext): DiscoverySummary {
  const found: Record<string, Record<string, number>> = {};
  const judged: Record<string, Record<string, number>> = {};
  let web = 0;
  let best: { source: PlaybackSource; classed: ClassifiedSource } | null = null;

  for (const source of sources) {
    const classed = classifyDiscoverySource(source);
    count(found, classed.provider, classed.bucket);
    if (classed.origin === "web") {
      web += 1;
      continue;
    }
    for (const verdict of verdictsOf(source)) count(judged, classed.provider, verdict);
    if (!best || ranksAbove(source, best.source, classed.effectiveHeight, best.classed.effectiveHeight)) {
      best = { source, classed };
    }
  }

  let outcome: DiscoveryOutcome = "nothing";
  if (best) outcome = outcomeOfHeight(best.classed.effectiveHeight);
  else if (web > 0) outcome = "web_only";

  const season = context.mediaType === "tv" ? (context.season ?? null) : null;
  const episode = context.mediaType === "tv" ? (context.episode ?? null) : null;
  return {
    mediaType: context.mediaType,
    tmdbId: context.tmdbId,
    season,
    episode,
    want4k: context.want4k,
    qualityHint: context.qualityHint ?? null,
    outcome,
    found,
    best: best ? bestRecord(best.source, best.classed) : null,
    judged,
    cache: context.cache,
    indexFailed: context.indexFailed,
    timings: knownTimings(context.timings),
  };
}

function bestRecord(source: PlaybackSource, classed: ClassifiedSource): DiscoveryBest {
  return {
    provider: classed.provider,
    height: classed.claimedHeight > 0 ? classed.claimedHeight : null,
    effectiveHeight: classed.effectiveHeight > 0 ? classed.effectiveHeight : null,
    tier: source.qualityTier ?? null,
    score: source.qualityScore ?? null,
    flags: [...(source.qualityFlags ?? [])],
    bitrateBps: source.fileBitrateBps ?? source.bitrateBps ?? null,
    sizeBytes: source.sizeBytes ?? null,
    codec: source.codec ?? null,
    container: source.container ?? null,
    releaseTitle: safeReleaseTitle(source.releaseTitle),
  };
}

/**
 * Counts one settled search in the live metrics: its outcome, each source it
 * found, and each judged verdict. Called once per title, through `noteDiscovery`.
 */
export function recordDiscoveryMetrics(summary: DiscoverySummary, sources: readonly PlaybackSource[]): void {
  try {
    discoveryOutcomes.inc({ media: summary.mediaType, outcome: summary.outcome });
    for (const source of sources) {
      const classed = classifyDiscoverySource(source);
      discoverySources.inc({ provider: classed.provider, origin: classed.origin, quality: classed.bucket });
    }
    for (const [provider, verdicts] of Object.entries(summary.judged)) {
      for (const [verdict, n] of Object.entries(verdicts)) discoveryUpscaled.inc({ provider, verdict }, n);
    }
  } catch {
    // A failed count never breaks the answer it describes.
  }
}

/**
 * The gate that makes a title count once: one summary per title per ten
 * minutes, whichever viewer's answer comes first.
 */
const discoveryClaims = new ClaimSet(SUMMARY_WINDOW_MS, SUMMARY_TITLES_MAX);

/** True when the debrid services can add nothing more to the title (the answer's own word, or none is configured). */
export function isDiscoveryFinal(answer: { debridSettled?: boolean }): boolean {
  return answer.debridSettled === true || !(isRealDebridConfigured() || isTorBoxConfigured() || isAllDebridConfigured());
}

export interface DiscoveryAnswer {
  title: TitleRef & { mediaType: MediaType };
  sources: readonly PlaybackSource[];
  want4k: boolean;
  qualityHint: string | number | null;
  cache: boolean;
  /** How long the web providers took to answer, when this answer waited for them. */
  providersMs?: number;
}

/**
 * Settles one title's discovery for a final full answer: the summary to write
 * to the event log, or null when the title was counted within the window
 * already, or when anything fails. Never throws.
 */
export function noteDiscovery(answer: DiscoveryAnswer, now = Date.now()): DiscoverySummary | null {
  try {
    if (!discoveryClaims.claim(titleKey(answer.title), now)) return null;
    const debrid = debridTimingsOf(answer.title, now);
    const summary = buildDiscoverySummary(answer.sources, {
      mediaType: answer.title.mediaType,
      tmdbId: answer.title.tmdbId,
      season: answer.title.season,
      episode: answer.title.episode,
      want4k: answer.want4k,
      qualityHint: answer.qualityHint,
      cache: answer.cache,
      indexFailed: debrid?.indexFailed ?? false,
      timings: { ...debrid?.timings, providersMs: answer.providersMs },
    });
    recordDiscoveryMetrics(summary, answer.sources);
    return summary;
  } catch {
    return null;
  }
}

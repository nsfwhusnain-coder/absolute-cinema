/**
 * What one remux session did, counted as it goes: the numbers its summary
 * event is written from (`remux_session_summary`, docs/TELEMETRY.md).
 *
 * Each session owns one of these, and its ProxySource carries the same one, so
 * the range proxy can add to it without importing the session code. Nothing
 * here holds a link: a summary names the CDN by its domain and the session by
 * its id, never the URL it was opened with.
 */

/** Lane speed samples a session keeps for its median: enough to be steady, few enough to hold for hours. */
const LANE_SAMPLE_CAP = 200;
/** How many viewers a session counts; past this, more are not told apart. */
const MAX_VIEWERS_COUNTED = 10_000;

/** How an upstream request ended: once per request, in the proxy (see source-proxy.ts). */
export type ProxyOutcome = "ok" | "refused" | "error" | "silent" | "wrong_range";

export interface SessionStats {
  /** Epoch ms when the session was opened. */
  openedAt: number;
  /** Opening the file: from the start of its index read to a ready session. Null until it is open. */
  openMs: number | null;
  /** Upstream reads the index took. */
  indexReads: number;
  bytesUpstream: number;
  /** Bytes of fragments and init segments handed to players. */
  bytesServed: number;
  /**
   * Speeds of single connections, in bytes per second. Kept as a bounded
   * sample: every `laneStride`-th sample seen, halving whenever it fills, so
   * it stays spread over the whole session. The extremes are exact.
   */
  laneSamples: number[];
  laneStride: number;
  laneSeen: number;
  laneMin: number | null;
  laneMax: number | null;
  /** The most connections the file was read over at once. */
  maxLanes: number;
  refusals: number;
  silences: number;
  wrongRanges: number;
  /** Runs started. */
  runs: number;
  /** Runs ended, by their reason label (remux-metrics.ts runEndReason, or completed/failed). */
  runEnds: Record<string, number>;
  /** The first run's first fragment, from the run's start. Null when that run made none. */
  firstFragmentMs: number | null;
  /** Distinct viewers (watcher ids) who asked for anything of the session. */
  viewers: Set<string>;
}

export function newSessionStats(openedAt: number): SessionStats {
  return {
    openedAt,
    openMs: null,
    indexReads: 0,
    bytesUpstream: 0,
    bytesServed: 0,
    laneSamples: [],
    laneStride: 1,
    laneSeen: 0,
    laneMin: null,
    laneMax: null,
    maxLanes: 1,
    refusals: 0,
    silences: 0,
    wrongRanges: 0,
    runs: 0,
    runEnds: {},
    firstFragmentMs: null,
    viewers: new Set(),
  };
}

/**
 * Totals since this process started, for the capacity snapshot's rates. A
 * session's own tally goes with the session, so the rates cannot come from it.
 */
export const totals = { upstreamBytes: 0, servedBytes: 0 };

/**
 * Runs one metric or event update. One that throws is dropped: a counter
 * must never be the reason a read of the film fails.
 */
export function telemetry(record: () => void): void {
  try {
    record();
  } catch {
    // Ignored on purpose: the film matters more than the number.
  }
}

/** Counts a request's outcome against its session (the proxy counts the metric itself). */
export function noteOutcome(stats: SessionStats | undefined, outcome: ProxyOutcome): void {
  if (!stats) return;
  if (outcome === "refused") stats.refusals++;
  else if (outcome === "silent") stats.silences++;
  else if (outcome === "wrong_range") stats.wrongRanges++;
}

/** A connection's speed, in bytes per second, sampled once per measured chunk. */
export function noteLaneSample(stats: SessionStats, bytesPerS: number): void {
  if (!Number.isFinite(bytesPerS) || bytesPerS < 0) return;
  stats.laneMin = stats.laneMin === null ? bytesPerS : Math.min(stats.laneMin, bytesPerS);
  stats.laneMax = stats.laneMax === null ? bytesPerS : Math.max(stats.laneMax, bytesPerS);
  const seen = stats.laneSeen++;
  if (seen % stats.laneStride !== 0) return;
  stats.laneSamples.push(bytesPerS);
  if (stats.laneSamples.length >= LANE_SAMPLE_CAP) {
    // Keeping every other sample holds the spread: the ones left were seen at every second stride.
    stats.laneSamples = stats.laneSamples.filter((_, i) => i % 2 === 0);
    stats.laneStride *= 2;
  }
}

/** Per-connection speed of a session in bits per second: the lowest, the median and the highest. Null before any sample. */
export function laneSpeedSummary(stats: SessionStats): { min: number; median: number; max: number } | null {
  if (stats.laneMin === null || stats.laneMax === null || stats.laneSamples.length === 0) return null;
  const sorted = [...stats.laneSamples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const bits = (bytesPerS: number) => Math.round(bytesPerS * 8);
  return { min: bits(stats.laneMin), median: bits(median), max: bits(stats.laneMax) };
}

/** Records a fragment's arrival: only the first run's first fragment is the session's first-fragment time. */
export function noteFirstFragment(stats: SessionStats, runId: number, ms: number): void {
  if (runId === 0 && stats.firstFragmentMs === null) stats.firstFragmentMs = Math.round(ms);
}

/** Counts a viewer (a watcher id) against the session. An empty id is nobody. */
export function noteViewer(stats: SessionStats, watcher: string): void {
  if (watcher && stats.viewers.size < MAX_VIEWERS_COUNTED) stats.viewers.add(watcher);
}

/** What a session is, as the summary names it: the file's facts and its CDN's domain. */
export interface SummaryFile {
  session: string;
  cdn: string;
  durationS: number;
  sizeBytes: number;
  bitrateBps: number | null;
  videoCodec: string | null;
  dynamicRange: string;
  audioDelivery: string;
}

/** The fields of a `remux_session_summary` event for a session that ends at `now` (see docs/TELEMETRY.md). */
export function sessionSummary(file: SummaryFile, stats: SessionStats, now: number): Record<string, unknown> {
  return {
    session: file.session,
    cdn: file.cdn,
    durationS: Math.round(file.durationS * 10) / 10,
    sizeBytes: file.sizeBytes,
    bitrateBps: file.bitrateBps,
    videoCodec: file.videoCodec,
    dynamicRange: file.dynamicRange,
    audioDelivery: file.audioDelivery,
    openMs: stats.openMs,
    indexReads: stats.indexReads,
    runs: stats.runs,
    runEnds: { ...stats.runEnds },
    firstFragmentMs: stats.firstFragmentMs,
    bytesUpstream: stats.bytesUpstream,
    bytesServed: stats.bytesServed,
    laneBps: laneSpeedSummary(stats),
    maxLanes: stats.maxLanes,
    refusals: stats.refusals,
    silences: stats.silences,
    wrongRanges: stats.wrongRanges,
    viewers: stats.viewers.size,
    openForS: Math.round((now - stats.openedAt) / 1000),
  };
}

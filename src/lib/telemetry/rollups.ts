/**
 * The daily rollups (see docs/TELEMETRY.md): one summary per UTC day, made from
 * that day's event log and kept for good. The event log is kept for 400 days;
 * the rollups are what a month is compared with once its raw lines are gone.
 *
 * `figuresBuilder` takes one event at a time and keeps only counts and the
 * numbers that percentiles need, never the events themselves, so a day of
 * event files is read line by line. Everything here is pure except
 * `writeRollups`, the one place that reads event files and writes rollups.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eventDayOfFile, eventLogDir } from "../event-log";

export type Counted = Record<string, number>;

/** Where a set of samples sits: the typical value, and the low and high tenths. */
export interface Percentiles {
  n: number;
  p10: number;
  p50: number;
  p90: number;
}

/** The highest sample, and the value that 95 samples in 100 stay under. */
export interface Peak {
  peak: number;
  p95: number;
}

export interface SearchFigures {
  /** `discovery_summary`: one per title, once its search has settled. */
  discoveries: number;
  byOutcome: Counted;
  /** Per service, the files it found by quality bucket. */
  found: Record<string, Counted>;
  /** Per verdict, the debrid files given it, all services together. */
  judged: Counted;
  /** `playback_answer`: every answer to "what can play this". */
  answers: { total: number; byMode: Counted; byCache: Counted; totalMs: Percentiles | null };
}

export interface StartTimes {
  /** From choosing a file to its first picture. */
  timeToFirstFrameMs: Percentiles | null;
  /** From opening the title to its first picture: the viewer's whole wait. */
  sinceOpenMs: Percentiles | null;
}

export interface StartFigures extends StartTimes {
  /** `player_feedback` first_frame. */
  total: number;
  byDevice: Record<string, StartTimes>;
  byDelivery: Record<string, StartTimes>;
  byEngine: Record<string, StartTimes>;
  /** `handoff_failed` and `decode_error`. */
  failures: { total: number; byReason: Counted };
}

export interface WatchStats {
  heartbeats: number;
  watchedMs: number;
  hours: number;
  /** The stalls the heartbeats counted, plus each stall reported on its own. */
  stalls: number;
  stalledMs: number;
  stallsPerHour: number | null;
  droppedFrames: number;
  decodedFrames: number;
  droppedFrameRatio: number | null;
  /** Each heartbeat's bytes over the time spent loading them. */
  bitrateBps: Percentiles | null;
  /** The player's own estimate of its download speed. */
  bandwidthBps: Percentiles | null;
  bufferAheadS: Percentiles | null;
}

export interface WatchFigures {
  overall: WatchStats;
  byDevice: Record<string, WatchStats>;
  byQuality: Record<string, WatchStats>;
  byDelivery: Record<string, WatchStats>;
  /** `session_end` by how the title was left. */
  endReasons: Counted;
  startupMs: Percentiles | null;
}

export interface CdnFigures {
  sessions: number;
  bytesUpstream: number;
  bytesServed: number;
  /** Each session's median connection speed. */
  laneBps: Percentiles | null;
  refusals: number;
  silences: number;
  wrongRanges: number;
  openMs: Percentiles | null;
  firstFragmentMs: Percentiles | null;
}

export interface RemuxFigures {
  /** `remux_session_summary`. */
  sessions: number;
  bytesUpstream: number;
  bytesServed: number;
  byCdn: Record<string, CdnFigures>;
  /** `vod_open`: every open of a file by the remuxer, prewarms included. */
  opens: { total: number; byOutcome: Counted; tookMs: Percentiles | null };
}

export interface CapacityFigures {
  snapshots: number;
  sessions: Peak | null;
  runs: Peak | null;
  viewers: Peak | null;
  /** The container's own network, down and up. */
  rxBps: Peak | null;
  txBps: Peak | null;
  /** Read from the CDNs, and handed to the players. */
  upstreamBps: Peak | null;
  servedBps: Peak | null;
  cpuPercent: Peak | null;
  /** The minute with the most going out (`txBps`). */
  busiest: { at: number; txBps: number } | null;
}

export interface ScraperFigures {
  hit: number;
  empty: number;
  error: number;
  ms: Percentiles | null;
}

export interface ProviderFigures {
  /** `provider_result`, per provider. */
  scraper: Record<string, ScraperFigures>;
  /** `debrid_resolve_timing`, per service: the whole search, and each tier that was asked. */
  debrid: Record<string, Percentiles | null>;
}

/** What a day, or any span of days, is summarised as. */
export interface RollupFigures {
  searches: SearchFigures;
  starts: StartFigures;
  watching: WatchFigures;
  remux: RemuxFigures;
  capacity: CapacityFigures;
  providers: ProviderFigures;
}

export interface DailyRollup extends RollupFigures {
  day: string;
  /** The lines of the day that were events at all. */
  events: number;
}

/** A rollup as it is kept on disk, with the time it was written. */
export interface StoredRollup extends DailyRollup {
  writtenAt: number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A debrid search this short only read its cache, so its times say nothing about a search. */
export const REAL_SEARCH_MIN_MS = 100;
/** A scope film is letterboxed (1920x800 is a 1080p film): wider than this many times its height, its width says its class. */
const SCOPE_RATIO = 1.9;
/** The debrid times a search reports, and the names they are kept under. */
const DEBRID_TIMES: ReadonlyArray<readonly [string, string]> = [
  ["totalMs", "total"],
  ["realDebridMs", "realDebrid"],
  ["realDebridPartialMs", "realDebridPartial"],
  ["allDebridMs", "allDebrid"],
  ["torboxMs", "torbox"],
];
const CAPACITY_SERIES = ["sessions", "runs", "viewers", "rxBps", "txBps", "upstreamBps", "servedBps", "cpuPercent"] as const;
type CapacitySeries = (typeof CAPACITY_SERIES)[number];

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** A finite, non-negative measure, or null: a missing or broken field counts for nothing. */
const measure = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n >= 0 ? n : null;
};
const amount = (value: unknown): number => measure(value) ?? 0;
/** A name read from an event. Anything that is not a name or a number is `fallback`. */
function label(value: unknown, fallback = "unknown"): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 64);
  const n = finite(value);
  return n === null ? fallback : String(n);
}
const round = (value: number, places = 2): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

function sampleAt(sorted: readonly number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
}

/** The typical sample of a set, and its low and high tenths. Null for no samples, never NaN. */
export function percentiles(values: readonly number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p10: round(sampleAt(sorted, 0.1)), p50: round(sampleAt(sorted, 0.5)), p90: round(sampleAt(sorted, 0.9)) };
}

/** The highest sample, and its 95th percentile. Null for no samples. */
export function peakOf(values: readonly number[]): Peak | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { peak: round(sorted[sorted.length - 1]!), p95: round(sampleAt(sorted, 0.95)) };
}

/**
 * Percentiles of several spans as one. The sample counts add up; each tenth is
 * the average of the spans' tenths, weighted by their samples. That is an
 * approximation, good for a month's comparison, not an exact percentile.
 */
export function mergePercentiles(parts: ReadonlyArray<Percentiles | null>): Percentiles | null {
  const present = parts.filter((part): part is Percentiles => part !== null && part.n > 0);
  const n = sum(present.map((part) => part.n));
  if (n === 0) return null;
  const average = (pick: (part: Percentiles) => number): number => round(sum(present.map((part) => pick(part) * part.n)) / n);
  return { n, p10: average((part) => part.p10), p50: average((part) => part.p50), p90: average((part) => part.p90) };
}

/** Peaks of several spans as one: the highest peak, and the mean of the 95th percentiles (an approximation). */
function mergePeaks(parts: ReadonlyArray<Peak | null>): Peak | null {
  const present = parts.filter((part): part is Peak => part !== null);
  if (present.length === 0) return null;
  return { peak: Math.max(...present.map((part) => part.peak)), p95: round(sum(present.map((part) => part.p95)) / present.length) };
}

/** Counts under each key. A Map, so a key such as "constructor" is an ordinary key. */
class Tally {
  private readonly counts = new Map<string, number>();
  add(key: string, by = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }
  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
  toCounted(): Counted {
    return Object.fromEntries(this.counts);
  }
}

/** One value per key, made the first time the key is seen: the figures of each device, quality, service. */
class Groups<T> {
  private readonly groups = new Map<string, T>();
  private readonly fresh: () => T;
  constructor(fresh: () => T) {
    this.fresh = fresh;
  }
  of(key: string): T {
    let group = this.groups.get(key);
    if (group === undefined) {
      group = this.fresh();
      this.groups.set(key, group);
    }
    return group;
  }
  map<U>(convert: (group: T) => U): Record<string, U> {
    return Object.fromEntries([...this.groups].map(([key, group]): [string, U] => [key, convert(group)]));
  }
}

/**
 * The bucket a picture is counted under, as the metrics name them. A scope
 * film is bucketed by its width, since its height is short of any class.
 */
export function qualityBucket(height: number | null, width: number | null): string {
  if (height === null && width === null) return "unknown";
  const byWidth = width !== null && (height === null || width / height >= SCOPE_RATIO);
  const value = (byWidth ? width : height) ?? 0;
  const steps: ReadonlyArray<readonly [number, string]> = byWidth
    ? [[3500, "2160"], [2400, "1440"], [1800, "1080"], [1200, "720"]]
    : [[2160, "2160"], [1440, "1440"], [1080, "1080"], [720, "720"]];
  for (const [minimum, bucket] of steps) if (value >= minimum) return bucket;
  return value > 0 ? "sd" : "unknown";
}

interface SearchState {
  discoveries: number;
  byOutcome: Tally;
  found: Groups<Tally>;
  judged: Tally;
  answers: { total: number; byMode: Tally; byCache: Tally; totalMs: number[] };
}

interface TimesSamples {
  ttff: number[];
  since: number[];
}

interface StartState {
  total: number;
  overall: TimesSamples;
  byDevice: Groups<TimesSamples>;
  byDelivery: Groups<TimesSamples>;
  byEngine: Groups<TimesSamples>;
  failures: { total: number; byReason: Tally };
}

interface WatchSamples {
  heartbeats: number;
  watchedMs: number;
  stalls: number;
  stalledMs: number;
  droppedFrames: number;
  decodedFrames: number;
  bitrate: number[];
  bandwidth: number[];
  buffer: number[];
}

interface WatchState {
  overall: WatchSamples;
  byDevice: Groups<WatchSamples>;
  byQuality: Groups<WatchSamples>;
  byDelivery: Groups<WatchSamples>;
  endReasons: Tally;
  startupMs: number[];
}

interface CdnSamples {
  sessions: number;
  bytesUpstream: number;
  bytesServed: number;
  refusals: number;
  silences: number;
  wrongRanges: number;
  laneBps: number[];
  openMs: number[];
  firstFragmentMs: number[];
}

interface RemuxState {
  sessions: number;
  bytesUpstream: number;
  bytesServed: number;
  byCdn: Groups<CdnSamples>;
  opens: { total: number; byOutcome: Tally; tookMs: number[] };
}

interface CapacityState {
  snapshots: number;
  series: Record<CapacitySeries, number[]>;
  busiest: { at: number; txBps: number } | null;
}

interface ProviderState {
  scraper: Groups<{ status: Tally; ms: number[] }>;
  debrid: Groups<number[]>;
}

interface State {
  search: SearchState;
  starts: StartState;
  watching: WatchState;
  remux: RemuxState;
  capacity: CapacityState;
  providers: ProviderState;
}

const freshTimes = (): TimesSamples => ({ ttff: [], since: [] });
const freshWatch = (): WatchSamples => ({ heartbeats: 0, watchedMs: 0, stalls: 0, stalledMs: 0, droppedFrames: 0, decodedFrames: 0, bitrate: [], bandwidth: [], buffer: [] });
const freshCdn = (): CdnSamples => ({ sessions: 0, bytesUpstream: 0, bytesServed: 0, refusals: 0, silences: 0, wrongRanges: 0, laneBps: [], openMs: [], firstFragmentMs: [] });

function freshState(): State {
  return {
    search: {
      discoveries: 0,
      byOutcome: new Tally(),
      found: new Groups(() => new Tally()),
      judged: new Tally(),
      answers: { total: 0, byMode: new Tally(), byCache: new Tally(), totalMs: [] },
    },
    starts: {
      total: 0,
      overall: freshTimes(),
      byDevice: new Groups(freshTimes),
      byDelivery: new Groups(freshTimes),
      byEngine: new Groups(freshTimes),
      failures: { total: 0, byReason: new Tally() },
    },
    watching: {
      overall: freshWatch(),
      byDevice: new Groups(freshWatch),
      byQuality: new Groups(freshWatch),
      byDelivery: new Groups(freshWatch),
      endReasons: new Tally(),
      startupMs: [],
    },
    remux: {
      sessions: 0,
      bytesUpstream: 0,
      bytesServed: 0,
      byCdn: new Groups(freshCdn),
      opens: { total: 0, byOutcome: new Tally(), tookMs: [] },
    },
    capacity: {
      snapshots: 0,
      series: { sessions: [], runs: [], viewers: [], rxBps: [], txBps: [], upstreamBps: [], servedBps: [], cpuPercent: [] },
      busiest: null,
    },
    providers: {
      scraper: new Groups<{ status: Tally; ms: number[] }>(() => ({ status: new Tally(), ms: [] })),
      debrid: new Groups<number[]>(() => []),
    },
  };
}

function takeDiscovery(search: SearchState, row: Row): void {
  search.discoveries++;
  search.byOutcome.add(label(row.outcome));
  if (isRow(row.found)) {
    for (const [provider, buckets] of Object.entries(row.found)) {
      if (!isRow(buckets)) continue;
      const tally = search.found.of(label(provider));
      for (const [bucket, files] of Object.entries(buckets)) {
        const count = measure(files);
        if (count !== null && count > 0) tally.add(label(bucket), count);
      }
    }
  }
  if (isRow(row.judged)) {
    for (const verdicts of Object.values(row.judged)) {
      if (!isRow(verdicts)) continue;
      for (const [verdict, count] of Object.entries(verdicts)) {
        const judged = measure(count);
        if (judged !== null && judged > 0) search.judged.add(label(verdict), judged);
      }
    }
  }
}

function takeAnswer(answers: SearchState["answers"], row: Row): void {
  answers.total++;
  answers.byMode.add(label(row.mode));
  answers.byCache.add(label(row.cache));
  const took = measure(row.totalMs);
  if (took !== null) answers.totalMs.push(took);
}

function takeFirstFrame(starts: StartState, row: Row): void {
  starts.total++;
  const ttff = measure(row.timeToFirstFrameMs);
  const since = measure(row.sinceOpenMs);
  const platform: Row = isRow(row.platform) ? row.platform : {};
  const groups = [starts.overall, starts.byDevice.of(label(platform.deviceClass)), starts.byDelivery.of(label(row.delivery)), starts.byEngine.of(label(row.engine))];
  for (const group of groups) {
    if (ttff !== null) group.ttff.push(ttff);
    if (since !== null) group.since.push(since);
  }
}

/** The viewer's device, quality and delivery for a heartbeat or a stall; the overall figures are always one of them. */
function watchTargets(watching: WatchState, row: Row): WatchSamples[] {
  const platform: Row = isRow(row.platform) ? row.platform : {};
  return [
    watching.overall,
    watching.byDevice.of(label(platform.deviceClass)),
    watching.byQuality.of(qualityBucket(measure(row.decodedHeight), measure(row.decodedWidth))),
    watching.byDelivery.of(label(row.delivery)),
  ];
}

function takeHeartbeat(watching: WatchState, row: Row): void {
  // Bytes over the time spent loading them: what the connection delivered, not what the film asked for.
  const bytes = measure(row.bytesLoaded);
  const load = measure(row.loadMs);
  const bitrate = bytes !== null && load !== null && bytes > 0 && load > 0 ? (bytes * 8) / (load / 1000) : null;
  const bandwidth = measure(row.bandwidthBps);
  const buffer = measure(row.bufferAheadS);
  for (const target of watchTargets(watching, row)) {
    target.heartbeats++;
    target.watchedMs += amount(row.watchedMs);
    target.stalls += amount(row.stalls);
    target.stalledMs += amount(row.stalledMs);
    target.droppedFrames += amount(row.droppedFrames);
    target.decodedFrames += amount(row.decodedFrames);
    if (bitrate !== null) target.bitrate.push(bitrate);
    if (bandwidth !== null && bandwidth > 0) target.bandwidth.push(bandwidth);
    if (buffer !== null) target.buffer.push(buffer);
  }
}

function takeStall(watching: WatchState, row: Row): void {
  for (const target of watchTargets(watching, row)) {
    target.stalls += 1;
    target.stalledMs += amount(row.stalledMs);
  }
}

function takeFeedback(state: State, row: Row, kind: string): void {
  switch (kind) {
    case "first_frame":
      takeFirstFrame(state.starts, row);
      break;
    case "handoff_failed":
    case "decode_error":
      state.starts.failures.total++;
      state.starts.failures.byReason.add(label(row.reason, kind));
      break;
    case "heartbeat":
      takeHeartbeat(state.watching, row);
      break;
    case "stall":
      takeStall(state.watching, row);
      break;
    case "session_end": {
      state.watching.endReasons.add(label(row.endReason));
      const startup = measure(row.startupMs);
      if (startup !== null) state.watching.startupMs.push(startup);
      break;
    }
    default:
      break;
  }
}

function takeRemuxSession(remux: RemuxState, row: Row): void {
  const upstream = amount(row.bytesUpstream);
  const served = amount(row.bytesServed);
  remux.sessions++;
  remux.bytesUpstream += upstream;
  remux.bytesServed += served;
  const cdn = remux.byCdn.of(label(row.cdn));
  cdn.sessions++;
  cdn.bytesUpstream += upstream;
  cdn.bytesServed += served;
  const lane = isRow(row.laneBps) ? measure(row.laneBps.median) : null;
  if (lane !== null) cdn.laneBps.push(lane);
  cdn.refusals += amount(row.refusals);
  cdn.silences += amount(row.silences);
  cdn.wrongRanges += amount(row.wrongRanges);
  const open = measure(row.openMs);
  if (open !== null) cdn.openMs.push(open);
  const first = measure(row.firstFragmentMs);
  if (first !== null) cdn.firstFragmentMs.push(first);
}

function takeCapacity(capacity: CapacityState, row: Row, at: number): void {
  capacity.snapshots++;
  for (const key of CAPACITY_SERIES) {
    const value = measure(row[key]);
    if (value !== null) capacity.series[key].push(value);
  }
  const sent = measure(row.txBps);
  const busiest = capacity.busiest;
  // The earliest of equally busy minutes, so the answer does not depend on the order of the lines.
  if (sent !== null && (busiest === null || sent > busiest.txBps || (sent === busiest.txBps && at < busiest.at))) {
    capacity.busiest = { at, txBps: sent };
  }
}

/** Passes one parsed line in: an event of the span is counted, anything else is passed over. */
function take(state: State, row: Row, name: string, at: number): void {
  switch (name) {
    case "discovery_summary":
      takeDiscovery(state.search, row);
      break;
    case "playback_answer":
      takeAnswer(state.search.answers, row);
      break;
    case "player_feedback":
      takeFeedback(state, row, label(row.feedbackEvent, ""));
      break;
    case "remux_session_summary":
      takeRemuxSession(state.remux, row);
      break;
    case "vod_open": {
      state.remux.opens.total++;
      state.remux.opens.byOutcome.add(label(row.outcome));
      const took = measure(row.tookMs);
      if (took !== null) state.remux.opens.tookMs.push(took);
      break;
    }
    case "capacity_snapshot":
      takeCapacity(state.capacity, row, at);
      break;
    case "provider_result": {
      const provider = state.providers.scraper.of(label(row.provider));
      provider.status.add(label(row.status));
      const ms = measure(row.ms);
      if (ms !== null) provider.ms.push(ms);
      break;
    }
    case "debrid_resolve_timing": {
      // A search that only read its cache is not a search; it would pull every median down.
      if ((measure(row.totalMs) ?? 0) < REAL_SEARCH_MIN_MS) break;
      for (const [field, service] of DEBRID_TIMES) {
        const ms = measure(row[field]);
        if (ms !== null) state.providers.debrid.of(service).push(ms);
      }
      break;
    }
    default:
      // Unknown events, and any event this version does not summarise, are ignored.
      break;
  }
}

/** The counts a watch group is made of: what the derived figures are computed from. */
type WatchTotals = Pick<WatchStats, "heartbeats" | "watchedMs" | "stalls" | "stalledMs" | "droppedFrames" | "decodedFrames">;

function totalsOf(watch: WatchSamples): WatchTotals {
  return {
    heartbeats: watch.heartbeats,
    watchedMs: watch.watchedMs,
    stalls: watch.stalls,
    stalledMs: watch.stalledMs,
    droppedFrames: watch.droppedFrames,
    decodedFrames: watch.decodedFrames,
  };
}

/** Every derived figure of a watch group, computed from its totals so that a sum of days gives the same result as a sum of events. */
function watchStats(totals: WatchTotals, bitrateBps: Percentiles | null, bandwidthBps: Percentiles | null, bufferAheadS: Percentiles | null): WatchStats {
  const hours = totals.watchedMs / HOUR_MS;
  return {
    ...totals,
    hours: round(hours),
    stallsPerHour: hours > 0 ? round(totals.stalls / hours) : null,
    droppedFrameRatio: totals.decodedFrames > 0 ? round(totals.droppedFrames / totals.decodedFrames, 4) : null,
    bitrateBps,
    bandwidthBps,
    bufferAheadS,
  };
}

const watchOf = (watch: WatchSamples): WatchStats => watchStats(totalsOf(watch), percentiles(watch.bitrate), percentiles(watch.bandwidth), percentiles(watch.buffer));
const timesOf = (times: TimesSamples): StartTimes => ({ timeToFirstFrameMs: percentiles(times.ttff), sinceOpenMs: percentiles(times.since) });
const cdnOf = (cdn: CdnSamples): CdnFigures => ({
  sessions: cdn.sessions,
  bytesUpstream: cdn.bytesUpstream,
  bytesServed: cdn.bytesServed,
  laneBps: percentiles(cdn.laneBps),
  refusals: cdn.refusals,
  silences: cdn.silences,
  wrongRanges: cdn.wrongRanges,
  openMs: percentiles(cdn.openMs),
  firstFragmentMs: percentiles(cdn.firstFragmentMs),
});

function figuresOf(state: State): RollupFigures {
  const { search, starts, watching, remux, capacity, providers } = state;
  const peak = (key: CapacitySeries) => peakOf(capacity.series[key]);
  return {
    searches: {
      discoveries: search.discoveries,
      byOutcome: search.byOutcome.toCounted(),
      found: search.found.map((tally) => tally.toCounted()),
      judged: search.judged.toCounted(),
      answers: {
        total: search.answers.total,
        byMode: search.answers.byMode.toCounted(),
        byCache: search.answers.byCache.toCounted(),
        totalMs: percentiles(search.answers.totalMs),
      },
    },
    starts: {
      total: starts.total,
      ...timesOf(starts.overall),
      byDevice: starts.byDevice.map(timesOf),
      byDelivery: starts.byDelivery.map(timesOf),
      byEngine: starts.byEngine.map(timesOf),
      failures: { total: starts.failures.total, byReason: starts.failures.byReason.toCounted() },
    },
    watching: {
      overall: watchOf(watching.overall),
      byDevice: watching.byDevice.map(watchOf),
      byQuality: watching.byQuality.map(watchOf),
      byDelivery: watching.byDelivery.map(watchOf),
      endReasons: watching.endReasons.toCounted(),
      startupMs: percentiles(watching.startupMs),
    },
    remux: {
      sessions: remux.sessions,
      bytesUpstream: remux.bytesUpstream,
      bytesServed: remux.bytesServed,
      byCdn: remux.byCdn.map(cdnOf),
      opens: { total: remux.opens.total, byOutcome: remux.opens.byOutcome.toCounted(), tookMs: percentiles(remux.opens.tookMs) },
    },
    capacity: {
      snapshots: capacity.snapshots,
      sessions: peak("sessions"),
      runs: peak("runs"),
      viewers: peak("viewers"),
      rxBps: peak("rxBps"),
      txBps: peak("txBps"),
      upstreamBps: peak("upstreamBps"),
      servedBps: peak("servedBps"),
      cpuPercent: peak("cpuPercent"),
      busiest: capacity.busiest,
    },
    providers: {
      scraper: providers.scraper.map((group) => ({
        hit: group.status.get("hit"),
        empty: group.status.get("empty"),
        error: group.status.get("error"),
        ms: percentiles(group.ms),
      })),
      debrid: providers.debrid.map((ms) => percentiles(ms)),
    },
  };
}

export interface FiguresBuilder {
  /** One parsed line of an event file. Anything that is not an event of the span is passed over. */
  add(line: unknown): void;
  finish(): { events: number; figures: RollupFigures };
}

/** Summarises the events whose time is in [from, to), one at a time. */
export function figuresBuilder(from: number, to: number): FiguresBuilder {
  const state = freshState();
  let events = 0;
  return {
    add(line: unknown): void {
      if (!isRow(line)) return;
      const name = line.event;
      const at = finite(line.at);
      // Written as "inside the span" so that bounds which are not numbers take nothing at all.
      if (typeof name !== "string" || at === null || !(at >= from && at < to)) return;
      events++;
      take(state, line, name, at);
    },
    finish(): { events: number; figures: RollupFigures } {
      return { events, figures: figuresOf(state) };
    },
  };
}

/** The rollup of one UTC day from its events, which are parsed lines (events of other days are passed over). */
export function buildDailyRollup(day: string, events: readonly unknown[]): DailyRollup {
  const start = dayStart(day);
  const builder = figuresBuilder(start, start + DAY_MS);
  for (const event of events) builder.add(event);
  const { events: count, figures } = builder.finish();
  return { day, events: count, ...figures };
}

function sumCounted(parts: readonly Counted[]): Counted {
  const tally = new Tally();
  for (const part of parts) for (const [key, count] of Object.entries(part)) tally.add(key, count);
  return tally.toCounted();
}

/** Records with the same keys, merged key by key. */
function mergeRecords<T>(records: ReadonlyArray<Record<string, T>>, merge: (items: T[]) => T): Record<string, T> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      const items = groups.get(key);
      if (items) items.push(value);
      else groups.set(key, [value]);
    }
  }
  return Object.fromEntries([...groups].map(([key, items]): [string, T] => [key, merge(items)]));
}

function mergeWatch(items: readonly WatchStats[]): WatchStats {
  const total = (pick: (watch: WatchStats) => number) => sum(items.map(pick));
  return watchStats(
    {
      heartbeats: total((watch) => watch.heartbeats),
      watchedMs: total((watch) => watch.watchedMs),
      stalls: total((watch) => watch.stalls),
      stalledMs: total((watch) => watch.stalledMs),
      droppedFrames: total((watch) => watch.droppedFrames),
      decodedFrames: total((watch) => watch.decodedFrames),
    },
    mergePercentiles(items.map((watch) => watch.bitrateBps)),
    mergePercentiles(items.map((watch) => watch.bandwidthBps)),
    mergePercentiles(items.map((watch) => watch.bufferAheadS)),
  );
}

function mergeTimes(items: readonly StartTimes[]): StartTimes {
  return {
    timeToFirstFrameMs: mergePercentiles(items.map((times) => times.timeToFirstFrameMs)),
    sinceOpenMs: mergePercentiles(items.map((times) => times.sinceOpenMs)),
  };
}

function mergeCdn(items: readonly CdnFigures[]): CdnFigures {
  const total = (pick: (cdn: CdnFigures) => number) => sum(items.map(pick));
  return {
    sessions: total((cdn) => cdn.sessions),
    bytesUpstream: total((cdn) => cdn.bytesUpstream),
    bytesServed: total((cdn) => cdn.bytesServed),
    laneBps: mergePercentiles(items.map((cdn) => cdn.laneBps)),
    refusals: total((cdn) => cdn.refusals),
    silences: total((cdn) => cdn.silences),
    wrongRanges: total((cdn) => cdn.wrongRanges),
    openMs: mergePercentiles(items.map((cdn) => cdn.openMs)),
    firstFragmentMs: mergePercentiles(items.map((cdn) => cdn.firstFragmentMs)),
  };
}

function mergeScraper(items: readonly ScraperFigures[]): ScraperFigures {
  return {
    hit: sum(items.map((item) => item.hit)),
    empty: sum(items.map((item) => item.empty)),
    error: sum(items.map((item) => item.error)),
    ms: mergePercentiles(items.map((item) => item.ms)),
  };
}

function busiestOf(days: readonly DailyRollup[]): CapacityFigures["busiest"] {
  let best: CapacityFigures["busiest"] = null;
  for (const day of days) {
    const busiest = day.capacity.busiest;
    if (busiest && (best === null || busiest.txBps > best.txBps || (busiest.txBps === best.txBps && busiest.at < best.at))) best = busiest;
  }
  return best;
}

/**
 * Several days as one span, for a view of months without their event lines.
 * Counts add up exactly. Percentiles and peaks are approximations of the
 * whole (see `mergePercentiles` and `mergePeaks`).
 */
export function summarizeRollups(days: readonly DailyRollup[]): RollupFigures {
  const pick = <T>(read: (day: DailyRollup) => T): T[] => days.map(read);
  return {
    searches: {
      discoveries: sum(pick((day) => day.searches.discoveries)),
      byOutcome: sumCounted(pick((day) => day.searches.byOutcome)),
      found: mergeRecords(pick((day) => day.searches.found), sumCounted),
      judged: sumCounted(pick((day) => day.searches.judged)),
      answers: {
        total: sum(pick((day) => day.searches.answers.total)),
        byMode: sumCounted(pick((day) => day.searches.answers.byMode)),
        byCache: sumCounted(pick((day) => day.searches.answers.byCache)),
        totalMs: mergePercentiles(pick((day) => day.searches.answers.totalMs)),
      },
    },
    starts: {
      total: sum(pick((day) => day.starts.total)),
      ...mergeTimes(pick((day) => day.starts)),
      byDevice: mergeRecords(pick((day) => day.starts.byDevice), mergeTimes),
      byDelivery: mergeRecords(pick((day) => day.starts.byDelivery), mergeTimes),
      byEngine: mergeRecords(pick((day) => day.starts.byEngine), mergeTimes),
      failures: {
        total: sum(pick((day) => day.starts.failures.total)),
        byReason: sumCounted(pick((day) => day.starts.failures.byReason)),
      },
    },
    watching: {
      overall: mergeWatch(pick((day) => day.watching.overall)),
      byDevice: mergeRecords(pick((day) => day.watching.byDevice), mergeWatch),
      byQuality: mergeRecords(pick((day) => day.watching.byQuality), mergeWatch),
      byDelivery: mergeRecords(pick((day) => day.watching.byDelivery), mergeWatch),
      endReasons: sumCounted(pick((day) => day.watching.endReasons)),
      startupMs: mergePercentiles(pick((day) => day.watching.startupMs)),
    },
    remux: {
      sessions: sum(pick((day) => day.remux.sessions)),
      bytesUpstream: sum(pick((day) => day.remux.bytesUpstream)),
      bytesServed: sum(pick((day) => day.remux.bytesServed)),
      byCdn: mergeRecords(pick((day) => day.remux.byCdn), mergeCdn),
      opens: {
        total: sum(pick((day) => day.remux.opens.total)),
        byOutcome: sumCounted(pick((day) => day.remux.opens.byOutcome)),
        tookMs: mergePercentiles(pick((day) => day.remux.opens.tookMs)),
      },
    },
    capacity: {
      snapshots: sum(pick((day) => day.capacity.snapshots)),
      sessions: mergePeaks(pick((day) => day.capacity.sessions)),
      runs: mergePeaks(pick((day) => day.capacity.runs)),
      viewers: mergePeaks(pick((day) => day.capacity.viewers)),
      rxBps: mergePeaks(pick((day) => day.capacity.rxBps)),
      txBps: mergePeaks(pick((day) => day.capacity.txBps)),
      upstreamBps: mergePeaks(pick((day) => day.capacity.upstreamBps)),
      servedBps: mergePeaks(pick((day) => day.capacity.servedBps)),
      cpuPercent: mergePeaks(pick((day) => day.capacity.cpuPercent)),
      busiest: busiestOf(days),
    },
    providers: {
      scraper: mergeRecords(pick((day) => day.providers.scraper), mergeScraper),
      debrid: mergeRecords(pick((day) => day.providers.debrid), mergePercentiles),
    },
  };
}

/** A rollup read back from its file, or null for a file that is not one (it is then written again). */
export function parseStoredRollup(text: string): StoredRollup | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRow(value) || typeof value.day !== "string" || finite(value.writtenAt) === null) return null;
  for (const key of ["searches", "starts", "watching", "remux", "capacity", "providers"]) {
    if (!isRow(value[key])) return null;
  }
  return value as unknown as StoredRollup;
}

export interface RollupOptions {
  /** The folder of the event files. Defaults to the folder the event log writes to. */
  eventsDir?: string;
  /** Where the rollups go. Defaults to `rollups` beside the events folder. */
  rollupsDir?: string;
  /** The time of the run. Defaults to now. */
  now?: number;
}

/** The day of each event file of the days before today, oldest day first. */
async function eventFilesByDay(dir: string, today: string): Promise<Map<string, string[]>> {
  const names = await readdir(dir).catch((): string[] => []);
  const byDay = new Map<string, string[]>();
  for (const name of names) {
    const day = eventDayOfFile(name);
    if (day === null || day >= today) continue;
    const files = byDay.get(day);
    if (files) files.push(name);
    else byDay.set(day, [name]);
  }
  return byDay;
}

/**
 * Whether a day's rollup must be written: it has none yet, or it is yesterday's
 * and was written before yesterday ended (late events of that day are then not
 * in it). Every other rollup is kept as it is.
 */
async function isDue(path: string, day: string, yesterday: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch((): null => null);
  const stored = text === null ? null : parseStoredRollup(text);
  if (stored === null) return true;
  return day === yesterday && stored.writtenAt < dayStart(day) + DAY_MS;
}

/**
 * Calls `onLine` for each line of a file as it is read in chunks, so the file is
 * never held whole. Errors of the read reach the caller (a line-reader over a
 * stream can swallow them and never finish).
 */
async function forEachLine(path: string, onLine: (line: string) => void): Promise<void> {
  let carry = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const parts = (carry + chunk).split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) onLine(line);
  }
  if (carry) onLine(carry);
}

/** One day's events, read a line at a time. A line that is not JSON (cut short by a restart) is passed over. */
async function readDay(dir: string, names: readonly string[], day: string): Promise<DailyRollup> {
  const start = dayStart(day);
  const builder = figuresBuilder(start, start + DAY_MS);
  for (const name of [...names].sort()) {
    await forEachLine(join(dir, name), (line) => {
      if (!line.trim()) return;
      try {
        builder.add(JSON.parse(line));
      } catch {
        // Not JSON: the line was cut short by a restart.
      }
    });
  }
  const { events, figures } = builder.finish();
  return { day, events, ...figures };
}

/** Written to a temporary name and renamed, so a reader never sees half a rollup. */
async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

/**
 * Writes the rollups that are due and returns their days, oldest first:
 * every day before today that has event files and no rollup yet, and yesterday's
 * when it was written before yesterday ended. Nothing is deleted. Days are read
 * one at a time, so only one day's figures are in memory at once.
 */
export async function writeRollups(options: RollupOptions = {}): Promise<string[]> {
  const eventsDir = options.eventsDir ?? eventLogDir();
  const rollupsDir = options.rollupsDir ?? join(dirname(eventsDir), "rollups");
  const now = options.now ?? Date.now();
  const today = dayOf(now);
  const yesterday = dayOf(now - DAY_MS);
  const byDay = await eventFilesByDay(eventsDir, today);
  const written: string[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const path = join(rollupsDir, `${day}.json`);
    if (!(await isDue(path, day, yesterday))) continue;
    const rollup = await readDay(eventsDir, byDay.get(day) ?? [], day);
    const stored: StoredRollup = { ...rollup, writtenAt: now };
    await mkdir(rollupsDir, { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(stored, null, 2)}\n`);
    written.push(day);
  }
  return written;
}

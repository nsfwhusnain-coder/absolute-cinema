/**
 * Reads the durable event log (see `event-log.ts`) into the numbers that say
 * how well the service finds and plays things: how often a title has a good
 * file, how long a start takes, where it fails, and on what.
 */
import {
  figuresBuilder,
  percentiles,
  REAL_SEARCH_MIN_MS,
  type CapacityFigures,
  type Peak,
  type Percentiles,
  type ProviderFigures,
  type RemuxFigures,
  type RollupFigures,
  type SearchFigures,
  type StartFigures,
  type StartTimes,
  type WatchFigures,
  type WatchStats,
} from "./telemetry/rollups";

export interface EventRow {
  at: number;
  event: string;
  [field: string]: unknown;
}

export type Counted = Record<string, number>;

export interface Quantiles {
  n: number;
  p50: number;
  p90: number;
}

export interface PlaybackReport {
  from: number;
  to: number;
  starts: {
    total: number;
    byDevice: Counted;
    byProvider: Counted;
    byPicture: Counted;
    byEngine: Counted;
    /** From choosing a file to its first picture. */
    startMs: Quantiles;
    startMsByProvider: Record<string, Quantiles>;
    /** From the player opening on a title to its first picture: the search and the start together. */
    waitMs: Quantiles;
    waitMsByDevice: Record<string, Quantiles>;
  };
  seeks: { total: number; seekMs: Quantiles; seekMsByProvider: Record<string, Quantiles> };
  failures: { failedStarts: number; byReason: Counted; byProvider: Counted; stalls: number; stallsByReason: Counted; failedStartsPerHundred: number };
  titles: { asked: number; with4k: number; withDebrid1080: number; webOnly: number; nothing: number; firstAnswerMs: Quantiles };
  search: { searches: number; totalMs: Quantiles; first1080Ms: Quantiles; first2160Ms: Quantiles };
  /** Files opened by a player. One made ready beforehand opens at once, and counts as that. */
  opens: { total: number; ok: number; okMs: Quantiles; byOutcome: Counted };
  /** Asks made ahead of Play from a title's page; `freshMs` times the ones that had to open the file. */
  readied: { asks: number; fresh: number; freshMs: Quantiles };
  remux: { runsStarted: number; viewersLeft: number; refusedForCapacity: number };
  webProviders: Record<string, { asked: number; found: number; medianMs: number }>;
  rejected: { otherTitle: number; otherLength: number; unusableLinks: number };
  /** The rollup figures of the same span (see `telemetry/rollups.ts`): searches, watching, remux and CDNs, capacity, providers. */
  figures: RollupFigures;
}

const UHD_MIN_LINES = 1500;
const HD_MIN_LINES = 780;
const HD_READY_MIN_LINES = 520;
/** An open this short found the file already open. */
const FRESH_OPEN_MIN_MS = 200;

const text = (value: unknown, fallback = "unknown") => (typeof value === "string" && value ? value : fallback);
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const count = (into: Counted, key: string) => void (into[key] = (into[key] ?? 0) + 1);

export function quantiles(values: readonly number[]): Quantiles {
  const shares = percentiles(values);
  return shares === null ? { n: 0, p50: 0, p90: 0 } : { n: shares.n, p50: Math.round(shares.p50), p90: Math.round(shares.p90) };
}

/** A wide 4K picture is 1600 lines and a wide 1080p one 800: the name is the one it is sold under. */
export function pictureName(lines: number): string {
  if (lines >= UHD_MIN_LINES) return "4K";
  if (lines >= HD_MIN_LINES) return "1080p";
  return lines >= HD_READY_MIN_LINES ? "720p" : "lower";
}

function deviceName(row: EventRow): string {
  const platform = (row.platform ?? {}) as Record<string, unknown>;
  return `${text(platform.uaPlatform)}/${text(platform.deviceClass)}`;
}

function startsOf(rows: readonly EventRow[]): PlaybackReport["starts"] {
  const none = quantiles([]);
  const starts: PlaybackReport["starts"] = { total: 0, byDevice: {}, byProvider: {}, byPicture: {}, byEngine: {}, startMs: none, startMsByProvider: {}, waitMs: none, waitMsByDevice: {} };
  const times: Record<string, number[]> = {};
  const waits: Record<string, number[]> = {};
  for (const row of rows) {
    if (row.event !== "player_feedback" || row.feedbackEvent !== "first_frame") continue;
    const provider = text(row.provider);
    starts.total++;
    count(starts.byDevice, deviceName(row));
    count(starts.byProvider, provider);
    count(starts.byPicture, pictureName(number(row.decodedHeight) ?? 0));
    count(starts.byEngine, text(row.engine));
    const took = number(row.timeToFirstFrameMs);
    if (took !== null) (times[provider] ??= []).push(took);
    const waited = number(row.sinceOpenMs);
    if (waited !== null) (waits[deviceName(row)] ??= []).push(waited);
  }
  starts.startMs = quantiles(Object.values(times).flat());
  starts.waitMs = quantiles(Object.values(waits).flat());
  for (const [provider, list] of Object.entries(times)) starts.startMsByProvider[provider] = quantiles(list);
  for (const [device, list] of Object.entries(waits)) starts.waitMsByDevice[device] = quantiles(list);
  return starts;
}

function seeksOf(rows: readonly EventRow[]): PlaybackReport["seeks"] {
  const times: Record<string, number[]> = {};
  for (const row of rows) {
    const took = row.event === "player_feedback" && row.feedbackEvent === "seek" ? number(row.seekMs) : null;
    if (took !== null) (times[text(row.provider)] ??= []).push(took);
  }
  const all = Object.values(times).flat();
  return { total: all.length, seekMs: quantiles(all), seekMsByProvider: Object.fromEntries(Object.entries(times).map(([p, list]) => [p, quantiles(list)])) };
}

function failuresOf(rows: readonly EventRow[], starts: number): PlaybackReport["failures"] {
  const failures: PlaybackReport["failures"] = { failedStarts: 0, byReason: {}, byProvider: {}, stalls: 0, stallsByReason: {}, failedStartsPerHundred: 0 };
  for (const row of rows) {
    if (row.event !== "player_feedback") continue;
    if (row.feedbackEvent === "handoff_failed" || row.feedbackEvent === "decode_error") {
      failures.failedStarts++;
      count(failures.byReason, text(row.reason, text(row.feedbackEvent)));
      count(failures.byProvider, text(row.provider));
    } else if (row.feedbackEvent === "stall") {
      failures.stalls++;
      count(failures.stallsByReason, text(row.reason));
    }
  }
  const attempts = starts + failures.failedStarts;
  failures.failedStartsPerHundred = attempts ? Math.round((failures.failedStarts * 1000) / attempts) / 10 : 0;
  return failures;
}

interface TitleAsked {
  best: number;
  bestDebrid: number;
  sources: number;
  firstAnswerMs: number | null;
}

/** One entry per viewer, title and day: the best any of its answers held, and how long its first search took. */
function titlesAsked(rows: readonly EventRow[]): TitleAsked[] {
  const asked = new Map<string, TitleAsked>();
  for (const row of rows) {
    if (row.event !== "playback_answer" || row.mode !== "full") continue;
    const day = new Date(row.at).toISOString().slice(0, 10);
    const key = [row.viewer, row.mediaType, row.tmdbId, row.season, row.episode, day].join("|");
    const entry = asked.get(key) ?? { best: 0, bestDebrid: 0, sources: 0, firstAnswerMs: null };
    entry.best = Math.max(entry.best, number(row.bestHeight) ?? 0);
    entry.bestDebrid = Math.max(entry.bestDebrid, number(row.bestDebridHeight) ?? 0);
    entry.sources = Math.max(entry.sources, number(row.sources) ?? 0);
    if (row.cache === "miss" && entry.firstAnswerMs === null) entry.firstAnswerMs = number(row.totalMs);
    asked.set(key, entry);
  }
  return [...asked.values()];
}

function titlesOf(rows: readonly EventRow[]): PlaybackReport["titles"] {
  const asked = titlesAsked(rows);
  const has4k = (t: TitleAsked) => t.best >= 2160;
  const hasDebrid = (t: TitleAsked) => !has4k(t) && t.bestDebrid >= 1080;
  return {
    asked: asked.length,
    with4k: asked.filter(has4k).length,
    withDebrid1080: asked.filter(hasDebrid).length,
    webOnly: asked.filter((t) => !has4k(t) && !hasDebrid(t) && t.sources > 0).length,
    nothing: asked.filter((t) => t.sources === 0).length,
    firstAnswerMs: quantiles(asked.flatMap((t) => (t.firstAnswerMs === null ? [] : [t.firstAnswerMs]))),
  };
}

function searchOf(rows: readonly EventRow[]): PlaybackReport["search"] {
  const real = rows.filter((r) => r.event === "debrid_resolve_timing" && (number(r.totalMs) ?? 0) >= REAL_SEARCH_MIN_MS);
  const of = (field: string) => quantiles(real.flatMap((r) => (number(r[field]) === null ? [] : [number(r[field])!])));
  return { searches: real.length, totalMs: of("totalMs"), first1080Ms: of("first1080Ms"), first2160Ms: of("first2160Ms") };
}

function readiedOf(rows: readonly EventRow[]): PlaybackReport["readied"] {
  const asks = rows.filter((r) => r.event === "vod_open" && r.prewarm === true);
  const fresh = asks.flatMap((r) => ((number(r.tookMs) ?? 0) >= FRESH_OPEN_MIN_MS && r.outcome === "ok" ? [number(r.tookMs)!] : []));
  return { asks: asks.length, fresh: fresh.length, freshMs: quantiles(fresh) };
}

function opensOf(rows: readonly EventRow[]): PlaybackReport["opens"] {
  const opens = rows.filter((r) => r.event === "vod_open" && r.prewarm !== true);
  const byOutcome: Counted = {};
  for (const row of opens) count(byOutcome, text(row.outcome));
  const ok = opens.filter((r) => r.outcome === "ok");
  return { total: opens.length, ok: ok.length, okMs: quantiles(ok.flatMap((r) => (number(r.tookMs) === null ? [] : [number(r.tookMs)!]))), byOutcome };
}

function remuxOf(rows: readonly EventRow[]): PlaybackReport["remux"] {
  const messages = rows.filter((r) => r.event === "vod").map((r) => text(r.message, ""));
  return {
    runsStarted: messages.filter((m) => /^run \d+ of /.test(m) && m.includes(" from segment ")).length,
    viewersLeft: messages.filter((m) => m.startsWith("left ")).length,
    refusedForCapacity: messages.filter((m) => m.startsWith("refused ")).length,
  };
}

function webProvidersOf(rows: readonly EventRow[]): PlaybackReport["webProviders"] {
  const times: Record<string, number[]> = {};
  const providers: PlaybackReport["webProviders"] = {};
  for (const row of rows) {
    if (row.event !== "provider_result") continue;
    const name = text(row.provider);
    const entry = (providers[name] ??= { asked: 0, found: 0, medianMs: 0 });
    entry.asked++;
    if (row.status === "hit") entry.found++;
    (times[name] ??= []).push(number(row.ms) ?? 0);
  }
  for (const [name, list] of Object.entries(times)) providers[name]!.medianMs = quantiles(list).p50;
  return providers;
}

export function buildPlaybackReport(rows: readonly EventRow[], from: number, to: number): PlaybackReport {
  const within = rows.filter((row) => row.at >= from && row.at < to);
  const starts = startsOf(within);
  const events = (name: string) => within.filter((r) => r.event === name).length;
  const figures = figuresBuilder(from, to);
  for (const row of within) figures.add(row);
  return {
    from,
    to,
    starts,
    seeks: seeksOf(within),
    failures: failuresOf(within, starts.total),
    titles: titlesOf(within),
    search: searchOf(within),
    opens: opensOf(within),
    readied: readiedOf(within),
    remux: remuxOf(within),
    webProviders: webProvidersOf(within),
    rejected: { otherTitle: events("debrid_other_title_rejected"), otherLength: events("vod_other_length_rejected"), unusableLinks: events("debrid_media_rejected") },
    figures: figures.finish().figures,
  };
}

/** The lines of event files as rows; a line that is not an event is passed over. */
export function parseEventLines(text: string): EventRow[] {
  const rows: EventRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as EventRow;
      if (typeof row.at === "number" && typeof row.event === "string") rows.push(row);
    } catch {
      // A line cut short by a restart.
    }
  }
  return rows;
}

/* The rollup figures, as the report's sections. Each heading says "no data" for what the log does not hold, never zeros. */

export const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const formatBufferSeconds = (seconds: number): string => `${seconds.toFixed(1)} s`;
export const formatMbit = (bps: number): string => `${(bps / 1e6).toFixed(1)} Mbit/s`;
const formatCount = (value: number): string => String(Math.round(value));
const formatPercent = (ratio: number): string => `${(ratio * 100).toFixed(2)}%`;
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/** "1080 4, 720 1": the most first; "none" for no keys. */
export function countedText(counted: Counted): string {
  return Object.entries(counted).sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key} ${n}`).join(", ") || "none";
}

const median = (p: Percentiles | null, unit: (value: number) => string): string => (p === null ? "no data" : `median ${unit(p.p50)}`);
/** "median 2.0 s, p10 1.0 s, p90 4.0 s (12)" */
const spread = (p: Percentiles | null, unit: (value: number) => string): string =>
  p === null ? "no data" : `median ${unit(p.p50)}, p10 ${unit(p.p10)}, p90 ${unit(p.p90)} (${p.n})`;
const peakText = (p: Peak | null, unit: (value: number) => string): string => (p === null ? "no data" : `peak ${unit(p.peak)}, p95 ${unit(p.p95)}`);

function searchLines(s: SearchFigures): string[] {
  const found = Object.entries(s.found)
    .filter(([, counted]) => Object.keys(counted).length > 0)
    .map(([service, counted]) => `${service} ${countedText(counted)}`);
  return [
    "SEARCHES",
    s.discoveries ? `  titles settled: ${s.discoveries}, by outcome ${countedText(s.byOutcome)}` : "  titles settled: no data",
    found.length ? `  files found, by service and quality: ${found.join("; ")}` : "  files found, by service and quality: no data",
    Object.keys(s.judged).length ? `  judged debrid files: ${countedText(s.judged)}` : "  judged debrid files: no data",
    s.answers.total
      ? `  answers: ${s.answers.total}, by mode ${countedText(s.answers.byMode)}, by cache ${countedText(s.answers.byCache)}`
      : "  answers: no data",
    `  answer time: ${spread(s.answers.totalMs, formatSeconds)}`,
  ];
}

function watchGroupLine(name: string, w: WatchStats): string {
  const perHour = w.stallsPerHour === null ? "no hours to count against" : `${w.stallsPerHour.toFixed(2)} per hour`;
  const dropped = w.droppedFrameRatio === null ? "no data" : formatPercent(w.droppedFrameRatio);
  return `    ${name}: ${w.hours.toFixed(1)} h, ${w.stalls} stalls (${perHour}), bit rate ${median(w.bitrateBps, formatMbit)}, bandwidth ${median(w.bandwidthBps, formatMbit)}, buffer ${median(w.bufferAheadS, formatBufferSeconds)}, dropped frames ${dropped}`;
}

/** The groups of a watch figure, the most hours first. */
function watchGroups(heading: string, groups: Record<string, WatchStats>): string[] {
  const sorted = Object.entries(groups).sort((a, b) => b[1].hours - a[1].hours);
  return sorted.length ? [`  ${heading}:`, ...sorted.map(([name, w]) => watchGroupLine(name, w))] : [];
}

/** "desktop median 2.0 s to picture from the file, 3.0 s from opening (2)" */
function startGroups(heading: string, groups: Record<string, StartTimes>): string {
  const parts = Object.entries(groups).map(([name, t]) => `${name} ${median(t.timeToFirstFrameMs, formatSeconds)} from the file, ${median(t.sinceOpenMs, formatSeconds)} from opening`);
  return `  first picture ${heading}: ${parts.join("; ") || "no data"}`;
}

function watchingLines(watching: WatchFigures, starts: StartFigures): string[] {
  const o = watching.overall;
  const hours = o.heartbeats ? `${o.hours.toFixed(1)} h (${o.heartbeats} heartbeats)` : "no data";
  const stalls = o.heartbeats || o.stalls
    ? `${o.stalls}, ${o.stallsPerHour === null ? "no hours to count against" : `${o.stallsPerHour.toFixed(2)} per hour`}, stalled ${formatSeconds(o.stalledMs)}`
    : "no data";
  const dropped = o.droppedFrameRatio === null ? "no data" : `${formatPercent(o.droppedFrameRatio)} of ${o.decodedFrames} decoded`;
  const ends = Object.keys(watching.endReasons).length ? `${countedText(watching.endReasons)}; startup ${spread(watching.startupMs, formatSeconds)}` : "no data";
  const firstPicture = starts.timeToFirstFrameMs ? `  first picture, file chosen to picture: ${spread(starts.timeToFirstFrameMs, formatSeconds)}` : "  first picture: no data";
  return [
    "WATCHING",
    `  hours watched: ${hours}`,
    `  stalls: ${stalls}`,
    `  delivered bit rate: ${spread(o.bitrateBps, formatMbit)}`,
    `  bandwidth estimate: ${spread(o.bandwidthBps, formatMbit)}`,
    `  buffer ahead: ${spread(o.bufferAheadS, formatBufferSeconds)}`,
    `  dropped frames: ${dropped}`,
    `  how titles were left: ${ends}`,
    firstPicture,
    startGroups("by device", starts.byDevice),
    startGroups("by delivery", starts.byDelivery),
    startGroups("by engine", starts.byEngine),
    ...watchGroups("by device", watching.byDevice),
    ...watchGroups("by quality", watching.byQuality),
    ...watchGroups("by delivery", watching.byDelivery),
  ];
}

function remuxLines(remux: RemuxFigures): string[] {
  const cdns = Object.entries(remux.byCdn).sort((a, b) => b[1].sessions - a[1].sessions);
  return [
    "REMUX AND CDNS",
    remux.sessions
      ? `  sessions: ${remux.sessions}; read from CDNs ${formatBytes(remux.bytesUpstream)}, handed to players ${formatBytes(remux.bytesServed)}`
      : "  sessions: no data",
    remux.opens.total
      ? `  file opens: ${remux.opens.total}, by outcome ${countedText(remux.opens.byOutcome)}; open ${median(remux.opens.tookMs, formatSeconds)}`
      : "  file opens: no data",
    ...(cdns.length
      ? cdns.map(
          ([cdn, c]) =>
            `  ${cdn}: sessions ${c.sessions}; lane speed ${spread(c.laneBps, formatMbit)}; refusals ${c.refusals}, silences ${c.silences}, wrong ranges ${c.wrongRanges}; index ${median(c.openMs, formatSeconds)}, first fragment ${median(c.firstFragmentMs, formatSeconds)}`,
        )
      : ["  per CDN: no data"]),
  ];
}

function capacityLines(c: CapacityFigures): string[] {
  if (c.snapshots === 0) return ["CAPACITY", "  no data"];
  const busiest = c.busiest
    ? `${new Date(c.busiest.at).toISOString().slice(0, 16).replace("T", " ")} UTC, sending ${formatMbit(c.busiest.txBps)}`
    : "no data";
  return [
    "CAPACITY",
    `  minutes sampled: ${c.snapshots}`,
    `  viewers: ${peakText(c.viewers, formatCount)}`,
    `  runs: ${peakText(c.runs, formatCount)}; sessions: ${peakText(c.sessions, formatCount)}`,
    `  container network, down: ${peakText(c.rxBps, formatMbit)}; up: ${peakText(c.txBps, formatMbit)}`,
    `  read from CDNs: ${peakText(c.upstreamBps, formatMbit)}; handed to players: ${peakText(c.servedBps, formatMbit)}`,
    `  remuxer cpu: ${peakText(c.cpuPercent, (value) => `${Math.round(value)}%`)}`,
    `  busiest minute: ${busiest}`,
  ];
}

function providerLines(p: ProviderFigures): string[] {
  const scrapers = Object.entries(p.scraper);
  const debrid = Object.entries(p.debrid).flatMap(([service, times]) => (times === null ? [] : [[service, times] as const]));
  return [
    "PROVIDERS",
    ...(scrapers.length
      ? scrapers.map(([name, s]) => `  scraper ${name}: ${s.hit} hit, ${s.empty} empty, ${s.error} error; ${median(s.ms, formatSeconds)}`)
      : ["  scrapers: no data"]),
    ...(debrid.length ? debrid.map(([service, times]) => `  debrid search ${service}: ${spread(times, formatSeconds)}`) : ["  debrid searches: no data"]),
  ];
}

/** The rollup figures as the report's last sections: searches, watching, remux and CDNs, capacity, providers. */
export function renderFigures(figures: RollupFigures): string[] {
  return [
    ...searchLines(figures.searches),
    "",
    ...watchingLines(figures.watching, figures.starts),
    "",
    ...remuxLines(figures.remux),
    "",
    ...capacityLines(figures.capacity),
    "",
    ...providerLines(figures.providers),
  ];
}

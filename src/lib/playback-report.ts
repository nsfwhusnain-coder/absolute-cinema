/**
 * Reads the durable event log (see `event-log.ts`) into the numbers that say
 * how well the service finds and plays things: how often a title has a good
 * file, how long a start takes, where it fails, and on what.
 */

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
  opens: { total: number; ok: number; okMs: Quantiles; byOutcome: Counted };
  remux: { runsStarted: number; viewersLeft: number; refusedForCapacity: number };
  webProviders: Record<string, { asked: number; found: number; medianMs: number }>;
  rejected: { otherTitle: number; otherLength: number; unusableLinks: number };
}

const UHD_MIN_LINES = 1500;
const HD_MIN_LINES = 780;
const HD_READY_MIN_LINES = 520;
/** A debrid search this short only read its cache. */
const REAL_SEARCH_MIN_MS = 100;

const text = (value: unknown, fallback = "unknown") => (typeof value === "string" && value ? value : fallback);
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const count = (into: Counted, key: string) => void (into[key] = (into[key] ?? 0) + 1);

export function quantiles(values: readonly number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!) : 0);
  return { n: sorted.length, p50: at(0.5), p90: at(0.9) };
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

function opensOf(rows: readonly EventRow[]): PlaybackReport["opens"] {
  const opens = rows.filter((r) => r.event === "vod_open");
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
  return {
    from,
    to,
    starts,
    seeks: seeksOf(within),
    failures: failuresOf(within, starts.total),
    titles: titlesOf(within),
    search: searchOf(within),
    opens: opensOf(within),
    remux: remuxOf(within),
    webProviders: webProvidersOf(within),
    rejected: { otherTitle: events("debrid_other_title_rejected"), otherLength: events("vod_other_length_rejected"), unusableLinks: events("debrid_media_rejected") },
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

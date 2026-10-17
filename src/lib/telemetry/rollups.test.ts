import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDailyRollup, mergePercentiles, parseStoredRollup, percentiles, peakOf, qualityBucket, summarizeRollups, writeRollups, type DailyRollup } from "./rollups";

const DAY = "2026-10-11";
const NOON = Date.UTC(2026, 9, 11, 12);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const ev = (event: string, fields: Record<string, unknown> = {}, at = NOON): Record<string, unknown> => ({ at, event, ...fields });
const feedback = (feedbackEvent: string, fields: Record<string, unknown> = {}, at = NOON) => ev("player_feedback", { feedbackEvent, ...fields }, at);

/** A day with every event type the report reads, the malformed lines a day can hold, and events of other days that must not count. */
function fixtureDay(): unknown[] {
  const at = (offsetMs: number) => NOON + offsetMs;
  return [
    // Searches (discovery_summary, playback_answer)
    ev("discovery_summary", { outcome: "2160", found: { realdebrid: { "2160": 2, "1080": 4 }, alldebrid: { "2160": 1 }, vixsrc: { "1080": 1 } }, judged: { realdebrid: { tier3: 2, tier2: 1, upscaled: 1 }, alldebrid: { tier3: 1 } } }),
    ev("discovery_summary", { outcome: "1080", found: { realdebrid: { "1080": 3 } }, judged: { realdebrid: { tier2: 2, starved: 1 } } }),
    ev("discovery_summary", { outcome: "web_only", found: { vixsrc: { "1080": 2 } } }),
    ev("discovery_summary", { outcome: "nothing", found: {} }),
    ev("discovery_summary", { outcome: "sd", found: { realdebrid: { sd: 1 } }, judged: "garbage" }),
    ev("playback_answer", { mode: "full", cache: "miss", totalMs: 2000 }),
    ev("playback_answer", { mode: "full", cache: "hit", totalMs: 20 }),
    ev("playback_answer", { mode: "fast", cache: "miss", totalMs: 4000 }),
    ev("playback_answer", { mode: "full", cache: "miss", totalMs: 6000 }),
    ev("playback_answer", { mode: "full", cache: "miss", totalMs: 10000 }),
    ev("playback_answer", { mode: "full", cache: "miss", totalMs: "slow" }),
    // Starts (first_frame) and failures
    feedback("first_frame", { timeToFirstFrameMs: 2000, sinceOpenMs: 3000, delivery: "remux", engine: "hlsjs", platform: { deviceClass: "desktop", uaPlatform: "chrome" }, decodedHeight: 1080 }),
    feedback("first_frame", { timeToFirstFrameMs: 4000, sinceOpenMs: 5500, delivery: "native", engine: "native_file", platform: { deviceClass: "tv" } }),
    feedback("first_frame", { timeToFirstFrameMs: 9000, sinceOpenMs: 12000, delivery: "remux", engine: "hlsjs", platform: { deviceClass: "desktop" } }),
    feedback("first_frame", {}),
    feedback("first_frame", { timeToFirstFrameMs: "3000" }),
    feedback("handoff_failed", { reason: "timeout", provider: "AllDebrid" }),
    feedback("decode_error", {}),
    // Heartbeats: 1h of playback in all, and one with nothing usable in it
    feedback("heartbeat", { delivery: "remux", engine: "hlsjs", decodedHeight: 1080, decodedWidth: 1920, platform: { deviceClass: "desktop" }, watchedMs: 1_800_000, bytesLoaded: 3_750_000, loadMs: 2500, bandwidthBps: 20_000_000, bufferAheadS: 25, droppedFrames: 5, decodedFrames: 1000, stalls: 0, stalledMs: 0 }),
    feedback("heartbeat", { delivery: "remux", decodedHeight: 2160, decodedWidth: 3840, platform: { deviceClass: "desktop" }, watchedMs: 1_800_000, bytesLoaded: 0, loadMs: 0, bandwidthBps: 40_000_000, bufferAheadS: 8, droppedFrames: 0, decodedFrames: 1000, stalls: 1, stalledMs: 1500 }),
    feedback("heartbeat", { delivery: "web", decodedHeight: 720, decodedWidth: 1280, platform: { deviceClass: "tv" }, watchedMs: 1_800_000, bytesLoaded: 1_000_000, loadMs: 1000, bandwidthBps: 0, bufferAheadS: -1, droppedFrames: 10, decodedFrames: 500 }),
    feedback("heartbeat", { delivery: "remux", decodedHeight: 800, decodedWidth: 1920, platform: { deviceClass: "desktop" }, watchedMs: 3_600_000, bytesLoaded: 7_500_000, loadMs: 5000, bandwidthBps: 30_000_000, bufferAheadS: 40, droppedFrames: 0, decodedFrames: 2000 }),
    feedback("heartbeat", { watchedMs: "lots", bytesLoaded: -5, loadMs: 0, decodedFrames: "many" }),
    feedback("stall", { reason: "rebuffering", decodedHeight: 1080, platform: { deviceClass: "desktop" }, stalledMs: 800 }),
    feedback("session_end", { endReason: "ended", startupMs: 2000 }),
    feedback("session_end", { endReason: "left", startupMs: null }),
    feedback("session_end", { endReason: "failed", startupMs: 6000 }),
    // Remux: sessions per CDN, and file opens
    ev("remux_session_summary", { session: "a", cdn: "real-debrid.com", bytesUpstream: 1_000_000_000, bytesServed: 900_000_000, laneBps: { min: 1e6, median: 8e6, max: 20e6 }, refusals: 2, silences: 0, wrongRanges: 1, openMs: 300, firstFragmentMs: 1500 }),
    ev("remux_session_summary", { session: "b", cdn: "real-debrid.com", bytesUpstream: 500_000_000, bytesServed: 450_000_000, laneBps: { median: 4e6 }, refusals: 1, silences: 2, wrongRanges: 0, openMs: 900, firstFragmentMs: 2500 }),
    ev("remux_session_summary", { session: "c", cdn: "debrid.it", bytesUpstream: 100, bytesServed: 100, laneBps: { median: "fast" }, openMs: null }),
    ev("vod_open", { outcome: "ok", tookMs: 1000 }),
    ev("vod_open", { outcome: "ok", tookMs: 3000 }),
    ev("vod_open", { outcome: "remux capacity reached", tookMs: 40 }),
    ev("vod_open", { outcome: "ok", tookMs: 2000, prewarm: true }),
    // Capacity: four minutes; the first of the two equally busy ones is the busiest
    ev("capacity_snapshot", { sessions: 1, runs: 2, viewers: 2, rxBps: 10e6, txBps: 50e6, upstreamBps: 12e6, servedBps: 40e6, cpuPercent: 30 }, at(0)),
    ev("capacity_snapshot", { sessions: 3, runs: 4, viewers: 5, rxBps: 20e6, txBps: 90e6, upstreamBps: 30e6, servedBps: 80e6, cpuPercent: 120 }, at(60_000)),
    ev("capacity_snapshot", { sessions: 2, runs: 3, viewers: 4, rxBps: 15e6, txBps: 70e6, upstreamBps: 20e6, servedBps: 60e6, cpuPercent: 60 }, at(120_000)),
    ev("capacity_snapshot", { sessions: 1, runs: 1, viewers: 1, rxBps: 5e6, txBps: 90e6, upstreamBps: 5e6, servedBps: 20e6, cpuPercent: 10 }, at(180_000)),
    // Scraper providers and debrid search times
    ev("provider_result", { provider: "vixsrc", status: "hit", ms: 1000, mode: "fast" }),
    ev("provider_result", { provider: "vixsrc", status: "empty", ms: 300 }),
    ev("provider_result", { provider: "vixsrc", status: "error", ms: 9000 }),
    ev("provider_result", { provider: "torrentio", status: "hit", ms: 2000 }),
    ev("debrid_resolve_timing", { totalMs: 2400, realDebridMs: 2000, allDebridMs: 2300, first1080Ms: 1500 }),
    ev("debrid_resolve_timing", { totalMs: 9, realDebridMs: 5 }),
    ev("debrid_resolve_timing", { totalMs: 5000, realDebridMs: 4000, realDebridPartialMs: 3000 }),
    // Unknown events are counted as events and otherwise ignored
    ev("something_new", { x: 1 }),
    ev("vod", { message: "run 0 of abc from segment 0 (0.0s)" }),
    // Malformed lines: none of these is an event of the day
    null,
    "text",
    42,
    [1, 2],
    { event: "discovery_summary", outcome: "2160" },
    { at: "2026-10-11", event: "discovery_summary" },
    { at: NOON },
    { at: NOON, event: 5 },
    { at: Number.NaN, event: "discovery_summary" },
    // Events of other days
    ev("discovery_summary", { outcome: "2160" }, NOON + DAY_MS),
    ev("discovery_summary", { outcome: "2160" }, NOON - 12 * HOUR_MS - 1),
  ];
}

describe("buildDailyRollup", () => {
  const rollup = buildDailyRollup(DAY, fixtureDay());

  it("counts the events of the day, and only those", () => {
    expect(rollup.day).toBe(DAY);
    expect(rollup.events).toBe(47);
  });

  it("summarises searches: outcomes, files found per service and quality, judged verdicts, answer times", () => {
    expect(rollup.searches.discoveries).toBe(5);
    expect(rollup.searches.byOutcome).toEqual({ "2160": 1, "1080": 1, web_only: 1, nothing: 1, sd: 1 });
    expect(rollup.searches.found).toEqual({
      realdebrid: { "2160": 2, "1080": 7, sd: 1 },
      alldebrid: { "2160": 1 },
      vixsrc: { "1080": 3 },
    });
    expect(rollup.searches.judged).toEqual({ tier3: 3, tier2: 3, upscaled: 1, starved: 1 });
    expect(rollup.searches.answers.total).toBe(6);
    expect(rollup.searches.answers.byMode).toEqual({ full: 5, fast: 1 });
    expect(rollup.searches.answers.byCache).toEqual({ miss: 5, hit: 1 });
    expect(rollup.searches.answers.totalMs).toEqual({ n: 5, p10: 20, p50: 4000, p90: 10000 });
  });

  it("times starts overall and by device class, delivery and engine, and counts failures by reason", () => {
    expect(rollup.starts.total).toBe(5);
    expect(rollup.starts.timeToFirstFrameMs).toEqual({ n: 3, p10: 2000, p50: 4000, p90: 9000 });
    expect(rollup.starts.sinceOpenMs).toEqual({ n: 3, p10: 3000, p50: 5500, p90: 12000 });
    expect(rollup.starts.byDevice.desktop).toEqual({
      timeToFirstFrameMs: { n: 2, p10: 2000, p50: 9000, p90: 9000 },
      sinceOpenMs: { n: 2, p10: 3000, p50: 12000, p90: 12000 },
    });
    expect(rollup.starts.byDevice.tv?.timeToFirstFrameMs).toEqual({ n: 1, p10: 4000, p50: 4000, p90: 4000 });
    // Starts with no device, delivery or engine are kept under "unknown"; with no times they have no percentiles.
    expect(rollup.starts.byDevice.unknown).toEqual({ timeToFirstFrameMs: null, sinceOpenMs: null });
    expect(rollup.starts.byDelivery.native?.timeToFirstFrameMs?.p50).toBe(4000);
    expect(rollup.starts.byEngine.hlsjs?.timeToFirstFrameMs?.p50).toBe(9000);
    expect(rollup.starts.failures).toEqual({ total: 2, byReason: { timeout: 1, decode_error: 1 } });
  });

  it("sums watching over heartbeats and stall events, and computes the rates from the sums", () => {
    const overall = rollup.watching.overall;
    expect(overall.heartbeats).toBe(5);
    expect(overall.hours).toBe(2.5);
    expect(overall.stalls).toBe(2);
    expect(overall.stalledMs).toBe(2300);
    expect(overall.stallsPerHour).toBe(0.8);
    expect(overall.decodedFrames).toBe(4500);
    expect(overall.droppedFrames).toBe(15);
    expect(overall.droppedFrameRatio).toBe(0.0033);
    // Bytes over the time spent loading them: 3.75 MB in 2.5 s is 12 Mbit/s; the heartbeat that loaded nothing has no rate.
    expect(overall.bitrateBps).toEqual({ n: 3, p10: 8_000_000, p50: 12_000_000, p90: 12_000_000 });
    expect(overall.bandwidthBps).toEqual({ n: 3, p10: 20_000_000, p50: 30_000_000, p90: 40_000_000 });
    expect(overall.bufferAheadS).toEqual({ n: 3, p10: 8, p50: 25, p90: 40 });
  });

  it("gives the same watching figures by device, quality and delivery", () => {
    const { byDevice, byQuality, byDelivery } = rollup.watching;
    expect(byDevice.desktop).toMatchObject({ heartbeats: 3, hours: 2, stalls: 2, stallsPerHour: 1, stalledMs: 2300 });
    expect(byDevice.desktop?.bitrateBps).toEqual({ n: 2, p10: 12_000_000, p50: 12_000_000, p90: 12_000_000 });
    expect(byDevice.tv).toMatchObject({ heartbeats: 1, hours: 0.5, stalls: 0, stallsPerHour: 0 });
    expect(byDevice.unknown).toMatchObject({ heartbeats: 1, hours: 0, stalls: 0, stallsPerHour: null, droppedFrameRatio: null, bitrateBps: null });
    // A scope film (1920 wide, 800 high) is a 1080p film; the stall reported at 1080 lines is counted there too.
    expect(byQuality["1080"]).toMatchObject({ heartbeats: 2, hours: 1.5, stalls: 1, stallsPerHour: 0.67, stalledMs: 800 });
    expect(byQuality["2160"]).toMatchObject({ heartbeats: 1, hours: 0.5, stalls: 1, stallsPerHour: 2 });
    expect(byQuality["720"]).toMatchObject({ heartbeats: 1, hours: 0.5, stalls: 0 });
    expect(byQuality.unknown?.heartbeats).toBe(1);
    expect(byDelivery.remux).toMatchObject({ heartbeats: 3, hours: 2, stalls: 1, stallsPerHour: 0.5 });
    // A stall reported without a delivery has no hours to be counted against.
    expect(byDelivery.unknown).toMatchObject({ heartbeats: 1, stalls: 1, stallsPerHour: null });
  });

  it("counts how titles were left, and the startup times of the ones that started", () => {
    expect(rollup.watching.endReasons).toEqual({ ended: 1, left: 1, failed: 1 });
    expect(rollup.watching.startupMs).toEqual({ n: 2, p10: 2000, p50: 6000, p90: 6000 });
  });

  it("summarises remux sessions per CDN and the file opens by outcome", () => {
    const { remux } = rollup;
    expect(remux.sessions).toBe(3);
    expect(remux.bytesUpstream).toBe(1_500_000_100);
    expect(remux.bytesServed).toBe(1_350_000_100);
    expect(remux.byCdn["real-debrid.com"]).toEqual({
      sessions: 2,
      bytesUpstream: 1_500_000_000,
      bytesServed: 1_350_000_000,
      laneBps: { n: 2, p10: 4_000_000, p50: 8_000_000, p90: 8_000_000 },
      refusals: 3,
      silences: 2,
      wrongRanges: 1,
      openMs: { n: 2, p10: 300, p50: 900, p90: 900 },
      firstFragmentMs: { n: 2, p10: 1500, p50: 2500, p90: 2500 },
    });
    expect(remux.byCdn["debrid.it"]).toMatchObject({ sessions: 1, laneBps: null, openMs: null, firstFragmentMs: null });
    expect(remux.opens).toEqual({ total: 4, byOutcome: { ok: 3, "remux capacity reached": 1 }, tookMs: { n: 4, p10: 40, p50: 2000, p90: 3000 } });
  });

  it("finds the peak and the 95th percentile of each capacity series, and the busiest minute", () => {
    const { capacity } = rollup;
    expect(capacity.snapshots).toBe(4);
    expect(capacity.viewers).toEqual({ peak: 5, p95: 5 });
    expect(capacity.runs).toEqual({ peak: 4, p95: 4 });
    expect(capacity.sessions).toEqual({ peak: 3, p95: 3 });
    expect(capacity.rxBps).toEqual({ peak: 20_000_000, p95: 20_000_000 });
    expect(capacity.txBps).toEqual({ peak: 90_000_000, p95: 90_000_000 });
    expect(capacity.upstreamBps).toEqual({ peak: 30_000_000, p95: 30_000_000 });
    expect(capacity.servedBps).toEqual({ peak: 80_000_000, p95: 80_000_000 });
    expect(capacity.cpuPercent).toEqual({ peak: 120, p95: 120 });
    expect(capacity.busiest).toEqual({ at: NOON + 60_000, txBps: 90_000_000 });
  });

  it("summarises the scraper's providers and the debrid search times per service", () => {
    expect(rollup.providers.scraper.vixsrc).toEqual({ hit: 1, empty: 1, error: 1, ms: { n: 3, p10: 300, p50: 1000, p90: 9000 } });
    expect(rollup.providers.scraper.torrentio).toEqual({ hit: 1, empty: 0, error: 0, ms: { n: 1, p10: 2000, p50: 2000, p90: 2000 } });
    // The search that only read its cache (9 ms) is left out of every service.
    expect(rollup.providers.debrid.total).toEqual({ n: 2, p10: 2400, p50: 5000, p90: 5000 });
    expect(rollup.providers.debrid.realDebrid).toEqual({ n: 2, p10: 2000, p50: 4000, p90: 4000 });
    expect(rollup.providers.debrid.allDebrid).toEqual({ n: 1, p10: 2300, p50: 2300, p90: 2300 });
    expect(rollup.providers.debrid.realDebridPartial).toEqual({ n: 1, p10: 3000, p50: 3000, p90: 3000 });
    expect(rollup.providers.debrid.torbox).toBeUndefined();
  });

  it("gives nulls and empty objects for a day with no events, never NaN", () => {
    const empty = buildDailyRollup("2026-10-12", []);
    expect(empty.events).toBe(0);
    expect(empty.searches.discoveries).toBe(0);
    expect(empty.searches.answers.totalMs).toBeNull();
    expect(empty.searches.found).toEqual({});
    expect(empty.starts.timeToFirstFrameMs).toBeNull();
    expect(empty.watching.overall).toMatchObject({ heartbeats: 0, hours: 0, stallsPerHour: null, droppedFrameRatio: null, bitrateBps: null });
    expect(empty.watching.startupMs).toBeNull();
    expect(empty.remux.byCdn).toEqual({});
    expect(empty.capacity).toMatchObject({ snapshots: 0, sessions: null, txBps: null, busiest: null });
    expect(empty.providers).toEqual({ scraper: {}, debrid: {} });
  });

  it("is plain JSON: it has no NaN and survives a round trip", () => {
    const text = JSON.stringify(rollup);
    expect(text).not.toContain("NaN");
    expect(JSON.parse(text)).toEqual(rollup);
  });
});

describe("percentiles and peaks", () => {
  it("gives null for no samples and the nearest sample otherwise", () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([5, 1, 3, 2, 4, 6, 7, 8, 9, 10])).toEqual({ n: 10, p10: 2, p50: 6, p90: 10 });
    expect(peakOf([])).toBeNull();
    expect(peakOf([3, 9, 1])).toEqual({ peak: 9, p95: 9 });
  });

  it("merges percentiles by their sample counts", () => {
    expect(mergePercentiles([{ n: 3, p10: 8, p50: 12, p90: 12 }, null, { n: 1, p10: 4, p50: 8, p90: 8 }])).toEqual({ n: 4, p10: 7, p50: 11, p90: 11 });
    expect(mergePercentiles([null])).toBeNull();
  });
});

describe("qualityBucket", () => {
  it("buckets a picture by its height, and a scope film by its width", () => {
    expect([qualityBucket(2160, 3840), qualityBucket(1440, 2560), qualityBucket(1080, 1920), qualityBucket(720, 1280), qualityBucket(480, 854)]).toEqual(["2160", "1440", "1080", "720", "sd"]);
    expect([qualityBucket(800, 1920), qualityBucket(1600, 3840), qualityBucket(534, 1280), qualityBucket(1440, 3440)]).toEqual(["1080", "2160", "720", "1440"]);
    expect([qualityBucket(null, null), qualityBucket(0, 0), qualityBucket(null, 1920), qualityBucket(1080, null)]).toEqual(["unknown", "unknown", "1080", "1080"]);
  });
});

describe("summarizeRollups", () => {
  const dayTwo = (): unknown[] => [
    ev("discovery_summary", { outcome: "1080" }, NOON + DAY_MS),
    feedback("heartbeat", { watchedMs: HOUR_MS, bytesLoaded: 1_000_000, loadMs: 1000, decodedHeight: 1080, decodedWidth: 1920, platform: { deviceClass: "desktop" }, delivery: "remux", stalls: 1, decodedFrames: 100, droppedFrames: 0, bufferAheadS: 10 }, NOON + DAY_MS),
    ev("capacity_snapshot", { viewers: 3, txBps: 40_000_000 }, NOON + DAY_MS),
  ];

  it("adds counts up, merges percentiles by samples, and keeps the busiest minute of the days", () => {
    const first = buildDailyRollup(DAY, fixtureDay());
    const second: DailyRollup = buildDailyRollup("2026-10-12", dayTwo());
    const all = summarizeRollups([first, second]);
    expect(all.searches.discoveries).toBe(6);
    expect(all.searches.byOutcome["1080"]).toBe(2);
    expect(all.watching.overall.hours).toBe(3.5);
    expect(all.watching.overall.stalls).toBe(3);
    expect(all.watching.overall.stallsPerHour).toBe(0.86);
    // Three samples of 12 Mbit/s and one of 8 Mbit/s: the median of the four is 11 Mbit/s.
    expect(all.watching.overall.bitrateBps).toEqual({ n: 4, p10: 8_000_000, p50: 11_000_000, p90: 11_000_000 });
    expect(all.capacity.viewers).toEqual({ peak: 5, p95: 4 });
    expect(all.capacity.busiest).toEqual({ at: NOON + 60_000, txBps: 90_000_000 });
    expect(all.remux.byCdn["real-debrid.com"]?.sessions).toBe(2);
  });

  it("summarises no days as empty figures", () => {
    const none = summarizeRollups([]);
    expect(none.searches.discoveries).toBe(0);
    expect(none.watching.overall.bitrateBps).toBeNull();
    expect(none.capacity.busiest).toBeNull();
  });
});

describe("parseStoredRollup", () => {
  it("reads a rollup file and passes over anything that is not one", () => {
    const stored = { ...buildDailyRollup(DAY, fixtureDay()), writtenAt: NOON };
    expect(parseStoredRollup(JSON.stringify(stored))?.day).toBe(DAY);
    expect(parseStoredRollup("{")).toBeNull();
    expect(parseStoredRollup("[]")).toBeNull();
    expect(parseStoredRollup(JSON.stringify({ day: DAY, writtenAt: NOON }))).toBeNull();
  });
});

describe("writeRollups", () => {
  // 2026-10-12 01:00 UTC: today is the 12th, yesterday the 11th.
  const NOW = Date.UTC(2026, 9, 12, 1);
  const D9 = Date.UTC(2026, 9, 9, 12);
  const D10 = Date.UTC(2026, 9, 10, 12);
  let root: string;
  let eventsDir: string;
  let rollupsDir: string;

  const lines = (items: unknown[]) => `${items.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n")}\n`;
  const stored = (day: string) => JSON.parse(readFileSync(join(rollupsDir, `${day}.json`), "utf8"));
  const rewrite = (day: string, change: Record<string, unknown>) => writeFileSync(join(rollupsDir, `${day}.json`), JSON.stringify({ ...stored(day), ...change }));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rollups-"));
    eventsDir = join(root, "events");
    rollupsDir = join(root, "rollups");
    mkdirSync(eventsDir);
    writeFileSync(join(eventsDir, "web-2026-10-09.jsonl"), lines([ev("discovery_summary", { outcome: "2160" }, D9), "{not json"]));
    writeFileSync(
      join(eventsDir, "web-2026-10-10.jsonl"),
      lines([ev("discovery_summary", { outcome: "1080" }, D10), ev("playback_answer", { mode: "full", cache: "miss", totalMs: 3000 }, D10)]),
    );
    writeFileSync(join(eventsDir, "remux-2026-10-10.jsonl"), lines([ev("remux_session_summary", { cdn: "real-debrid.com", bytesUpstream: 10, bytesServed: 5 }, D10)]));
    writeFileSync(join(eventsDir, "web-2026-10-11.jsonl"), lines([ev("discovery_summary", { outcome: "sd" }, NOON)]));
    writeFileSync(join(eventsDir, "scraper-2026-10-12.jsonl"), lines([ev("provider_result", { provider: "vixsrc", status: "hit", ms: 100 }, NOW)]));
    writeFileSync(join(eventsDir, "notes.txt"), "not an event file\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a rollup for each day before today that has events, beside the events folder", async () => {
    const written = await writeRollups({ eventsDir, now: NOW });
    expect(written).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(stored("2026-10-09")).toMatchObject({ day: "2026-10-09", events: 1, writtenAt: NOW });
    expect(stored("2026-10-09").searches.byOutcome).toEqual({ "2160": 1 });
    expect(stored("2026-10-10").searches).toMatchObject({ discoveries: 1, answers: { total: 1 } });
    expect(stored("2026-10-10").remux.sessions).toBe(1);
    expect(existsSync(join(rollupsDir, "2026-10-12.json"))).toBe(false);
  });

  it("writes nothing the second time, and leaves the files as they were", async () => {
    await writeRollups({ eventsDir, now: NOW });
    const before = readFileSync(join(rollupsDir, "2026-10-11.json"), "utf8");
    expect(await writeRollups({ eventsDir, now: NOW + 30 * 60_000 })).toEqual([]);
    expect(readFileSync(join(rollupsDir, "2026-10-11.json"), "utf8")).toBe(before);
  });

  it("rewrites yesterday's rollup when it was written before yesterday ended, and no other day's", async () => {
    await writeRollups({ eventsDir, now: NOW });
    rewrite("2026-10-11", { writtenAt: NOON });
    rewrite("2026-10-10", { writtenAt: D10 });
    writeFileSync(join(eventsDir, "web-2026-10-11.jsonl"), lines([ev("discovery_summary", { outcome: "sd" }, NOON), ev("discovery_summary", { outcome: "2160" }, NOON + 60_000)]));
    expect(await writeRollups({ eventsDir, now: NOW })).toEqual(["2026-10-11"]);
    expect(stored("2026-10-11")).toMatchObject({ writtenAt: NOW, events: 2 });
    expect(stored("2026-10-11").searches.discoveries).toBe(2);
    expect(stored("2026-10-10").writtenAt).toBe(D10);
  });

  it("writes again a rollup file that is not one, and never deletes a rollup", async () => {
    mkdirSync(rollupsDir);
    writeFileSync(join(rollupsDir, "2026-10-09.json"), "{");
    writeFileSync(join(rollupsDir, "2025-01-01.json"), '{"kept":true}');
    expect(await writeRollups({ eventsDir, now: NOW })).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(stored("2026-10-09").day).toBe("2026-10-09");
    expect(readFileSync(join(rollupsDir, "2025-01-01.json"), "utf8")).toBe('{"kept":true}');
  });

  it("does nothing when there is no events folder", async () => {
    expect(await writeRollups({ eventsDir: join(root, "missing"), now: NOW })).toEqual([]);
    expect(existsSync(join(root, "rollups"))).toBe(false);
  });
});

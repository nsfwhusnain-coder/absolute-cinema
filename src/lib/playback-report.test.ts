import { describe, expect, it } from "bun:test";
import { buildPlaybackReport, parseEventLines, pictureName, quantiles, type EventRow } from "./playback-report";

const T = Date.UTC(2026, 9, 11, 12);
const feedback = (feedbackEvent: string, fields: Record<string, unknown> = {}): EventRow => ({
  at: T, event: "player_feedback", feedbackEvent, provider: "Debrid", platform: { uaPlatform: "chrome", deviceClass: "desktop" }, ...fields,
});
const answer = (fields: Record<string, unknown>): EventRow => ({
  at: T, event: "playback_answer", mode: "full", cache: "miss", viewer: "v1", mediaType: "movie", tmdbId: 1, totalMs: 3000, ...fields,
});
const report = (rows: EventRow[]) => buildPlaybackReport(rows, T - 1000, T + 1000);

describe("quantiles and picture names", () => {
  it("gives the middle and the ninth-tenth value, and zeroes for nothing", () => {
    expect(quantiles([5, 1, 3, 2, 4, 6, 7, 8, 9, 10])).toEqual({ n: 10, p50: 6, p90: 10 });
    expect(quantiles([])).toEqual({ n: 0, p50: 0, p90: 0 });
  });

  it("names a wide picture by what it is sold as", () => {
    expect([2160, 1600, 1080, 800, 720, 534, 480].map(pictureName)).toEqual(["4K", "4K", "1080p", "1080p", "720p", "720p", "lower"]);
  });
});

describe("buildPlaybackReport", () => {
  it("counts starts by device, service, picture and engine, with how long they took", () => {
    const { starts } = report([
      feedback("first_frame", { timeToFirstFrameMs: 3000, decodedHeight: 1600, engine: "hlsjs" }),
      feedback("first_frame", { timeToFirstFrameMs: 5000, decodedHeight: 800, engine: "native_file", provider: "AllDebrid", platform: { uaPlatform: "web0s", deviceClass: "tv" } }),
      feedback("sustained_play"),
    ]);
    expect(starts.total).toBe(2);
    expect(starts.byDevice).toEqual({ "chrome/desktop": 1, "web0s/tv": 1 });
    expect(starts.byProvider).toEqual({ Debrid: 1, AllDebrid: 1 });
    expect(starts.byPicture).toEqual({ "4K": 1, "1080p": 1 });
    expect(starts.byEngine).toEqual({ hlsjs: 1, native_file: 1 });
    expect(starts.startMsByProvider.Debrid).toEqual({ n: 1, p50: 3000, p90: 3000 });
  });

  it("keeps the viewer's whole wait apart from the start of the file, and times jumps", () => {
    const { starts, seeks } = report([
      feedback("first_frame", { timeToFirstFrameMs: 3000, sinceOpenMs: 7000 }),
      feedback("first_frame", { timeToFirstFrameMs: 400 }),
      feedback("seek", { seekMs: 4000 }),
      feedback("seek", { seekMs: 300, provider: "Vixsrc" }),
    ]);
    expect(starts.waitMs).toEqual({ n: 1, p50: 7000, p90: 7000 });
    expect(starts.waitMsByDevice).toEqual({ "chrome/desktop": { n: 1, p50: 7000, p90: 7000 } });
    expect(starts.startMs.n).toBe(2);
    expect(seeks).toEqual({ total: 2, seekMs: { n: 2, p50: 4000, p90: 4000 }, seekMsByProvider: { Debrid: { n: 1, p50: 4000, p90: 4000 }, Vixsrc: { n: 1, p50: 300, p90: 300 } } });
  });

  it("counts failed starts and stalls by reason, and the share of attempts that failed", () => {
    const { failures } = report([
      feedback("first_frame"), feedback("first_frame"), feedback("first_frame"),
      feedback("handoff_failed", { reason: "timeout", provider: "AllDebrid" }),
      feedback("stall", { reason: "rebuffering" }),
    ]);
    expect(failures).toEqual({ failedStarts: 1, byReason: { timeout: 1 }, byProvider: { AllDebrid: 1 }, stalls: 1, stallsByReason: { rebuffering: 1 }, failedStartsPerHundred: 25 });
  });

  it("sorts each title asked for by the best any of its answers held", () => {
    const { titles } = report([
      answer({ tmdbId: 1, bestHeight: 1080, bestDebridHeight: 1080, sources: 2, totalMs: 2500 }),
      answer({ tmdbId: 1, bestHeight: 2160, bestDebridHeight: 2160, sources: 5, cache: "hit", totalMs: 20 }),
      answer({ tmdbId: 2, bestHeight: 1080, bestDebridHeight: 1080, sources: 3, totalMs: 4000 }),
      answer({ tmdbId: 3, bestHeight: 1080, bestDebridHeight: 0, sources: 2 }),
      answer({ tmdbId: 4, bestHeight: 0, bestDebridHeight: 0, sources: 0 }),
      answer({ tmdbId: 5, mode: "fast", bestHeight: 2160, sources: 1 }),
    ]);
    expect(titles).toMatchObject({ asked: 4, with4k: 1, withDebrid1080: 1, webOnly: 1, nothing: 1 });
    expect(titles.firstAnswerMs).toEqual({ n: 4, p50: 3000, p90: 4000 });
  });

  it("times real searches and opens, and passes over a search that only read its cache", () => {
    const { search, opens } = report([
      { at: T, event: "debrid_resolve_timing", totalMs: 2400, first2160Ms: 2300 },
      { at: T, event: "debrid_resolve_timing", totalMs: 9 },
      { at: T, event: "vod_open", outcome: "ok", tookMs: 2500 },
      { at: T, event: "vod_open", outcome: "remux capacity reached", tookMs: 40 },
      { at: T, event: "vod_open", outcome: "ok", tookMs: 9300, prewarm: true },
      { at: T, event: "vod_open", outcome: "ok", tookMs: 3, prewarm: true },
      { at: T, event: "vod_open", outcome: "ok", tookMs: 2, prewarm: true },
    ]);
    expect(search).toMatchObject({ searches: 1, totalMs: { n: 1, p50: 2400, p90: 2400 }, first1080Ms: { n: 0 } });
    expect(opens).toEqual({ total: 2, ok: 1, okMs: { n: 1, p50: 2500, p90: 2500 }, byOutcome: { ok: 1, "remux capacity reached": 1 } });
  });

  it("keeps asks made ahead of Play apart from a player's opens, and times only the ones that opened the file", () => {
    const { opens, readied } = report([
      { at: T, event: "vod_open", outcome: "ok", tookMs: 9300, prewarm: true },
      { at: T, event: "vod_open", outcome: "ok", tookMs: 3, prewarm: true },
      { at: T, event: "vod_open", outcome: "ok", tookMs: 2, prewarm: true },
    ]);
    expect(opens.total).toBe(0);
    expect(readied).toEqual({ asks: 3, fresh: 1, freshMs: { n: 1, p50: 9300, p90: 9300 } });
  });

  it("reads the remuxer's lines, the web providers' results and what was turned away", () => {
    const made = report([
      { at: T, event: "vod", message: "run 0 of abc from segment 0 (0.0s)" },
      { at: T, event: "vod", message: "run 0 stopped: idle" },
      { at: T, event: "vod", message: "left abc" },
      { at: T, event: "vod", message: "refused abc: every run is taken by someone watching" },
      { at: T, event: "provider_result", provider: "vixsrc", status: "hit", ms: 1100 },
      { at: T, event: "provider_result", provider: "vixsrc", status: "empty", ms: 300 },
      { at: T, event: "debrid_other_title_rejected" },
      { at: T - 5000, event: "debrid_other_title_rejected" },
    ]);
    expect(made.remux).toEqual({ runsStarted: 1, viewersLeft: 1, refusedForCapacity: 1 });
    expect(made.webProviders).toEqual({ vixsrc: { asked: 2, found: 1, medianMs: 1100 } });
    expect(made.rejected.otherTitle).toBe(1);
  });
});

describe("parseEventLines", () => {
  it("reads whole lines and passes over a broken one", () => {
    expect(parseEventLines('{"at":1,"event":"a"}\n{"at":2,"eve\n\n{"at":3,"event":"b","n":1}\n{"no":"event"}\n')).toEqual([
      { at: 1, event: "a" },
      { at: 3, event: "b", n: 1 },
    ]);
  });
});

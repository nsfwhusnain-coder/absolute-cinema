/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { PlaybackReporter, type PlayerReadings } from "./player-feedback";

const readings = (overrides: Partial<PlayerReadings> = {}): PlayerReadings => ({
  engine: "hlsjs",
  paused: false,
  ended: false,
  seeking: false,
  buffering: false,
  positionS: 10,
  durationS: 3600,
  bufferAheadS: 8,
  decodedWidth: 1920,
  decodedHeight: 1080,
  levelBitrateBps: 6_000_000,
  declaredBitrateBps: null,
  bandwidthBps: 9_000_000,
  bytesLoaded: 0,
  loadMs: 0,
  droppedFrames: 0,
  decodedFrames: 0,
  audioLanguage: "en",
  subtitleLanguage: null,
  ...overrides,
});

type Sent = Record<string, unknown>;

/**
 * The heartbeat timer does not run under test: the reporter's own beat is
 * called directly, as the timer would call it every 30 seconds.
 */
function beat(reporter: PlaybackReporter): void {
  (reporter as unknown as { beat(): void }).beat();
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PlaybackReporter heartbeats", () => {
  it("reports the file, the picture now, and only what changed since the last heartbeat", () => {
    const sent: Sent[] = [];
    const reporter = new PlaybackReporter((r) => sent.push(r));
    let now = readings({ bytesLoaded: 4_000_000, loadMs: 800, decodedFrames: 1800, droppedFrames: 2 });
    reporter.open(() => now, { tmdbId: "550", mediaType: "movie" });
    reporter.attach({ sourceId: "vixsrc-luna-1", provider: "Vixsrc", delivery: "web" });
    beat(reporter);
    now = readings({ bytesLoaded: 6_000_000, loadMs: 1_000, decodedFrames: 3600, droppedFrames: 2 });
    beat(reporter);

    expect(sent).toHaveLength(2);
    const [first, second] = sent as [Sent, Sent];
    expect(first).toMatchObject({
      event: "heartbeat",
      tmdbId: "550",
      mediaType: "movie",
      sourceId: "vixsrc-luna-1",
      provider: "Vixsrc",
      delivery: "web",
      engine: "hlsjs",
      decodedHeight: 1080,
      decodedWidth: 1920,
      bufferAheadS: 8,
      bandwidthBps: 9_000_000,
      levelBitrateBps: 6_000_000,
      playing: true,
      paused: false,
      buffering: false,
      audioLanguage: "en",
      subtitleLanguage: null,
      bytesLoaded: 4_000_000,
      loadMs: 800,
      decodedFrames: 1800,
      droppedFrames: 2,
    });
    expect(second).toMatchObject({ bytesLoaded: 2_000_000, loadMs: 200, decodedFrames: 1800, droppedFrames: 0 });
    reporter.finish("left");
  });

  it("reports a remuxed file's declared bit rate, not the rendition's", () => {
    const sent: Sent[] = [];
    const reporter = new PlaybackReporter((r) => sent.push(r));
    reporter.open(() => readings({ levelBitrateBps: 2_000_000, declaredBitrateBps: 18_000_000, engine: "native_hls" }), { tmdbId: "1", mediaType: "movie" });
    reporter.attach({ sourceId: "remux-1", provider: "Debrid", delivery: "remux" });
    beat(reporter);
    expect(sent[0]!.levelBitrateBps).toBe(18_000_000);
    reporter.finish("left");
  });

  it("sends nothing before a file is attached", () => {
    const sent: Sent[] = [];
    const reporter = new PlaybackReporter((r) => sent.push(r));
    reporter.open(() => readings(), { tmdbId: "1", mediaType: "movie" });
    beat(reporter);
    expect(sent).toHaveLength(0);
    reporter.finish("left");
  });

  it("does not let a failing report reach the player", () => {
    const reporter = new PlaybackReporter(() => {
      throw new Error("network gone");
    });
    reporter.open(() => readings(), { tmdbId: "1", mediaType: "movie" });
    reporter.attach({ sourceId: "x", provider: "Y", delivery: "native" });
    expect(() => beat(reporter)).not.toThrow();
    reporter.finish("left");
  });
});

describe("PlaybackReporter summaries", () => {
  it("sends one summary when the viewer leaves, and nothing more for that view", async () => {
    const sent: Sent[] = [];
    const reporter = new PlaybackReporter((r) => sent.push(r));
    reporter.open(() => readings({ engine: "native_file", levelBitrateBps: null, bandwidthBps: null, bytesLoaded: null, loadMs: null }), { tmdbId: "550", mediaType: "movie" });
    reporter.attach({ sourceId: "debrid-a", provider: "Debrid", delivery: "native" });
    reporter.picture(2_400);
    reporter.playing();
    reporter.close();
    await wait(10);
    reporter.finish("left");
    await wait(10);
    const summaries = sent.filter((r) => r.event === "session_end");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      tmdbId: "550",
      sourceId: "debrid-a",
      delivery: "native",
      engine: "native_file",
      endReason: "left",
      startupMs: 2_400,
      sourcesTried: 1,
      bytesLoaded: null,
    });
  });

  it("ends the view as switched when another title opens before the leaving is settled", async () => {
    const sent: Sent[] = [];
    const first = new PlaybackReporter((r) => sent.push(r));
    first.open(() => readings(), { tmdbId: "550", mediaType: "movie" });
    first.attach({ sourceId: "one", provider: "Vixsrc", delivery: "web" });
    first.close();

    const second = new PlaybackReporter((r) => sent.push(r));
    second.open(() => readings(), { tmdbId: "552", mediaType: "movie" });
    const summaries = sent.filter((r) => r.event === "session_end");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ tmdbId: "550", endReason: "switched" });

    await wait(10);
    expect(sent.filter((r) => r.event === "session_end")).toHaveLength(1);
    second.finish("left");
  });

  it("keeps the same view going when the same title is opened again before the leaving is settled", async () => {
    const sent: Sent[] = [];
    const reporter = new PlaybackReporter((r) => sent.push(r));
    reporter.open(() => readings(), { tmdbId: "550", mediaType: "movie" });
    reporter.attach({ sourceId: "one", provider: "Vixsrc", delivery: "web" });
    reporter.close();
    reporter.open(() => readings(), { tmdbId: "550", mediaType: "movie" });
    await wait(10);
    expect(sent.filter((r) => r.event === "session_end")).toHaveLength(0);
    reporter.finish("left");
    expect(sent.filter((r) => r.event === "session_end")).toHaveLength(1);
  });

  it("reports the end as ended when the video reached its end, whatever closed the view", () => {
    const sent: Sent[] = [];
    const reporter = new PlaybackReporter((r) => sent.push(r));
    reporter.open(() => readings(), { tmdbId: "550", mediaType: "movie" });
    reporter.attach({ sourceId: "one", provider: "Vixsrc", delivery: "web" });
    reporter.picture(1_000);
    reporter.playing();
    reporter.ended();
    reporter.finish("left");
    expect(sent.find((r) => r.event === "session_end")).toMatchObject({ endReason: "ended" });
  });

  it("reports a view that failed on every source as failed", () => {
    const sent: Sent[] = [];
    const reporter = new PlaybackReporter((r) => sent.push(r));
    reporter.open(() => readings(), { tmdbId: "550", mediaType: "movie" });
    reporter.attach({ sourceId: "one", provider: "Vixsrc", delivery: "web" });
    reporter.failed();
    reporter.finish("left");
    expect(sent.find((r) => r.event === "session_end")).toMatchObject({ endReason: "failed" });
  });

  it("counts watch time again once a jump lands, and not the wait for it", async () => {
    const sent: Sent[] = [];
    const reporter = new PlaybackReporter((r) => sent.push(r));
    reporter.open(() => readings(), { tmdbId: "550", mediaType: "movie" });
    reporter.attach({ sourceId: "one", provider: "Vixsrc", delivery: "web" });
    const started = Date.now();
    reporter.playing();
    reporter.seeked();
    await wait(30);
    reporter.seekDone(true);
    await wait(20);
    reporter.finish("left");
    const ended = Date.now();
    const summary = sent.find((r) => r.event === "session_end")!;
    expect(summary.seeks).toBe(1);
    // The 20 ms after the jump landed count; the 30 ms before it did not.
    expect(summary.watchedMs as number).toBeGreaterThanOrEqual(15);
    expect(summary.watchedMs as number).toBeLessThanOrEqual(ended - started - 25);
  });

  it("sends no summary for a view that never had a file", () => {
    const sent: Sent[] = [];
    const reporter = new PlaybackReporter((r) => sent.push(r));
    reporter.open(() => readings(), { tmdbId: "550", mediaType: "movie" });
    reporter.finish("left");
    reporter.finish("left");
    expect(sent).toHaveLength(0);
  });
});

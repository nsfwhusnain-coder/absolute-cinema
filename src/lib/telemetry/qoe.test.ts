/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  CounterDelta,
  PlayerTally,
  bitrateBps,
  bufferAheadSeconds,
  deliveryOf,
  isWatching,
  type PlayerCounters,
} from "./qoe";

const counters = (overrides: Partial<PlayerCounters> = {}): PlayerCounters => ({
  bytesLoaded: null,
  loadMs: null,
  droppedFrames: null,
  decodedFrames: null,
  decodedHeight: 1080,
  ...overrides,
});

/** A TimeRanges-like list from [start, end] pairs. */
const ranges = (pairs: Array<[number, number]>) => ({
  length: pairs.length,
  start: (i: number) => pairs[i]![0],
  end: (i: number) => pairs[i]![1],
});

describe("deliveryOf", () => {
  it("is remux whenever the remuxer serves the file", () => {
    expect(deliveryOf("remux", "mp4")).toBe("remux");
    expect(deliveryOf("remux", "hls")).toBe("remux");
  });

  it("is web for a provider's HLS or DASH playlist, native for a file the browser opens", () => {
    expect(deliveryOf("direct", "hls")).toBe("web");
    expect(deliveryOf("direct", "dash")).toBe("web");
    expect(deliveryOf("direct", "mp4")).toBe("native");
    expect(deliveryOf("unavailable", "mp4")).toBe("native");
  });
});

describe("bufferAheadSeconds", () => {
  it("is the end of the range holding the playhead, less the playhead", () => {
    expect(bufferAheadSeconds(ranges([[0, 42]]), 40)).toBe(2);
    expect(bufferAheadSeconds(ranges([[0, 42]]), 0)).toBe(42);
  });

  it("picks the range that holds the playhead, not the first one", () => {
    expect(bufferAheadSeconds(ranges([[0, 10], [30, 75]]), 31)).toBe(44);
  });

  it("is zero when no range holds the playhead, or nothing is buffered", () => {
    expect(bufferAheadSeconds(ranges([[0, 10], [30, 75]]), 20)).toBe(0);
    expect(bufferAheadSeconds(ranges([]), 5)).toBe(0);
    expect(bufferAheadSeconds(ranges([[0, 10]]), 11)).toBe(0);
  });

  it("is zero at the very end of a range and for a playhead that is not a number", () => {
    expect(bufferAheadSeconds(ranges([[0, 10]]), 10)).toBe(0);
    expect(bufferAheadSeconds(ranges([[0, 10]]), Number.NaN)).toBe(0);
  });
});

describe("CounterDelta", () => {
  it("yields what a running total rose by since the last reading", () => {
    const delta = new CounterDelta();
    expect(delta.take(100)).toBe(100);
    expect(delta.take(160)).toBe(60);
    expect(delta.take(160)).toBe(0);
  });

  it("treats a total that fell back as restarted, so the whole reading is new", () => {
    const delta = new CounterDelta();
    delta.take(500);
    expect(delta.take(40)).toBe(40);
    expect(delta.take(90)).toBe(50);
  });

  it("yields nothing for a reading the browser cannot give, and keeps its place", () => {
    const delta = new CounterDelta();
    delta.take(100);
    expect(delta.take(null)).toBeNull();
    expect(delta.take(undefined)).toBeNull();
    expect(delta.take(Number.NaN)).toBeNull();
    expect(delta.take(130)).toBe(30);
  });
});

describe("bitrateBps", () => {
  it("is bits over seconds", () => {
    // 1 MB in one second is 8 Mbit/s.
    expect(bitrateBps(1_000_000, 1000)).toBe(8_000_000);
  });

  it("is null unless both the bytes and the time are known and positive", () => {
    expect(bitrateBps(null, 1000)).toBeNull();
    expect(bitrateBps(1000, null)).toBeNull();
    expect(bitrateBps(0, 1000)).toBeNull();
    expect(bitrateBps(1000, 0)).toBeNull();
  });
});

describe("isWatching", () => {
  it("is true only while the picture is moving and nobody is waiting on it", () => {
    const base = { paused: false, ended: false, seeking: false, buffering: false };
    expect(isWatching(base)).toBe(true);
    expect(isWatching({ ...base, paused: true })).toBe(false);
    expect(isWatching({ ...base, ended: true })).toBe(false);
    expect(isWatching({ ...base, seeking: true })).toBe(false);
    expect(isWatching({ ...base, buffering: true })).toBe(false);
  });
});

describe("PlayerTally: watch time", () => {
  it("counts only the time the picture moved", () => {
    const tally = new PlayerTally();
    tally.playing(0);
    tally.halted(10_000); // paused for a while
    tally.playing(20_000);
    const beat = tally.heartbeat(25_000, counters());
    expect(beat.watchedMs).toBe(15_000);
  });

  it("gives each heartbeat only what passed since the last one", () => {
    const tally = new PlayerTally();
    tally.playing(0);
    expect(tally.heartbeat(30_000, counters()).watchedMs).toBe(30_000);
    expect(tally.heartbeat(60_000, counters()).watchedMs).toBe(30_000);
  });

  it("does not count a stretch the element was not watched, even one bracketed by heartbeats", () => {
    const tally = new PlayerTally();
    tally.playing(0);
    tally.watch(5_000, false);
    tally.watch(9_000, true);
    expect(tally.heartbeat(10_000, counters()).watchedMs).toBe(6_000);
  });
});

describe("PlayerTally: stalls", () => {
  it("counts a wait after the first picture once, and its length when it ends", () => {
    const tally = new PlayerTally();
    tally.picture(1500);
    tally.playing(0);
    tally.waiting(10_000, true);
    tally.playing(12_500);
    const beat = tally.heartbeat(30_000, counters());
    expect(beat.stalls).toBe(1);
    expect(beat.stalledMs).toBe(2_500);
  });

  it("does not count a second wait while the first one is still going", () => {
    const tally = new PlayerTally();
    tally.picture(1500);
    tally.playing(0);
    tally.waiting(1_000, true);
    tally.waiting(2_000, true);
    tally.waiting(3_000, true);
    tally.playing(4_000);
    const beat = tally.heartbeat(5_000, counters());
    expect(beat.stalls).toBe(1);
    expect(beat.stalledMs).toBe(3_000);
  });

  it("does not count a wait before the first picture, or one a jump or the grace after it causes", () => {
    const tally = new PlayerTally();
    tally.waiting(1_000, true);
    tally.playing(2_000);
    tally.picture(900);
    tally.waiting(3_000, false);
    tally.playing(4_000);
    const beat = tally.heartbeat(5_000, counters());
    expect(beat.stalls).toBe(0);
    expect(beat.stalledMs).toBe(0);
  });

  it("splits a stall that spans heartbeats: each reports its own part, and the stall is counted once", () => {
    const tally = new PlayerTally();
    tally.picture(1500);
    tally.playing(0);
    tally.waiting(20_000, true);
    const first = tally.heartbeat(30_000, counters());
    expect(first.stalls).toBe(1);
    expect(first.stalledMs).toBe(10_000);
    tally.playing(45_000);
    const second = tally.heartbeat(60_000, counters());
    expect(second.stalls).toBe(0);
    expect(second.stalledMs).toBe(15_000);
  });

  it("is ended by a pause, which is the viewer's own waiting and not a stall any longer", () => {
    const tally = new PlayerTally();
    tally.picture(1500);
    tally.playing(0);
    tally.waiting(10_000, true);
    tally.halted(14_000);
    const beat = tally.heartbeat(20_000, counters());
    expect(beat.stalledMs).toBe(4_000);
    expect(beat.stalls).toBe(1);
    // Nothing further accrues while paused.
    expect(tally.heartbeat(30_000, counters()).stalledMs).toBe(0);
  });
});

describe("PlayerTally: heartbeat deltas", () => {
  it("reports byte, load and frame deltas, and resets them after each heartbeat", () => {
    const tally = new PlayerTally();
    tally.playing(0);
    const first = tally.heartbeat(
      30_000,
      counters({ bytesLoaded: 4_000_000, loadMs: 800, droppedFrames: 3, decodedFrames: 1800 })
    );
    expect(first.bytesLoaded).toBe(4_000_000);
    expect(first.loadMs).toBe(800);
    expect(first.droppedFrames).toBe(3);
    expect(first.decodedFrames).toBe(1800);
    const second = tally.heartbeat(
      60_000,
      counters({ bytesLoaded: 6_000_000, loadMs: 1_000, droppedFrames: 3, decodedFrames: 3600 })
    );
    expect(second.bytesLoaded).toBe(2_000_000);
    expect(second.loadMs).toBe(200);
    expect(second.droppedFrames).toBe(0);
    expect(second.decodedFrames).toBe(1800);
  });

  it("reports null for bytes and load time on a file the browser loads itself", () => {
    const tally = new PlayerTally();
    tally.playing(0);
    const beat = tally.heartbeat(30_000, counters());
    expect(beat.bytesLoaded).toBeNull();
    expect(beat.loadMs).toBeNull();
    expect(beat.droppedFrames).toBeNull();
  });
});

describe("PlayerTally: the whole view", () => {
  it("totals the view and reports startup, the tallest picture, and the sources tried", () => {
    const tally = new PlayerTally();
    tally.noteSource("a");
    tally.picture(2_400);
    tally.playing(0);
    tally.heartbeat(30_000, counters({ bytesLoaded: 10_000_000, loadMs: 2_000, decodedHeight: 720 }));
    tally.halted(30_000);
    tally.seek();
    tally.noteSource("b");
    tally.noteSource("a");
    tally.playing(40_000);
    const totals = tally.finish(60_000, counters({ bytesLoaded: 20_000_000, loadMs: 4_000, decodedHeight: 1080 }), "left");
    expect(totals.endReason).toBe("left");
    expect(totals.watchedMs).toBe(50_000);
    expect(totals.seeks).toBe(1);
    expect(totals.startupMs).toBe(2_400);
    expect(totals.maxHeight).toBe(1080);
    expect(totals.sourcesTried).toBe(2);
    expect(totals.bytesLoaded).toBe(20_000_000);
    // 20 MB over 4 s of loading is 40 Mbit/s.
    expect(totals.avgBitrateBps).toBe(40_000_000);
  });

  it("reports the end as ended when the video reached its end, whatever closed the view", () => {
    const tally = new PlayerTally();
    tally.picture(1000);
    tally.playing(0);
    tally.ended();
    tally.halted(5_000);
    expect(tally.finish(6_000, counters(), "switched").endReason).toBe("ended");
  });

  it("reports the end as failed when every source failed and no picture came since", () => {
    const tally = new PlayerTally();
    tally.markFailed();
    expect(tally.finish(1_000, counters(), "left").endReason).toBe("failed");
  });

  it("forgets a failure once a picture comes", () => {
    const tally = new PlayerTally();
    tally.markFailed();
    tally.picture(null);
    expect(tally.finish(1_000, counters(), "switched").endReason).toBe("switched");
  });

  it("keeps startup null when the title never started", () => {
    const tally = new PlayerTally();
    tally.noteSource("a");
    const totals = tally.finish(1_000, counters({ decodedHeight: 0 }), "left");
    expect(totals.startupMs).toBeNull();
    expect(totals.maxHeight).toBeNull();
    expect(totals.avgBitrateBps).toBeNull();
    expect(totals.bytesLoaded).toBeNull();
  });

  it("closes a stall still running when the view ends, and counts its time", () => {
    const tally = new PlayerTally();
    tally.picture(1000);
    tally.playing(0);
    tally.waiting(10_000, true);
    const totals = tally.finish(13_000, counters(), "left");
    expect(totals.stalls).toBe(1);
    expect(totals.stalledMs).toBe(3_000);
  });

  it("counts nothing after the view is finished", () => {
    const tally = new PlayerTally();
    tally.picture(1000);
    tally.playing(0);
    tally.finish(10_000, counters(), "left");
    expect(tally.heartbeat(20_000, counters()).watchedMs).toBe(0);
  });
});

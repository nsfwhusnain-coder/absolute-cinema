import { describe, expect, it } from "bun:test";
import { laneSpeedSummary, newSessionStats, noteFirstFragment, noteLaneSample, noteOutcome, noteViewer, sessionSummary, telemetry } from "./remux-stats";

const NOW = 1_700_000_000_000;

describe("noteLaneSample", () => {
  it("keeps the exact lowest and highest speeds", () => {
    const stats = newSessionStats(0);
    for (const bytesPerS of [5e6, 2e6, 9e6, 4e6]) noteLaneSample(stats, bytesPerS);
    expect(stats.laneMin).toBe(2e6);
    expect(stats.laneMax).toBe(9e6);
  });

  it("keeps a bounded sample spread over the whole session, so its median stands for all of it", () => {
    const stats = newSessionStats(0);
    for (let i = 1; i <= 10_000; i++) noteLaneSample(stats, i);
    expect(stats.laneSamples.length).toBeLessThanOrEqual(200);
    expect(stats.laneMin).toBe(1);
    expect(stats.laneMax).toBe(10_000);
    // The median of 1..10000 is 5000.5; a sample spread over the session lands near it, not at its start or end.
    const median = laneSpeedSummary(stats)!.median / 8;
    expect(median).toBeGreaterThan(4_000);
    expect(median).toBeLessThan(6_000);
  });

  it("ignores what is not a speed", () => {
    const stats = newSessionStats(0);
    noteLaneSample(stats, Number.NaN);
    noteLaneSample(stats, -1);
    noteLaneSample(stats, Number.POSITIVE_INFINITY);
    expect(stats.laneMin).toBeNull();
    expect(stats.laneSamples).toEqual([]);
  });
});

describe("laneSpeedSummary", () => {
  it("is null before any sample, and otherwise the lowest, median and highest in bits per second", () => {
    const stats = newSessionStats(0);
    expect(laneSpeedSummary(stats)).toBeNull();
    for (const bytesPerS of [1e6, 2e6, 3e6]) noteLaneSample(stats, bytesPerS);
    expect(laneSpeedSummary(stats)).toEqual({ min: 8e6, median: 16e6, max: 24e6 });
  });
});

describe("noteOutcome", () => {
  it("counts the refusals, silences and wrong ranges of its session, and no others", () => {
    const stats = newSessionStats(0);
    noteOutcome(stats, "refused");
    noteOutcome(stats, "refused");
    noteOutcome(stats, "silent");
    noteOutcome(stats, "wrong_range");
    noteOutcome(stats, "ok");
    noteOutcome(stats, "error");
    expect([stats.refusals, stats.silences, stats.wrongRanges]).toEqual([2, 1, 1]);
  });

  it("is harmless without a session to count against", () => {
    expect(() => noteOutcome(undefined, "refused")).not.toThrow();
  });
});

describe("noteViewer", () => {
  it("counts each viewer once, and an empty id as nobody", () => {
    const stats = newSessionStats(0);
    noteViewer(stats, "aa11");
    noteViewer(stats, "aa11");
    noteViewer(stats, "bb22");
    noteViewer(stats, "");
    expect(stats.viewers.size).toBe(2);
  });
});

describe("noteFirstFragment", () => {
  it("takes the first run's first fragment, and no other", () => {
    const stats = newSessionStats(0);
    noteFirstFragment(stats, 1, 500);
    expect(stats.firstFragmentMs).toBeNull();
    noteFirstFragment(stats, 0, 1234.4);
    noteFirstFragment(stats, 0, 99);
    expect(stats.firstFragmentMs).toBe(1234);
  });
});

describe("sessionSummary", () => {
  it("builds the event's fields from what the session counted", () => {
    const stats = newSessionStats(NOW - 90_400);
    stats.openMs = 1_234;
    stats.indexReads = 14;
    stats.bytesUpstream = 5_000_000;
    stats.bytesServed = 4_000_000;
    stats.maxLanes = 4;
    stats.refusals = 2;
    stats.silences = 1;
    stats.runs = 3;
    stats.runEnds = { completed: 1, viewer_left: 1, idle: 1 };
    stats.firstFragmentMs = 2_345;
    noteViewer(stats, "aa11");
    noteViewer(stats, "bb22");
    noteViewer(stats, "aa11");
    for (const bytesPerS of [1e6, 2e6, 3e6]) noteLaneSample(stats, bytesPerS);

    const summary = sessionSummary(
      {
        session: "0123456789abcdef01234567",
        cdn: "real-debrid.com",
        durationS: 7203.46,
        sizeBytes: 9_000_000_000,
        bitrateBps: 12_000_000,
        videoCodec: "V_MPEGH/ISO/HEVC",
        dynamicRange: "HDR10",
        audioDelivery: "copy",
      },
      stats,
      NOW
    );

    expect(summary).toEqual({
      session: "0123456789abcdef01234567",
      cdn: "real-debrid.com",
      durationS: 7203.5,
      sizeBytes: 9_000_000_000,
      bitrateBps: 12_000_000,
      videoCodec: "V_MPEGH/ISO/HEVC",
      dynamicRange: "HDR10",
      audioDelivery: "copy",
      openMs: 1_234,
      indexReads: 14,
      runs: 3,
      runEnds: { completed: 1, viewer_left: 1, idle: 1 },
      firstFragmentMs: 2_345,
      bytesUpstream: 5_000_000,
      bytesServed: 4_000_000,
      laneBps: { min: 8e6, median: 16e6, max: 24e6 },
      maxLanes: 4,
      refusals: 2,
      silences: 1,
      wrongRanges: 0,
      viewers: 2,
      openForS: 90,
    });
  });

  it("says null where a session never got that far: no fragment, no lane sample", () => {
    const stats = newSessionStats(NOW);
    const summary = sessionSummary(
      { session: "abc", cdn: "debrid.it", durationS: 10, sizeBytes: 1, bitrateBps: null, videoCodec: null, dynamicRange: "SDR", audioDelivery: "aac20" },
      stats,
      NOW
    );
    expect(summary.firstFragmentMs).toBeNull();
    expect(summary.laneBps).toBeNull();
    expect(summary.bitrateBps).toBeNull();
    expect(summary.viewers).toBe(0);
    expect(summary.openForS).toBe(0);
  });
});

describe("telemetry", () => {
  it("drops a record that throws, so a metric can never break the read it describes", () => {
    expect(() =>
      telemetry(() => {
        throw new Error("boom");
      })
    ).not.toThrow();
  });
});

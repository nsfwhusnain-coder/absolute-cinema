import { describe, expect, it } from "bun:test";
import {
  bitsPerSecond,
  capacityRates,
  capacitySnapshotFields,
  parseProcNetDev,
  readContainerNetwork,
  ViewerTracker,
  VIEWER_WINDOW_MS,
  type CapacitySample,
} from "./capacity";

/** /proc/net/dev as the kernel writes it: two header lines, then one line per interface. */
const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000    5000    0    0    0     0          0         0  1000000    5000    0    0    0     0       0          0
  eth0: 2000000   12000    0    0    0     0          0         0  3000000    9000    0    0    0     0       0          0
docker0:     500      10    0    0    0     0          0         0      700       8    0    0    0     0       0          0
`;

describe("parseProcNetDev", () => {
  it("adds up every interface but loopback, received and sent apart", () => {
    expect(parseProcNetDev(PROC_NET_DEV)).toEqual({ rxBytes: 2_000_500, txBytes: 3_000_700 });
  });

  it("reads loopback-only text as no traffic, and text with no interface as nothing", () => {
    const loopbackOnly = PROC_NET_DEV.split("\n").filter((line) => !line.includes("eth0") && !line.includes("docker0")).join("\n");
    expect(parseProcNetDev(loopbackOnly)).toEqual({ rxBytes: 0, txBytes: 0 });
    expect(parseProcNetDev("Inter-|   Receive\n face |bytes    packets\n")).toBeNull();
    expect(parseProcNetDev("")).toBeNull();
  });

  it("skips a line whose figures are not numbers, and one too short to hold the sent bytes", () => {
    const text = `${PROC_NET_DEV}  wg0: x y z\n  tun0: 1 2 3\n`;
    expect(parseProcNetDev(text)).toEqual({ rxBytes: 2_000_500, txBytes: 3_000_700 });
  });

  it("finds no counters where the file is missing, so the gauges are skipped", () => {
    expect(readContainerNetwork("/nonexistent/absolute-cinema-test/proc/net/dev")).toBeNull();
  });
});

describe("bitsPerSecond", () => {
  it("is the change in the counter, in bits, over the seconds", () => {
    expect(bitsPerSecond(1_000, 2_000, 2)).toBe(4_000);
    expect(bitsPerSecond(0, 7_500_000, 60)).toBe(1_000_000);
  });

  it("is null when the counter is missing, the interval is nothing, or the counter went back", () => {
    expect(bitsPerSecond(null, 2_000, 2)).toBeNull();
    expect(bitsPerSecond(1_000, null, 2)).toBeNull();
    expect(bitsPerSecond(1_000, 2_000, 0)).toBeNull();
    expect(bitsPerSecond(1_000, 2_000, Number.NaN)).toBeNull();
    // A restart begins the counters from zero again: no rate can be taken across it.
    expect(bitsPerSecond(5_000, 2_000, 60)).toBeNull();
  });
});

describe("capacityRates", () => {
  const minuteBefore: CapacitySample = { at: 0, rxBytes: 1_000_000, txBytes: 2_000_000, upstreamBytes: 0, servedBytes: 0, cpuSeconds: 10 };
  const minuteAfter: CapacitySample = { at: 60_000, rxBytes: 8_500_000, txBytes: 2_750_000, upstreamBytes: 15_000_000, servedBytes: 6_000_000, cpuSeconds: 11.5 };

  it("takes each rate as the delta over the minute between the two samples", () => {
    const rates = capacityRates(minuteBefore, minuteAfter);
    expect(rates.rxBps).toBeCloseTo(1_000_000, 6);
    expect(rates.txBps).toBeCloseTo(100_000, 6);
    expect(rates.upstreamBps).toBeCloseTo(2_000_000, 6);
    expect(rates.servedBps).toBeCloseTo(800_000, 6);
    // 1.5 s of CPU over 60 s of wall time is 2.5 percent of one core.
    expect(rates.cpuPercent).toBeCloseTo(2.5, 9);
  });

  it("has no network rate where the container's counters are not there", () => {
    const rates = capacityRates({ ...minuteBefore, rxBytes: null, txBytes: null }, minuteAfter);
    expect(rates.rxBps).toBeNull();
    expect(rates.txBps).toBeNull();
    expect(rates.upstreamBps).toBeCloseTo(2_000_000, 6);
  });

  it("has no CPU rate for an interval of nothing, nor for CPU time that went backwards", () => {
    expect(capacityRates(minuteBefore, { ...minuteAfter, at: 0 }).cpuPercent).toBeNull();
    expect(capacityRates(minuteBefore, { ...minuteAfter, cpuSeconds: 9 }).cpuPercent).toBeNull();
  });
});

describe("capacitySnapshotFields", () => {
  it("names the fields of the event, whole bits and bytes, and CPU to a tenth", () => {
    const fields = capacitySnapshotFields({
      sessions: 2,
      runs: 3,
      pausedRuns: 1,
      viewers: 4,
      rates: { rxBps: 1_234_567.8, txBps: null, upstreamBps: 2.4, servedBps: 999.6, cpuPercent: 12.345 },
      loadAvg1: 0.456,
      rssBytes: 300_000_000.4,
      cacheBytes: 1_000,
      diskFreeBytes: Number.POSITIVE_INFINITY,
    });
    expect(fields).toEqual({
      sessions: 2,
      runs: 3,
      pausedRuns: 1,
      viewers: 4,
      rxBps: 1_234_568,
      txBps: null,
      upstreamBps: 2,
      servedBps: 1_000,
      cpuPercent: 12.3,
      loadAvg1: 0.46,
      rssBytes: 300_000_000,
      cacheBytes: 1_000,
      diskFreeBytes: null,
    });
  });
});

describe("ViewerTracker", () => {
  it("counts the viewers heard from in the last 30 seconds", () => {
    const viewers = new ViewerTracker();
    viewers.touch("aa11", 0);
    viewers.touch("bb22", 10_000);
    expect(viewers.count(10_000)).toBe(2);
    // The first viewer is exactly thirty seconds old: still watching. A moment later, not.
    expect(viewers.count(VIEWER_WINDOW_MS)).toBe(2);
    expect(viewers.count(VIEWER_WINDOW_MS + 1)).toBe(1);
    expect(viewers.count(VIEWER_WINDOW_MS + 10_000)).toBe(1);
    expect(viewers.count(VIEWER_WINDOW_MS + 10_001)).toBe(0);
  });

  it("counts a viewer who asks again once, by the latest request", () => {
    const viewers = new ViewerTracker();
    viewers.touch("aa11", 0);
    viewers.touch("aa11", 25_000);
    expect(viewers.count(40_000)).toBe(1);
  });

  it("does not count an empty id", () => {
    const viewers = new ViewerTracker();
    viewers.touch("", 0);
    expect(viewers.count(0)).toBe(0);
  });

  it("keeps at most ten thousand viewers, so made-up ids cannot grow it without bound", () => {
    const viewers = new ViewerTracker();
    for (let i = 0; i < 10_005; i++) viewers.touch(`w${i}`, 0);
    expect(viewers.count(0)).toBe(10_000);
  });
});

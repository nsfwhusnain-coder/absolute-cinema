import { describe, expect, it } from "bun:test";
import { metrics } from "../metrics";
import { debridTimingsOf, recordDebridResolveTiming } from "./debrid-timing";

/** The value of one series in the live metrics text, or 0 while it has not been seen. */
function sample(series: string): number {
  const row = metrics().render().split("\n").find((line) => line.startsWith(`${series} `));
  return row === undefined ? 0 : Number(row.slice(series.length + 1));
}

const RD_TOTAL = 'ac_web_debrid_resolve_seconds_count{service="realdebrid",stage="total"}';
const RD_TOTAL_SUM = 'ac_web_debrid_resolve_seconds_sum{service="realdebrid",stage="total"}';
const AD_TOTAL = 'ac_web_debrid_resolve_seconds_count{service="alldebrid",stage="total"}';
const RD_FIRST_1080 = 'ac_web_debrid_resolve_seconds_count{service="realdebrid",stage="first1080"}';

describe("recordDebridResolveTiming", () => {
  it("observes each lap the resolver logged, in seconds, and skips the ones it did not take", () => {
    const rdBefore = sample(RD_TOTAL);
    const sumBefore = sample(RD_TOTAL_SUM);
    const adBefore = sample(AD_TOTAL);
    const first1080Before = sample(RD_FIRST_1080);
    recordDebridResolveTiming({ mediaType: "movie", tmdbId: 60001 }, { realDebridMs: 2500, first1080Ms: 900 }, false, 0);
    expect(sample(RD_TOTAL) - rdBefore).toBe(1);
    expect(sample(RD_TOTAL_SUM) - sumBefore).toBeCloseTo(2.5, 6);
    expect(sample(RD_FIRST_1080) - first1080Before).toBe(1);
    expect(sample(AD_TOTAL) - adBefore).toBe(0);
  });

  it("gives a Real-Debrid roster that was cut short as its total: the time it was given up", () => {
    const before = sample(RD_TOTAL);
    recordDebridResolveTiming({ mediaType: "movie", tmdbId: 60002 }, { realDebridPartialMs: 4000 }, false, 0);
    expect(sample(RD_TOTAL) - before).toBe(1);
    expect(debridTimingsOf({ mediaType: "movie", tmdbId: 60002 }, 0)?.timings.realDebridMs).toBe(4000);
  });

  it("observes AllDebrid and TorBox totals under their own services", () => {
    const adBefore = sample(AD_TOTAL);
    recordDebridResolveTiming({ mediaType: "movie", tmdbId: 60003 }, { allDebridMs: 1200, torboxMs: 300 }, false, 0);
    expect(sample(AD_TOTAL) - adBefore).toBe(1);
  });

  it("ignores a lap that is not a number, or a negative one", () => {
    const before = sample(RD_TOTAL);
    recordDebridResolveTiming({ mediaType: "movie", tmdbId: 60004 }, { realDebridMs: -5, first2160Ms: Number.NaN }, false, 0);
    expect(sample(RD_TOTAL) - before).toBe(0);
    expect(debridTimingsOf({ mediaType: "movie", tmdbId: 60004 }, 0)?.timings).toEqual({});
  });
});

describe("debridTimingsOf", () => {
  it("returns the laps and whether the index failed, for the title, for five minutes", () => {
    const title = { mediaType: "tv" as const, tmdbId: 60005, season: 1, episode: 2 };
    recordDebridResolveTiming(title, { realDebridMs: 2100, allDebridMs: 3300, first1080Ms: 700, first2160Ms: 1900 }, true, 1000);
    expect(debridTimingsOf(title, 1000)).toEqual({
      timings: { realDebridMs: 2100, allDebridMs: 3300, first1080Ms: 700, first2160Ms: 1900 },
      indexFailed: true,
    });
    expect(debridTimingsOf(title, 1000 + 5 * 60_000 - 1)).toBeDefined();
    expect(debridTimingsOf(title, 1000 + 5 * 60_000)).toBeUndefined();
  });

  it("finds a film by its title alone, whatever season the search was asked with", () => {
    recordDebridResolveTiming({ mediaType: "movie", tmdbId: 60006, season: 3 }, { realDebridMs: 1000 }, false, 0);
    expect(debridTimingsOf({ mediaType: "movie", tmdbId: 60006 }, 0)?.timings.realDebridMs).toBe(1000);
  });

  it("finds nothing for a title no search has looked at", () => {
    expect(debridTimingsOf({ mediaType: "movie", tmdbId: 60007 }, 0)).toBeUndefined();
  });
});

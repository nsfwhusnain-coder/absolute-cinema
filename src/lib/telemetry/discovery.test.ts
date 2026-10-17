import { describe, expect, it } from "bun:test";
import type { PlaybackSource } from "../playback/types";
import { metrics } from "../metrics";
import {
  buildDiscoverySummary,
  classifyDiscoverySource,
  isDiscoveryFinal,
  noteDiscovery,
  outcomeOfHeight,
  recordDiscoveryMetrics,
  safeReleaseTitle,
  type DiscoveryContext,
} from "./discovery";
import { recordDebridResolveTiming } from "./debrid-timing";

/** A debrid file as the resolver hands it to the answer, after annotation. */
function debrid(overrides: Partial<PlaybackSource> & Pick<PlaybackSource, "id">): PlaybackSource {
  return {
    url: `https://cdn.example/${overrides.id}?token=secret`,
    provider: "Debrid",
    quality: "1080p",
    label: "1080p · Debrid",
    type: "mp4",
    origin: "debrid",
    ...overrides,
  };
}

/** A web stream, as a provider lists it. */
function web(overrides: Partial<PlaybackSource> & Pick<PlaybackSource, "id" | "provider">): PlaybackSource {
  return {
    url: "https://stream.example/master.m3u8",
    quality: "1080p",
    label: "Web",
    type: "hls",
    ...overrides,
  };
}

const context: DiscoveryContext = {
  mediaType: "movie",
  tmdbId: 550,
  want4k: true,
  qualityHint: "auto",
  cache: false,
  indexFailed: false,
};

/** The value of one series in the live metrics text, or 0 while it has not been seen. */
function sample(series: string): number {
  const row = metrics().render().split("\n").find((line) => line.startsWith(`${series} `));
  return row === undefined ? 0 : Number(row.slice(series.length + 1));
}

// A 4K remux, a clean 1080p, a heavy AllDebrid 1080p, and a web stream.
const remux4k = debrid({
  id: "debrid-tt0137523-movie-0-0-safari-2160",
  maxHeight: 2160,
  releaseTitle: "Movie.1999.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.7.1-GROUP",
  codec: "hevc",
  container: "mp4",
  sizeBytes: 40_000_000_000,
  fileBitrateBps: 60_000_000,
  qualityTier: 3,
  qualityScore: 700,
  qualityFlags: ["remux"],
});
const native1080 = debrid({
  id: "debrid-tt0137523-movie-0-0-native-1080-1",
  maxHeight: 1080,
  releaseTitle: "Movie.1999.1080p.BluRay.x264-GROUP",
  codec: "h264",
  container: "mp4",
  sizeBytes: 6_000_000_000,
  fileBitrateBps: 8_000_000,
  qualityTier: 3,
  qualityScore: 400,
  qualityFlags: [],
});
const heavy1080 = debrid({
  id: "alldebrid-tt0137523-movie-0-0-1080p",
  provider: "AllDebrid",
  maxHeight: 1080,
  releaseTitle: "Movie.1999.1080p.WEB-DL.x264",
  qualityTier: 2,
  qualityScore: 180,
  qualityFlags: ["heavy"],
});
const vixsrc1080 = web({ id: "vixsrc-550-1080", provider: "vixsrc", quality: "1080p", maxHeight: 1080 });

describe("buildDiscoverySummary: a 4K remux beside a 1080p", () => {
  const summary = buildDiscoverySummary([vixsrc1080, heavy1080, native1080, remux4k], context);

  it("reports the best file's outcome and its facts, from its effective height", () => {
    expect(summary.outcome).toBe("2160");
    expect(summary.best).toEqual({
      provider: "realdebrid",
      height: 2160,
      effectiveHeight: 2160,
      tier: 3,
      score: 700,
      flags: ["remux"],
      bitrateBps: 60_000_000,
      sizeBytes: 40_000_000_000,
      codec: "hevc",
      container: "mp4",
      releaseTitle: "Movie.1999.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.7.1-GROUP",
    });
  });

  it("counts the files and streams each provider found, per quality bucket", () => {
    expect(summary.found).toEqual({
      realdebrid: { "2160": 1, "1080": 1 },
      alldebrid: { "1080": 1 },
      vixsrc: { "1080": 1 },
    });
  });

  it("judges each debrid file by its tier and its judged flags", () => {
    expect(summary.judged).toEqual({
      realdebrid: { tier3: 2 },
      alldebrid: { tier2: 1 },
    });
  });

  it("never carries a link", () => {
    const text = JSON.stringify(summary);
    expect(text).not.toContain("https");
    expect(text).not.toContain("cdn.example");
    expect(text).not.toContain("token=secret");
    expect(text).not.toContain("stream.example");
  });
});

describe("buildDiscoverySummary: only an upscaled 4K", () => {
  // After annotation: the release says 2160p, the picture shows 1080p.
  const upscale = debrid({
    id: "debrid-tt0137523-movie-0-0-native-1080-2",
    maxHeight: 1080,
    quality: "1080p",
    label: "1080p · Debrid · upscaled",
    releaseTitle: "Movie.1999.2160p.AI.Upscale.WEB-DL.x264",
    qualityTier: 1,
    qualityScore: 60,
    qualityFlags: ["upscaled"],
  });

  it("is a 1080 outcome, and the best file's height keeps the 2160 it claims", () => {
    const summary = buildDiscoverySummary([upscale], context);
    expect(summary.outcome).toBe("1080");
    expect(summary.best?.height).toBe(2160);
    expect(summary.best?.effectiveHeight).toBe(1080);
    expect(summary.best?.tier).toBe(1);
    expect(summary.best?.flags).toEqual(["upscaled"]);
  });

  it("is judged upscaled, and found as the 1080 it shows", () => {
    const summary = buildDiscoverySummary([upscale], context);
    expect(summary.judged).toEqual({ realdebrid: { tier1: 1, upscaled: 1 } });
    expect(summary.found).toEqual({ realdebrid: { "1080": 1 } });
  });

  it("demotes a 4K flagged starved as well, even before annotation has lowered it", () => {
    const starved = debrid({
      id: "debrid-tt0137523-movie-0-0-safari-2160",
      maxHeight: 2160,
      releaseTitle: "Movie.1999.2160p.WEB-DL.HEVC",
      qualityFlags: ["starved"],
    });
    const summary = buildDiscoverySummary([starved], context);
    expect(summary.outcome).toBe("1080");
    expect(summary.best?.effectiveHeight).toBe(1080);
    expect(summary.best?.height).toBe(2160);
  });

  it("leaves a 4K flagged only as a remux as the 4K it is", () => {
    const remux = debrid({
      id: "debrid-tt0137523-movie-0-0-safari-2160",
      maxHeight: 2160,
      releaseTitle: "Movie.1999.2160p.REMUX",
      qualityFlags: ["remux"],
    });
    expect(buildDiscoverySummary([remux], context).outcome).toBe("2160");
  });
});

describe("buildDiscoverySummary: web only, and nothing", () => {
  it("is web_only when only web streams were found, and counts them", () => {
    const summary = buildDiscoverySummary(
      [web({ id: "w1", provider: "vixsrc", quality: "1080p", maxHeight: 1080 }), web({ id: "w2", provider: "cinepro", quality: "720p", maxHeight: 720 })],
      context
    );
    expect(summary.outcome).toBe("web_only");
    expect(summary.best).toBeNull();
    expect(summary.judged).toEqual({});
    expect(summary.found).toEqual({ vixsrc: { "1080": 1 }, cinepro: { "720": 1 } });
  });

  it("is nothing when no source was found, and says whether the index failed", () => {
    const summary = buildDiscoverySummary([], { ...context, indexFailed: true, cache: true });
    expect(summary.outcome).toBe("nothing");
    expect(summary.best).toBeNull();
    expect(summary.found).toEqual({});
    expect(summary.indexFailed).toBe(true);
    expect(summary.cache).toBe(true);
  });
});

describe("buildDiscoverySummary: the best file", () => {
  const pickName = (sources: PlaybackSource[]) => buildDiscoverySummary(sources, context).best?.releaseTitle;

  it("is the taller picture first", () => {
    const hd720 = debrid({ id: "a", maxHeight: 720, releaseTitle: "M.720p", qualityTier: 3, qualityScore: 900 });
    const hd1080 = debrid({ id: "b", maxHeight: 1080, releaseTitle: "M.1080p", qualityTier: 1, qualityScore: 10 });
    expect(pickName([hd720, hd1080])).toBe("M.1080p");
    expect(pickName([hd1080, hd720])).toBe("M.1080p");
  });

  it("is the higher tier at the same height, before the score", () => {
    const heavyHigh = debrid({ id: "a", maxHeight: 1080, releaseTitle: "M.heavy", qualityTier: 2, qualityScore: 900 });
    const cleanLow = debrid({ id: "b", maxHeight: 1080, releaseTitle: "M.clean", qualityTier: 3, qualityScore: 100 });
    expect(pickName([heavyHigh, cleanLow])).toBe("M.clean");
    expect(pickName([cleanLow, heavyHigh])).toBe("M.clean");
  });

  it("is the higher score within a tier", () => {
    const lower = debrid({ id: "a", maxHeight: 1080, releaseTitle: "M.lower", qualityTier: 3, qualityScore: 300 });
    const higher = debrid({ id: "b", maxHeight: 1080, releaseTitle: "M.higher", qualityTier: 3, qualityScore: 450 });
    expect(pickName([lower, higher])).toBe("M.higher");
  });

  it("is the native 1080 over an upscaled 4K, which shows the same 1080 picture at a lower tier", () => {
    const upscale = debrid({
      id: "a",
      maxHeight: 1080,
      releaseTitle: "M.2160p.AI.Upscale",
      qualityTier: 1,
      qualityScore: 300,
      qualityFlags: ["upscaled"],
    });
    const native = debrid({ id: "b", maxHeight: 1080, releaseTitle: "M.1080p.BluRay", qualityTier: 3, qualityScore: 100 });
    expect(pickName([upscale, native])).toBe("M.1080p.BluRay");
    expect(pickName([native, upscale])).toBe("M.1080p.BluRay");
  });

  it("is the first of two that rank equal", () => {
    const first = debrid({ id: "a", maxHeight: 1080, releaseTitle: "M.first" });
    const second = debrid({ id: "b", maxHeight: 1080, releaseTitle: "M.second" });
    expect(pickName([first, second])).toBe("M.first");
  });
});

describe("buildDiscoverySummary: judged verdicts", () => {
  it("counts a flagged file's tier and each judged flag, and not the others", () => {
    const flagged = debrid({
      id: "debrid-tt0137523-movie-0-0-native-1080-3",
      maxHeight: 1080,
      releaseTitle: "M.1080p.DV.hardsub",
      qualityTier: 1,
      qualityFlags: ["starved", "hardsub", "dv-only", "interpolated", "lq-group"],
    });
    const summary = buildDiscoverySummary([flagged], context);
    expect(summary.judged).toEqual({
      realdebrid: { tier1: 1, starved: 1, hardsub: 1, dvOnly: 1, interpolated: 1 },
    });
  });

  it("names a torbox file's verdicts under torbox", () => {
    const torbox = debrid({
      id: "torbox-tt0137523-movie-0-0-1080p",
      provider: "TorBox",
      maxHeight: 1080,
      qualityTier: 3,
    });
    expect(buildDiscoverySummary([torbox], context).judged).toEqual({ torbox: { tier3: 1 } });
  });
});

describe("buildDiscoverySummary: the fields it writes", () => {
  it("keeps season and episode for a show, and nothing for a film", () => {
    expect(buildDiscoverySummary([], { ...context, mediaType: "tv", tmdbId: 1399, season: 2, episode: 5 })).toMatchObject({
      mediaType: "tv",
      tmdbId: 1399,
      season: 2,
      episode: 5,
    });
    expect(buildDiscoverySummary([], { ...context, season: 2, episode: 5 })).toMatchObject({ season: null, episode: null });
  });

  it("writes only the timings it knows, as whole milliseconds", () => {
    const summary = buildDiscoverySummary([], {
      ...context,
      timings: { realDebridMs: 2300.4, allDebridMs: undefined, first1080Ms: 1500, first2160Ms: Number.NaN, providersMs: 1200 },
    });
    expect(summary.timings).toEqual({ realDebridMs: 2300, first1080Ms: 1500, providersMs: 1200 });
  });

  it("keeps what the viewer asked for", () => {
    const summary = buildDiscoverySummary([], { ...context, want4k: false, qualityHint: 1080 });
    expect(summary).toMatchObject({ want4k: false, qualityHint: 1080 });
  });

  it("gives an unknown quality hint as null", () => {
    expect(buildDiscoverySummary([], { ...context, qualityHint: null }).qualityHint).toBeNull();
  });
});

describe("classifyDiscoverySource", () => {
  it("names a debrid file's service from its source id, and falls back to its display name", () => {
    expect(classifyDiscoverySource(debrid({ id: "torbox-tt1-movie-0-0-1080p" })).provider).toBe("torbox");
    expect(classifyDiscoverySource(debrid({ id: "alldebrid-tt1-movie-0-0-1080p", provider: "AllDebrid" })).provider).toBe("alldebrid");
    expect(classifyDiscoverySource(debrid({ id: "no-id-here", provider: "TorBox" })).provider).toBe("torbox");
    expect(classifyDiscoverySource(debrid({ id: "no-id-here", provider: "Debrid" })).provider).toBe("realdebrid");
  });

  it("names a web provider in lower case, and says a web stream's origin", () => {
    const classed = classifyDiscoverySource(web({ id: "w", provider: "VidLink", maxHeight: 1080 }));
    expect(classed).toMatchObject({ provider: "vidlink", origin: "web", bucket: "1080" });
  });

  it("reads a web stream with no probed height from its quality label", () => {
    expect(classifyDiscoverySource(web({ id: "w", provider: "x", quality: "720p" })).bucket).toBe("720");
    expect(classifyDiscoverySource(web({ id: "w", provider: "x", quality: "auto" })).bucket).toBe("unknown");
  });
});

describe("outcomeOfHeight", () => {
  it("maps a height to the rung it reports", () => {
    expect(outcomeOfHeight(2160)).toBe("2160");
    expect(outcomeOfHeight(2000)).toBe("2160");
    // A 1440 is not 4K: it reads as 1080, the rung below 2160.
    expect(outcomeOfHeight(1440)).toBe("1080");
    expect(outcomeOfHeight(1080)).toBe("1080");
    expect(outcomeOfHeight(899)).toBe("720");
    expect(outcomeOfHeight(720)).toBe("720");
    expect(outcomeOfHeight(480)).toBe("sd");
    // A height nothing gave is sd: nothing about the file says it is more.
    expect(outcomeOfHeight(0)).toBe("sd");
  });
});

describe("safeReleaseTitle", () => {
  it("keeps a release name, and drops a link or a name too long to be one", () => {
    expect(safeReleaseTitle("Movie.2020.1080p.BluRay")).toBe("Movie.2020.1080p.BluRay");
    expect(safeReleaseTitle("https://example.com/release")).toBeNull();
    expect(safeReleaseTitle("see www.example.com")).toBeNull();
    expect(safeReleaseTitle(undefined)).toBeNull();
    expect(safeReleaseTitle("x".repeat(500))).toHaveLength(200);
  });
});

describe("isDiscoveryFinal", () => {
  const keys = ["REAL_DEBRID_API_TOKEN", "TORBOX_API_KEY", "ALLDEBRID_API_KEY"] as const;

  function withDebridEnv(env: Partial<Record<(typeof keys)[number], string>>, run: () => void): void {
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, env);
    try {
      run();
    } finally {
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("is final once the debrid services say they have settled", () => {
    withDebridEnv({ REAL_DEBRID_API_TOKEN: "token" }, () => {
      expect(isDiscoveryFinal({ debridSettled: true })).toBe(true);
    });
  });

  it("is final when no debrid service is configured, and not while one is and has not settled", () => {
    withDebridEnv({}, () => {
      expect(isDiscoveryFinal({})).toBe(true);
    });
    withDebridEnv({ ALLDEBRID_API_KEY: "key" }, () => {
      expect(isDiscoveryFinal({})).toBe(false);
      expect(isDiscoveryFinal({ debridSettled: false })).toBe(false);
    });
  });
});

describe("noteDiscovery", () => {
  it("writes a title's summary once per ten minutes, and again after that", () => {
    const title = { mediaType: "tv" as const, tmdbId: 91001, season: 1, episode: 1 };
    const input = { title, sources: [remux4k], want4k: true, qualityHint: "auto", cache: false };
    expect(noteDiscovery(input, 0)?.outcome).toBe("2160");
    expect(noteDiscovery(input, 5 * 60_000)).toBeNull();
    expect(noteDiscovery(input, 10 * 60_000)?.outcome).toBe("2160");
  });

  it("gives another title its own summary", () => {
    const first = noteDiscovery({ title: { mediaType: "movie", tmdbId: 91002 }, sources: [], want4k: true, qualityHint: "auto", cache: false }, 0);
    const second = noteDiscovery({ title: { mediaType: "movie", tmdbId: 91003 }, sources: [], want4k: true, qualityHint: "auto", cache: false }, 0);
    expect(first?.outcome).toBe("nothing");
    expect(second?.outcome).toBe("nothing");
  });

  it("takes the debrid timings the search left for its title, and the providers' time", () => {
    const title = { mediaType: "movie" as const, tmdbId: 91004 };
    recordDebridResolveTiming(title, { realDebridMs: 3100, first1080Ms: 800, torboxMs: 50 }, true, 0);
    const summary = noteDiscovery(
      { title, sources: [], want4k: true, qualityHint: "auto", cache: false, providersMs: 900 },
      1000
    );
    expect(summary).toMatchObject({ indexFailed: true, timings: { realDebridMs: 3100, first1080Ms: 800, providersMs: 900 } });
  });

  it("counts the outcome, and the sources and verdicts, in the live metrics", () => {
    const title = { mediaType: "movie" as const, tmdbId: 91005 };
    const outcome = 'ac_web_discovery_outcomes_total{media="movie",outcome="2160"}';
    const source = 'ac_web_discovery_sources_total{provider="realdebrid",origin="debrid",quality="2160"}';
    const verdict = 'ac_web_discovery_judged_total{provider="realdebrid",verdict="tier3"}';
    const before = [sample(outcome), sample(source), sample(verdict)];
    noteDiscovery({ title, sources: [remux4k], want4k: true, qualityHint: "auto", cache: false }, 0);
    expect([sample(outcome) - before[0]!, sample(source) - before[1]!, sample(verdict) - before[2]!]).toEqual([1, 1, 1]);
  });
});

describe("recordDiscoveryMetrics", () => {
  it("counts each verdict by its count, once per call", () => {
    const summary = buildDiscoverySummary([remux4k, heavy1080], context);
    const verdict = 'ac_web_discovery_judged_total{provider="alldebrid",verdict="tier2"}';
    const before = sample(verdict);
    recordDiscoveryMetrics(summary, [remux4k, heavy1080]);
    expect(sample(verdict) - before).toBe(1);
  });
});

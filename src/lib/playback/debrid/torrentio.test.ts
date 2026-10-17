/// <reference types="bun-types" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  isHi10AvcRelease,
  debridHeightBucket,
  buildKindPath,
  extractInfoHashFromResolveUrl,
  fetchTorrentioCandidates,
  isBrowserPlayableContainer,
  isEligibleDebridQuality,
  parseReleaseTitle,
  parseSeeders,
  parseSizeBytes,
  filterLeanDebridCandidates,
  isLeanDebridSize,
  effectiveReleaseContainer,
  isDirectPlayDebridRelease,
  isMoviePackRelease,
  isStereoscopicRelease,
  fetchTorrentioKitsuCandidates,
  fetchTorrentioCandidatesNoDebrid,
  isTorrentioIndexFailure,
  torrentioEvents,
  torrentioOutcomeOf,
  torrentioTiming,
  type TorrentioFetchInfo,
} from "./torrentio";

describe("anime-sized releases", () => {
  const MB = 1024 ** 2;
  it("keeps a normal 24-minute HEVC 1080p episode", () => {
    expect(isLeanDebridSize({ resolutionHeight: 1080, sizeBytes: 265 * MB, codec: "hevc" }, "tv")).toBe(false);
  });
  it("still rejects implausibly small H.264 1080p episodes", () => {
    expect(isLeanDebridSize({ resolutionHeight: 1080, sizeBytes: 150 * MB, codec: "h264" }, "tv")).toBe(true);
  });
  it("buckets 800p Blu-ray rips with 720p", () => {
    expect(debridHeightBucket(800)).toBe(720);
    expect(debridHeightBucket(1080)).toBe(1080);
    expect(debridHeightBucket(480)).toBe(480);
  });
});

describe("isHi10AvcRelease", () => {
  it("rejects 10-bit H.264, which no browser decodes", () => {
    expect(isHi10AvcRelease("[SubsPlease] Frieren - 01 (1080p) [Hi10P].mkv")).toBe(true);
    expect(isHi10AvcRelease("Naruto 001 [BD 1080p x264 10bit FLAC]")).toBe(true);
    expect(isHi10AvcRelease("Show S01E01 1080p AVC 10-bit")).toBe(true);
  });

  it("keeps 10-bit HEVC/AV1 and releases without an AVC tag", () => {
    expect(isHi10AvcRelease("Frieren S01E01 1080p x265 10bit")).toBe(false);
    expect(isHi10AvcRelease("Frieren S01E01 1080p AV1 10bit")).toBe(false);
    expect(isHi10AvcRelease("[Group] Frieren - 01 [1080p][10bit]")).toBe(false);
    expect(isHi10AvcRelease("Movie 2024 1080p WEB-DL x264")).toBe(false);
  });
});

describe("buildKindPath season 0", () => {
  it("keeps TMDB specials as :0:1.json instead of mapping to S1", () => {
    const path = buildKindPath({
      imdbId: "tt0944947",
      mediaType: "tv",
      season: 0,
      episode: 1,
    });
    expect(path).toContain(":0:1.json");
    expect(path).not.toContain(":1:1.json");
  });

  it("still defaults a missing season/episode to 1", () => {
    expect(
      buildKindPath({ imdbId: "tt0944947", mediaType: "tv" })
    ).toBe("stream/series/tt0944947:1:1.json");
  });

  it("does not put season on movie paths", () => {
    expect(
      buildKindPath({ imdbId: "tt0137523", mediaType: "movie", season: 0, episode: 1 })
    ).toBe("stream/movie/tt0137523.json");
  });
});

describe("extractInfoHashFromResolveUrl", () => {
  it("recovers the stable hash without returning the credential segment", () => {
    const hash = "a".repeat(40);
    expect(
      extractInfoHashFromResolveUrl(
        `https://torrentio.strem.fun/resolve/realdebrid/SECRET/${hash}/null/0/movie.mp4`
      )
    ).toBe(hash);
  });

  it("does not guess from unrelated or malformed URLs", () => {
    expect(extractInfoHashFromResolveUrl("https://example.com/not-a-resolve/aabb")).toBeUndefined();
    expect(extractInfoHashFromResolveUrl("not a url")).toBeUndefined();
  });
});

describe("debrid size floor", () => {
  it("treats an 800 MB 1080p movie as too thin", () => {
    expect(
      isLeanDebridSize({ resolutionHeight: 1080, sizeBytes: 800 * 1024 ** 2 }, "movie")
    ).toBe(true);
    expect(
      isLeanDebridSize({ resolutionHeight: 1080, sizeBytes: 5 * 1024 ** 3 }, "movie")
    ).toBe(false);
  });

  it("drops the skinny file when a rich one exists", () => {
    const kept = filterLeanDebridCandidates(
      [
        { resolutionHeight: 1080 as const, sizeBytes: 700 * 1024 ** 2, title: "thin" },
        { resolutionHeight: 1080 as const, sizeBytes: 8 * 1024 ** 3, title: "rich" },
      ],
      "movie"
    );
    expect(kept.map((row) => row.title)).toEqual(["rich"]);
  });
});

/**
 * Real sample release-name conventions (as seen in actual Torrentio/scene
 * release titles) — regression coverage for the classifier that decides
 * quality/codec/HDR/container/browser-compat for the PREMIUM debrid tier.
 */
describe("parseReleaseTitle", () => {
  it("4K HEVC HDR/DV remux -> 2160p, hevc, hdr, safari-only", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.UHD.BluRay.x265.HDR.DV-GROUP");
    expect(r.resolutionHeight).toBe(2160);
    expect(r.codec).toBe("hevc");
    expect(r.hdr).toBe(true);
    expect(r.compat).toBe("safari");
  });

  it("an explicit 1080p beats a bare marketing 4K in the same name", () => {
    // Real roster entry for Inception. Read as 2160p it becomes the top-ranked
    // native-2160 candidate (MP4 outranks the MKV alternative on container) and
    // takes the only 4K slot a Chrome session can use, hiding the genuine 4K
    // AV1 release behind it.
    const r = parseReleaseTitle("Inception - Directors Cut 2010 Eng Ita Multi-Subs 4K 1080p");
    expect(r.resolutionHeight).toBe(1080);
  });

  it("still reads a bare 4K as 2160p when nothing contradicts it", () => {
    expect(parseReleaseTitle("Movie.2024.4K.HDR.WEB-DL.H264").resolutionHeight).toBe(2160);
    expect(parseReleaseTitle("Movie.2024.2160p.WEB-DL").resolutionHeight).toBe(2160);
    // An explicit 2160p is real evidence and outranks a stray 1080p token.
    expect(parseReleaseTitle("Movie.2024.2160p.upscaled.from.1080p").resolutionHeight).toBe(2160);
  });

  it("1080p WEB-DL H264 -> 1080p, h264, no hdr, native (Chrome-safe)", () => {
    const r = parseReleaseTitle("Movie.2024.1080p.WEB-DL.H264-GRP");
    expect(r.resolutionHeight).toBe(1080);
    expect(r.codec).toBe("h264");
    expect(r.hdr).toBe(false);
    expect(r.compat).toBe("native");
  });

  it("4K WEB-DL H264 -> 2160p, h264, native (Chrome-safe 4K)", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.WEB-DL.H264-GRP");
    expect(r.resolutionHeight).toBe(2160);
    expect(r.codec).toBe("h264");
    expect(r.hdr).toBe(false);
    expect(r.compat).toBe("native");
  });

  it("1080p BluRay x265 .mkv -> 1080p, hevc, mkv container, safari-only", () => {
    const r = parseReleaseTitle("Movie.2024.1080p.BluRay.x265.mkv");
    expect(r.resolutionHeight).toBe(1080);
    expect(r.codec).toBe("hevc");
    expect(r.container).toBe("mkv");
    expect(r.compat).toBe("safari");
  });

  it("720p release -> resolution detected and retained as an availability fallback", () => {
    const r = parseReleaseTitle("Movie.2024.720p.WEBRip.x264-GRP");
    expect(r.resolutionHeight).toBe(720);
    expect(isEligibleDebridQuality(r.resolutionHeight)).toBe(true);
  });

  it("AV1-in-MP4/WEB-DL -> codec av1, compat NATIVE (Chrome/Firefox-native; Safari support is recent/partial — the opposite situation from HEVC)", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.WEB-DL.AV1-GRP");
    expect(r.codec).toBe("av1");
    expect(r.compat).toBe("native");
  });

  it("AV1 + HDR -> native; HDR is a proxy for HEVC, not a decode barrier of its own", () => {
    // Chrome decodes 10-bit AV1 with HDR10 metadata. `hdr` only stands in for
    // "probably HEVC" when the codec is unknown; here it is known.
    const r = parseReleaseTitle("Movie.2024.2160p.WEB-DL.AV1.HDR-GRP");
    expect(r.codec).toBe("av1");
    expect(r.hdr).toBe(true);
    expect(r.compat).toBe("native");
  });

  /**
   * The container no longer votes on compat. It used to force "safari", which
   * meant a decodable AV1/H.264 MKV was bucketed with x265 HDR remuxes and
   * lost every 4K slot to them — the reason nearly every title surfaced
   * exactly one 4K row, and an unplayable one. Remux makes MKV playable, so
   * the container now decides delivery cost (`sourceDelivery`), and the codec
   * alone decides which browsers can play it.
   */
  it("AV1 + MKV -> native; the container decides delivery, not audience", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.WEB-DL.AV1.mkv");
    expect(r.codec).toBe("av1");
    expect(r.container).toBe("mkv");
    expect(r.compat).toBe("native");
  });

  it("H.264 in MKV -> native, the most common case the old rule mis-bucketed", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.WEB-DL.H.264-GRP.mkv");
    expect(r.codec).toBe("h264");
    expect(r.container).toBe("mkv");
    expect(r.compat).toBe("native");
  });

  it("HEVC stays safari wherever it lives — no container change can help it", () => {
    expect(parseReleaseTitle("Movie.2024.2160p.BluRay.x265-GRP.mkv").compat).toBe("safari");
    expect(parseReleaseTitle("Movie.2024.2160p.BluRay.x265-GRP.mp4").compat).toBe("safari");
  });

  it("unknown codec at 4K still defaults to safari — most 4K really is HEVC", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.BluRay-GRP");
    expect(r.codec).toBe("unknown");
    expect(r.compat).toBe("safari");
  });

  it("no resolution token -> resolutionHeight null, not eligible", () => {
    const r = parseReleaseTitle("Movie.2024.WEBRip.x264-GRP");
    expect(r.resolutionHeight).toBeNull();
    expect(isEligibleDebridQuality(r.resolutionHeight)).toBe(false);
  });
});

describe("isEligibleDebridQuality", () => {
  it("accepts 720, 1080, and 2160", () => {
    expect(isEligibleDebridQuality(1080)).toBe(true);
    expect(isEligibleDebridQuality(2160)).toBe(true);
    expect(isEligibleDebridQuality(720)).toBe(true);
    expect(isEligibleDebridQuality(480)).toBe(false);
    expect(isEligibleDebridQuality(null)).toBe(false);
  });
});

/**
 * Container detection regression coverage — the honesty fix this tier is
 * built around. LIVE DATA confirms many 4K releases are untagged REMUX
 * (near-universally MKV in practice) rather than literally saying ".mkv".
 */
describe("parseReleaseTitle — container detection", () => {
  it("explicit .mkv token -> container mkv", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.BluRay.x264.mkv").container).toBe("mkv");
  });

  it("explicit mp4 token -> container mp4", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.WEB-DL.H264-GRP.mp4").container).toBe("mp4");
  });

  it("webm token -> container webm", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.WEB-DL.VP9.webm").container).toBe("webm");
  });

  it("mov token -> container mov", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.WEB-DL.H264.mov").container).toBe("mov");
  });

  it("REMUX with no explicit container token -> inferred mkv (real-world convention)", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.UHD.BluRay.REMUX.DTS-HD.MA-GROUP");
    expect(r.container).toBe("mkv");
  });

  it("no container/remux token at all -> unknown (never fabricated)", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.WEB-DL.H264-GRP").container).toBe("unknown");
  });
});

describe("effectiveReleaseContainer — URL wins over REMUX title", () => {
  it("plays a REMUX-named file as MP4 when the unrestricted URL is .mp4", () => {
    expect(
      effectiveReleaseContainer(
        "https://cdn.example/d/ABC/Movie.2024.2160p.UHD.BluRay.REMUX.mkv.mp4",
        "mkv"
      )
    ).toBe("mp4");
  });

  it("keeps MKV when the unrestricted URL really is .mkv", () => {
    expect(
      effectiveReleaseContainer(
        "https://cdn.example/d/ABC/Movie.2024.2160p.UHD.BluRay.REMUX.mkv",
        "mp4"
      )
    ).toBe("mkv");
  });
});

describe("isDirectPlayDebridRelease", () => {
  it("rejects MKV and lossless audio that would remux", () => {
    expect(isDirectPlayDebridRelease("mkv", "aac")).toBe(false);
    expect(isDirectPlayDebridRelease("mp4", "dts")).toBe(false);
    expect(isDirectPlayDebridRelease("mp4", "eac3")).toBe(true);
    expect(isDirectPlayDebridRelease("unknown", "aac")).toBe(true);
  });
});

describe("isBrowserPlayableContainer — the absolute NATIVE browser-playability gate (no longer a drop filter — consumed by source-quality.ts's isSourcePlayableHere to decide native vs. /api/vod/open)", () => {
  it("mp4/mov/unknown are eligible", () => {
    expect(isBrowserPlayableContainer("mp4")).toBe(true);
    expect(isBrowserPlayableContainer("mov")).toBe(true);
    expect(isBrowserPlayableContainer("unknown")).toBe(true);
  });

  it("mkv/webm are NEVER eligible — no browser, including Safari, plays them", () => {
    expect(isBrowserPlayableContainer("mkv")).toBe(false);
    expect(isBrowserPlayableContainer("webm")).toBe(false);
  });
});

describe("parseSeeders", () => {
  it("parses the 👤 N seeders footer Torrentio appends", () => {
    expect(parseSeeders("Movie.2024.1080p.WEB-DL.H264-GRP\n👤 137 💾 4.2 GB ⚙️ YTS")).toBe(137);
  });

  it("returns 0 when the footer is absent, never throws", () => {
    expect(parseSeeders("Movie.2024.1080p.WEB-DL.H264-GRP")).toBe(0);
    expect(parseSeeders("")).toBe(0);
  });
});

describe("parseSizeBytes", () => {
  it("parses decimal GB and integer MB Torrentio footers", () => {
    expect(parseSizeBytes("Release\nseeders 2 size 1.68 GB source X")).toBe(
      Math.round(1.68 * 1024 ** 3)
    );
    expect(parseSizeBytes("Release 401 MB")).toBe(401 * 1024 ** 2);
  });

  it("returns null for missing, zero, or malformed sizes", () => {
    expect(parseSizeBytes("Release without a size")).toBeNull();
  });

  it("prefers the selected file's size over a pack size in the name", () => {
    expect(parseSizeBytes("Complete Box Set [26.8GB]\n👤 3 💾 1.5 GB ⚙️ 1337x")).toBe(1.5 * 1024 ** 3);
    expect(parseSizeBytes("Release 0 GB")).toBeNull();
    expect(parseSizeBytes("Release many GB")).toBeNull();
    expect(parseSizeBytes(`Release ${"1"}${"0".repeat(300)} GB`)).toBeNull();
  });
});

/**
 * Candidate pool stratification — the actual fix for the "top 8 by
 * resolution can miss every browser-safe release" gap. Mocks `fetch` at the
 * boundary (Torrentio's JSON endpoint only) so this exercises the real
 * `fetchTorrentioCandidates` -> parse -> filter -> per-class rank/cap path
 * end-to-end, following the same boundary-mocking convention used by
 * torbox.test.ts / torbox-standalone.test.ts elsewhere in this folder.
 */
describe("fetchTorrentioCandidates — MKV/HEVC kept (transcoder-link) + per-class stratification", () => {
  const originalFetch = globalThis.fetch;
  const FAKE_TOKEN = "test-rd-token";

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("prefers a larger legitimate 1080p BluRay over a lean WEB-DL while dropping captures/packs", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            title: "Movie.2024.1080p.WEB-DL.H264.mp4\n👤 40 💾 3 GB",
            infoHash: "b".repeat(40),
          },
          {
            title: "Movie.2024.1080p.BluRay.H264.mp4\n👤 5 💾 8 GB",
            infoHash: "h".repeat(40),
          },
          {
            title: "Movie.2024.1080p.HD-TS.H264.mp4\n👤 9999 💾 3 GB",
            infoHash: "t".repeat(40),
          },
          {
            title: "IMDb Top 250 - 1080p BluRay H264.mp4\n👤 9999 💾 3 GB",
            infoHash: "p".repeat(40),
          },
          {
            title: "Movie.2024.Featurettes.1080p.H264.mp4\n👤 9999 💾 3 GB",
            infoHash: "f".repeat(40),
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000005",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    expect(candidates.map((candidate) => candidate.infoHash)).toEqual([
      "h".repeat(40),
      "b".repeat(40),
    ]);
  });

  it("keeps unknown size neutral and preserves deterministic input order on a full tie", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            title: "Movie.2024.1080p.WEB-DL.H264.FIRST.mp4\n👤 20",
            infoHash: "1".repeat(40),
          },
          {
            title: "Movie.2024.1080p.WEB-DL.H264.SECOND.mp4\n👤 20",
            infoHash: "2".repeat(40),
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000010",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    expect(candidates.map((candidate) => candidate.infoHash)).toEqual([
      "1".repeat(40),
      "2".repeat(40),
    ]);
    expect(candidates.every((candidate) => candidate.sizeBytes == null)).toBe(true);
  });

  it("breaks a size/seeder tie on how the release was mastered", async () => {
    // Identical class, container, size and seeders — the only difference is
    // WEB-DL vs WEBRip. Before release-scorer.ts nothing in candidateRankScore
    // described mastering at all, so these tied and input order decided it.
    // The weaker release is listed first here so a pass cannot come from the
    // input order being preserved.
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            title: "Movie.2024.1080p.WEBRip.H264.mp4\n👤 100 💾 3 GB",
            infoHash: "1".repeat(40),
          },
          {
            title: "Movie.2024.1080p.WEB-DL.H264.mp4\n👤 100 💾 3 GB",
            infoHash: "2".repeat(40),
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000009",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    expect(candidates.map((candidate) => candidate.infoHash)).toEqual([
      "2".repeat(40),
      "1".repeat(40),
    ]);
  });

  it("drops explicit RD-download rows but retains an instant native 720p fallback", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            name: "[RD download] Torrentio\n1080p",
            title: "Not.Instant.1080p.H264.mp4",
            infoHash: "d".repeat(40),
          },
          {
            name: "[RD+] Torrentio\n720p",
            title: "Instant.Fallback.720p.H264.mp4",
            infoHash: "f".repeat(40),
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000004",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    expect(candidates.map((candidate) => candidate.infoHash)).toEqual([
      "f".repeat(40),
    ]);
    expect(candidates[0]?.resolutionHeight).toBe(720);
  });

  /**
   * The MKV drop was removed (see torrentio.ts module header): the
   * in-container transcoder now handles anything a browser can't decode/
   * demux directly, so an MKV/HEVC candidate must survive selection with
   * its real `container`/`codec` intact — dropping it would silently lose a
   * real (often the BEST) release rather than routing it through
   * /api/vod/open.
   */
  it("keeps an MKV/HEVC 4K release — top of its class by seeders, container/codec preserved for the client's transcode gate", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            // Top-seeded 4K release by a wide margin, and MKV — must now
            // survive (previously dropped outright).
            title: "Movie.2024.2160p.UHD.BluRay.x265.HDR.mkv\n👤 900 💾 40 GB ⚙️ X",
            infoHash: "m".repeat(40),
            fileIdx: 0,
          },
          {
            title: "Movie.2024.1080p.WEB-DL.H264-GRP.mp4\n👤 20 💾 2 GB ⚙️ X",
            infoHash: "n".repeat(40),
            fileIdx: 0,
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000001",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    const mkv = candidates.find((c) => c.infoHash === "m".repeat(40));
    expect(mkv).toBeDefined();
    expect(mkv?.container).toBe("mkv");
    expect(mkv?.codec).toBe("hevc");
    expect(mkv?.compat).toBe("safari");
    // The plain H.264/MP4 1080p release still survives too — kept, not displaced.
    expect(candidates.some((c) => c.infoHash === "n".repeat(40))).toBe(true);
  });

  it("keeps a plain H.264-in-MKV 1080p release with its container intact (isBrowserPlayableContainer/isSourcePlayableHere decide honesty downstream, not this parser)", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            title: "Movie.2024.1080p.BluRay.x264.mkv\n👤 50 💾 3 GB ⚙️ X",
            infoHash: "p".repeat(40),
            fileIdx: 0,
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000003",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    const mkvH264 = candidates.find((c) => c.infoHash === "p".repeat(40));
    expect(mkvH264).toBeDefined();
    expect(mkvH264?.container).toBe("mkv");
    expect(mkvH264?.codec).toBe("h264");
  });

  it("keeps representation across native/safari x 1080/2160 classes even when one class dominates the raw list", async () => {
    const streams: { title: string; infoHash: string; fileIdx: number }[] = [];
    // 30 HEVC 4K releases (would fill an old flat top-8/30 cut entirely).
    for (let i = 0; i < 30; i++) {
      streams.push({
        title: `Movie.2024.2160p.UHD.BluRay.x265.HDR.mp4\n👤 ${100 - i} 💾 20 GB ⚙️ X`,
        infoHash: `a${i}`.padEnd(40, "0"),
        fileIdx: 0,
      });
    }
    // A handful of native 1080p and one native 4K release mixed in.
    streams.push({
      title: "Movie.2024.2160p.WEB-DL.H264-GRP.mp4\n👤 10 💾 15 GB ⚙️ X",
      infoHash: "native4k".padEnd(40, "0"),
      fileIdx: 0,
    });
    for (let i = 0; i < 3; i++) {
      streams.push({
        title: `Movie.2024.1080p.WEB-DL.H264-GRP${i}.mp4\n👤 ${5 - i} 💾 2 GB ⚙️ X`,
        infoHash: `n1080${i}`.padEnd(40, "0"),
        fileIdx: 0,
      });
    }

    globalThis.fetch = (async () => jsonResponse({ streams })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000002",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    const native2160 = candidates.filter((c) => c.compat === "native" && c.resolutionHeight === 2160);
    const safari2160 = candidates.filter((c) => c.compat === "safari" && c.resolutionHeight === 2160);
    const native1080 = candidates.filter((c) => c.compat === "native" && c.resolutionHeight === 1080);

    expect(native2160.length).toBeGreaterThan(0);
    expect(safari2160.length).toBeGreaterThan(0);
    expect(native1080.length).toBe(3);
  });

  it("drops movie packs and collections but keeps a normal single feature", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            title: "Movie.2024.1080p.WEB-DL.H264-GRP.mp4\n👤 40 💾 3 GB",
            infoHash: "k".repeat(40),
            fileIdx: 0,
          },
          {
            title: "MCU Complete Collection 1080p BluRay H264\n👤 90 💾 80 GB",
            infoHash: "c".repeat(40),
            fileIdx: 0,
          },
          {
            title: "Some Show Complete Series 1080p WEB-DL\n👤 80 💾 40 GB",
            infoHash: "s".repeat(40),
            fileIdx: 0,
          },
          {
            title: "Movie Season 1 1080p BluRay H264\n👤 50 💾 12 GB",
            infoHash: "p".repeat(40),
            fileIdx: 0,
          },
          {
            title: "Director Filmography 1080p H264\n👤 20 💾 30 GB",
            infoHash: "f".repeat(40),
            fileIdx: 0,
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000011",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    expect(candidates.map((candidate) => candidate.infoHash)).toEqual([
      "k".repeat(40),
    ]);
  });
});

describe("isMoviePackRelease", () => {
  it("flags season packs, complete sets, collections, and trilogies", () => {
    expect(isMoviePackRelease("Show S01 1080p BluRay")).toBe(true);
    expect(isMoviePackRelease("Movie Season 2 1080p")).toBe(true);
    expect(isMoviePackRelease("Complete Series 1080p")).toBe(true);
    expect(isMoviePackRelease("Marvel Collection 2160p")).toBe(true);
    expect(isMoviePackRelease("X-Men Filmography 1080p")).toBe(true);
    expect(isMoviePackRelease("Dark Knight Trilogy 1080p")).toBe(true);
    expect(
      isMoviePackRelease("Plexbomb.Top100.movies.of.2024.pack.1080p.x264")
    ).toBe(true);
    expect(
      isMoviePackRelease(
        "Trilogia - Se Beber Não Case! (2009-2013) Dual Áudio 1080p"
      )
    ).toBe(true);
  });

  it("keeps a normal single-feature release name", () => {
    expect(isMoviePackRelease("Movie.2024.1080p.WEB-DL.H264-GRP")).toBe(false);
    expect(isMoviePackRelease("Season of the Witch 2011 1080p WEB-DL")).toBe(
      false
    );
  });
});

/**
 * Torrentio's title line arrives with dots already flattened to spaces, so a
 * codec written "H 265" or "H 264" matched none of the original patterns. At
 * 4K an unrecognised codec defaults to "safari" and the row is marked
 * unavailable — so a parser miss and a genuinely unplayable release were
 * indistinguishable in the UI.
 */
describe("parseReleaseTitle — space-separated codec tokens", () => {
  it("reads 'H 265' as HEVC (observed live on a cached Dark 2160p release)", () => {
    const r = parseReleaseTitle(
      "Dark S01E01 Secrets 2160p NF WEB-DL DUAL DDP5 1 Atmos H 265-Kitsune"
    );
    expect(r.codec).toBe("hevc");
    expect(r.compat).toBe("safari");
  });

  it("reads 'H 264' as H.264 — the miss that was costing watchable 4K", () => {
    const r = parseReleaseTitle("Movie 2024 2160p WEB-DL DDP5 1 H 264-GRP");
    expect(r.codec).toBe("h264");
    expect(r.compat).toBe("native");
  });

  it("still reads the dotted and bare forms", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.H.265-GRP").codec).toBe("hevc");
    expect(parseReleaseTitle("Movie.2024.1080p.h264-GRP").codec).toBe("h264");
    expect(parseReleaseTitle("Movie.2024.1080p.x265-GRP").codec).toBe("hevc");
    expect(parseReleaseTitle("Movie 2024 1080p x 264-GRP").codec).toBe("h264");
  });

  it("reads AV1 in both the AV1 and AV01 spellings", () => {
    expect(parseReleaseTitle("Movie.2024.2160p.WEB-DL.AV1-GRP").codec).toBe("av1");
    expect(parseReleaseTitle("Movie.2024.2160p.WEB-DL.AV01-GRP").codec).toBe("av1");
  });

  it("does not mistake a resolution or year for a codec", () => {
    // No H/x prefix, so nothing here should read as 264/265.
    expect(parseReleaseTitle("Movie.1265.2024.1080p.WEB-DL-GRP").codec).toBe("unknown");
  });
});

describe("parseReleaseTitle - audio evidence", () => {
  it("recognises browser-unsafe lossless and cinema audio", () => {
    expect(
      parseReleaseTitle("Movie.2024.2160p.REMUX.TrueHD.7.1.Atmos.mkv")
        .audioCodec
    ).toBe("truehd");
    expect(
      parseReleaseTitle("Movie.2024.1080p.BluRay.DTS-HD.MA.5.1.mkv")
        .audioCodec
    ).toBe("dts");
    expect(
      parseReleaseTitle("Movie.2024.1080p.WEB-DL.DDP5.1.H264.mp4")
        .audioCodec
    ).toBe("eac3");
  });

  it("recognises direct-safe audio and multi-language releases", () => {
    const release = parseReleaseTitle(
      "Movie.2024.1080p.WEB-DL.DUAL-AUDIO.AAC.H264.mp4"
    );
    expect(release.audioCodec).toBe("aac");
    expect(release.multiAudio).toBe(true);
  });
});

describe("isStereoscopicRelease", () => {
  it("rejects the explicit layout tokens seen in live Torrentio data", () => {
    const real = [
      "Avatar.2009.EXTENDED.1080p.3D.BluRay.Half-SBS.x264.DTS-HD.MA.5.1-RARBG",
      "Avatar.2009.EXTENDED.1080p.3D.BluRay.Half-OU.x264.DTS-HD.MA.5.1-RARBG",
      "Gravity.2013.1080p.3D.BluRay.Half-SBS.x264.TrueHD.7.1.Atmos-RARBG",
      "Gravity.3D.2013.1080p.BluRay.Half-SBS.DTS.x264-PublicHD",
      "Avatar The Way of Water (2022) 3D HSBS BluRay 1080p H264 DolbyD 5.1 + nickarad",
      "Dune Part Two 2024 1080p 3D FULL SBS HEVC ENG HUN iFA AI3D",
      "Аватар в 3Д / Avatar 3D [2009 BDRip 1080p] SideBySide / Горизонтальная стереопара",
      "Avatar: The Way of Water 3D BluRay 1080p48 x264 E-AC3 5.1",
      "Gravity.2013.3D.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-Asmo",
    ];
    for (const title of real) {
      expect(isStereoscopicRelease(title)).toBe(true);
    }
  });

  it("keeps ordinary flat releases", () => {
    const flat = [
      "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX",
      "Gravity.2013.1080p.BluRay.x264.YIFY",
      "Avatar.2009.EXTENDED.2160p.UHD.BluRay.x265-TERMiNAL",
      "Top.Gun.Maverick.2022.1080p.WEBRip.x264-RARBG",
      "The.Batman.2022.2160p.WEB-DL.DDP5.1.Atmos.HDR.HEVC-CMRG",
    ];
    for (const title of flat) {
      expect(isStereoscopicRelease(title)).toBe(false);
    }
  });

  it("does not exclude a film whose own title contains 3D", () => {
    // "3D" here precedes the year and qualifies no source token, so it reads as
    // part of the movie name rather than a stereoscopic release tag.
    expect(
      isStereoscopicRelease("Spy Kids 3-D Game Over 2003 1080p WEBRip x264-RARBG")
    ).toBe(false);
    expect(
      isStereoscopicRelease("Spy.Kids.3D.Game.Over.2003.1080p.AMZN.WEB-DL.DDP5.1.H.264")
    ).toBe(false);
  });
});

describe("fetchTorrentioCandidates: the original language first", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function answer(titles: string[]): void {
    const streams = titles.map((title, i) => ({ title: `${title}\n👤 ${900 - i} 💾 6 GB`, infoHash: String(i).repeat(40).slice(0, 40) }));
    globalThis.fetch = (async () => new Response(JSON.stringify({ streams }), { status: 200 })) as unknown as typeof fetch;
  }
  const find = (originalLanguage?: string) =>
    fetchTorrentioCandidates({ imdbId: "tt0000009", mediaType: "movie", rdToken: "test-rd-token", originalLanguage });

  it("leaves dubs and foreign-subtitled releases out when the original was found, however well seeded", async () => {
    answer([
      "Movie.2024.TRUEFRENCH.1080p.WEB.H264.mp4",
      "Movie.2024.1080p.WEB-DL.H264.RGzsRutracker.mp4",
      "Movie.2024.1080p.HDTV.Subtitulado.Esp.H264.mp4",
      "Movie.2024.1080p.WEB-DL.H264-NTb.mp4",
    ]);
    const titles = (await find()).map((c) => c.title);
    expect(titles).toEqual(["Movie.2024.1080p.WEB-DL.H264-NTb.mp4"]);
  });

  it("puts a release in the original alone ahead of one that only contains it", async () => {
    answer(["Movie.2024.MULTi.1080p.BluRay.H264.mp4", "Movie.2024.1080p.WEB-DL.H264-NTb.mp4"]);
    const titles = (await find()).map((c) => c.title);
    expect(titles).toEqual(["Movie.2024.1080p.WEB-DL.H264-NTb.mp4", "Movie.2024.MULTi.1080p.BluRay.H264.mp4"]);
  });

  it("still offers a dub when it is all there is", async () => {
    answer(["Movie.2024.TRUEFRENCH.1080p.WEB.H264.mp4", "Movie.2024.iTA.1080p.WEB.H264.mp4"]);
    expect((await find()).length).toBe(2);
  });

  it("judges against the language the title was made in", async () => {
    answer(["Film.2019.FRENCH.1080p.BluRay.H264.mp4", "Film.2019.1080p.BluRay.English.Dubbed.H264.mp4"]);
    expect((await find("fr")).map((c) => c.title)).toEqual(["Film.2019.FRENCH.1080p.BluRay.H264.mp4"]);
  });
});

describe("fetchTorrentioCandidates: the title that was asked for", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function answer(streams: { title: string; filename?: string }[]): void {
    const body = streams.map((stream, i) => ({
      title: `${stream.title}\n👤 ${900 - i} 💾 6 GB`,
      infoHash: String(i).repeat(40).slice(0, 40),
      ...(stream.filename ? { behaviorHints: { filename: stream.filename } } : {}),
    }));
    globalThis.fetch = (async () => new Response(JSON.stringify({ streams: body }), { status: 200 })) as unknown as typeof fetch;
  }
  const avengers = { titles: ["The Avengers"], year: 2012 };
  const find = (facts?: typeof avengers | null) =>
    fetchTorrentioCandidates({ imdbId: "tt0000011", mediaType: "movie", rdToken: "test-rd-token", facts });

  it("drops another title's release and another film's file", async () => {
    answer([
      { title: "Avengers.Age.of.Ultron.2015.1080p.BluRay.H264.mp4" },
      { title: "The.Avengers.2012.1080p.BluRay.H264.mp4", filename: "The.Avengers.1998.1080p.BluRay.H264.mp4" },
      { title: "The.Avengers.2012.1080p.WEB-DL.H264.mp4" },
    ]);
    expect((await find(avengers)).map((c) => c.title)).toEqual(["The.Avengers.2012.1080p.WEB-DL.H264.mp4"]);
  });

  it("puts a release that names the title ahead of a better seeded one that only resembles it", async () => {
    answer([{ title: "Marvels.The.Avengers.2012.1080p.BluRay.H264.mp4" }, { title: "The.Avengers.2012.1080p.BluRay.H264.mp4" }]);
    const found = await find(avengers);
    expect(found.map((c) => c.title)).toEqual(["The.Avengers.2012.1080p.BluRay.H264.mp4", "Marvels.The.Avengers.2012.1080p.BluRay.H264.mp4"]);
    expect(found.map((c) => c.unverified ?? false)).toEqual([false, true]);
  });

  it("checks nothing, and ranks nothing down, without the title's names", async () => {
    answer([{ title: "Avengers.Age.of.Ultron.2015.1080p.BluRay.H264.mp4" }, { title: "The.Avengers.2012.1080p.BluRay.H264.mp4" }]);
    for (const facts of [undefined, null]) {
      const found = await find(facts);
      expect(found.length).toBe(2);
      expect(found.some((c) => c.unverified)).toBe(false);
    }
  });
});

describe("fetchTorrentioKitsuCandidates", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function answer(asked: string[]): void {
    const streams = [{ title: "[Group] Show - 03 [1080p][HEVC].mkv\n👤 40 💾 1.4 GB", infoHash: "c".repeat(40) }];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ streams }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("asks the index by entry and episode, with the token when there is one", async () => {
    const asked: string[] = [];
    answer(asked);
    const found = await fetchTorrentioKitsuCandidates({ kitsuId: 46474, episode: 3, rdToken: "test-rd-token" });
    expect(asked[0]).toEndWith("/realdebrid=test-rd-token/stream/series/kitsu:46474:3.json");
    expect(found.map((c) => c.infoHash)).toEqual(["c".repeat(40)]);
  });

  it("asks unconfigured when there is none, for the tiers that take only its hashes", async () => {
    const asked: string[] = [];
    answer(asked);
    const found = await fetchTorrentioKitsuCandidates({ kitsuId: 46474, episode: 3 });
    expect(asked[0]).toEndWith("/stream/series/kitsu:46474:3.json");
    expect(asked[0]).not.toContain("realdebrid");
    expect(found.length).toBe(1);
  });
});

describe("index request outcome", () => {
  const originalFetch = globalThis.fetch;
  const originalTiming = { ...torrentioTiming };
  const RD_TOKEN = "test-rd-token";
  const RELEASE = { title: "Movie.2024.1080p.WEB-DL.H264-GRP\n👤 30 💾 3 GB", infoHash: "a".repeat(40) };
  type Reply = () => Response | Promise<Response>;

  let server: ReturnType<typeof Bun.serve>;
  /** The path and query of each request the local index received, in order. */
  let asked: string[] = [];
  /** How the local index answers, one reply per request; the last one repeats. */
  let replies: Reply[] = [];
  let events: TorrentioFetchInfo[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { pathname, search } = new URL(req.url);
        asked.push(`${pathname}${search}`);
        const reply = replies.length > 1 ? replies.shift() : replies[0];
        return reply ? reply() : new Response("{}", { status: 500 });
      },
    });
  });

  beforeEach(() => {
    asked = [];
    replies = [];
    events = [];
    torrentioTiming.timeoutMs = 2_000;
    torrentioTiming.retryDelayMs = 20;
    torrentioEvents.onFetch = (info) => events.push(info);
    // Torrentio's address is fixed when the module loads, so each index request is sent to the local server instead, with its path and query kept.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/stream/")) return originalFetch(input, init);
      const { pathname, search } = new URL(url);
      return originalFetch(`http://127.0.0.1:${server.port}${pathname}${search}`, init);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(torrentioTiming, originalTiming);
    torrentioEvents.onFetch = null;
  });

  afterAll(() => {
    server.stop(true);
  });

  const json = (body: unknown): Reply => () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const withStreams = json({ streams: [RELEASE] });
  const noStreams = json({ streams: [] });
  const serverError: Reply = () => new Response("upstream error", { status: 500 });
  const after = (ms: number, reply: Reply): Reply => () =>
    new Promise((resolve) => setTimeout(() => resolve(reply()), ms));
  const request = { imdbId: "tt0000021", mediaType: "movie" as const, rdToken: RD_TOKEN };

  it("reports an answer with streams as ok, asked once", async () => {
    replies = [withStreams];
    const found = await fetchTorrentioCandidates(request);
    expect(found.length).toBe(1);
    expect(torrentioOutcomeOf(found)).toBe("ok");
    expect(asked.length).toBe(1);
    expect(events).toEqual([
      { endpoint: "configured", outcome: "ok", status: 200, ms: expect.any(Number), count: 1, retried: false },
    ]);
  });

  it("treats an answer that lists no streams as empty, and asks once more before believing it", async () => {
    replies = [noStreams, noStreams];
    const found = await fetchTorrentioCandidates(request);
    expect(found).toEqual([]);
    expect(torrentioOutcomeOf(found)).toBe("empty");
    expect(isTorrentioIndexFailure(torrentioOutcomeOf(found))).toBe(false);
    expect(asked.length).toBe(2);
    expect(asked[0]).not.toContain("retry=");
    expect(asked[1]).toContain("retry=");
    expect(events.map((e) => [e.outcome, e.retried])).toEqual([["empty", true]]);
  });

  it("retries a failed first answer once, under a different URL, and the retry's answer stands", async () => {
    replies = [serverError, withStreams];
    const found = await fetchTorrentioCandidates(request);
    expect(found.length).toBe(1);
    expect(torrentioOutcomeOf(found)).toBe("ok");
    expect(asked.length).toBe(2);
    expect(asked[1]?.split("?")[0]).toBe(asked[0]);
    expect(asked[1]).toContain("retry=");
    expect(events).toEqual([expect.objectContaining({ outcome: "ok", status: 200, retried: true })]);
    // The wait before the retry is in the elapsed time.
    expect(events[0]?.ms ?? 0).toBeGreaterThanOrEqual(15);
  });

  it("reports an HTTP error with its status, after one retry", async () => {
    replies = [serverError, serverError];
    const found = await fetchTorrentioCandidates(request);
    expect(found).toEqual([]);
    expect(torrentioOutcomeOf(found)).toBe("http_error");
    expect(isTorrentioIndexFailure(torrentioOutcomeOf(found))).toBe(true);
    expect(asked.length).toBe(2);
    expect(events).toEqual([expect.objectContaining({ outcome: "http_error", status: 500, count: 0, retried: true })]);
  });

  it("reports a body that is not JSON, or not an index answer, as bad_json", async () => {
    replies = [() => new Response("<html>gateway</html>", { status: 200 }), json({ ok: true })];
    const found = await fetchTorrentioCandidates(request);
    expect(found).toEqual([]);
    expect(torrentioOutcomeOf(found)).toBe("bad_json");
    expect(asked.length).toBe(2);
  });

  it("reports a request that runs past the timeout as timeout", async () => {
    torrentioTiming.timeoutMs = 50;
    replies = [after(400, noStreams)];
    const found = await fetchTorrentioCandidates(request);
    expect(torrentioOutcomeOf(found)).toBe("timeout");
    expect(asked.length).toBe(2);
    expect(events[0]?.status).toBeUndefined();
  });

  it("does not retry a first attempt that already took longer than the limit", async () => {
    torrentioTiming.noRetryAfterMs = 20;
    replies = [after(80, serverError), withStreams];
    const found = await fetchTorrentioCandidates(request);
    expect(torrentioOutcomeOf(found)).toBe("http_error");
    expect(asked.length).toBe(1);
    expect(events).toEqual([expect.objectContaining({ outcome: "http_error", retried: false })]);
  });

  it("reports the Kitsu and un-configured requests under their own endpoints, and never reports the token", async () => {
    replies = [serverError, serverError];
    const kitsu = await fetchTorrentioKitsuCandidates({ kitsuId: 46474, episode: 3, rdToken: RD_TOKEN });
    expect(torrentioOutcomeOf(kitsu)).toBe("http_error");

    replies = [withStreams];
    const plain = await fetchTorrentioCandidatesNoDebrid({ imdbId: "tt0000021", mediaType: "movie" });
    expect(torrentioOutcomeOf(plain)).toBe("ok");

    expect(events.map((e) => e.endpoint)).toEqual(["kitsu", "unconfigured"]);
    expect(JSON.stringify(events)).not.toContain(RD_TOKEN);
    for (const event of events) expect(Object.keys(event)).not.toContain("url");
  });
});

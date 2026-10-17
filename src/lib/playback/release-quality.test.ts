import { describe, expect, it } from "bun:test";
import {
  assessRelease,
  BPP_STARVED,
  compareReleaseQuality,
  type ReleaseQuality,
  type ReleaseQualityInput,
} from "./release-quality";

const MIB = 1_048_576;
/** Decimal gigabytes: with 1 GB = 10^9 bytes, a 62 GB film is about 65 Mbit/s of video. */
const GB = 1_000_000_000;
const EPISODE_MINUTES = 23;
const FILM_MINUTES = 120;

function input(
  releaseTitle: string,
  height: ReleaseQualityInput["height"],
  codec: ReleaseQualityInput["codec"],
  sizeBytes: number | null,
  runtimeMinutes: number | null,
  extra: Partial<ReleaseQualityInput> = {}
): ReleaseQualityInput {
  return { releaseTitle, height, codec, sizeBytes, runtimeMinutes, ...extra };
}

/** Real Rick and Morty S03E10 release names, with the sizes of the files they describe. */
const RICK = {
  rarbg: input("Rick.and.Morty.S03.1080p.BluRay.x265-RARBG", 1080, "hevc", 363 * MIB, EPISODE_MINUTES),
  kontrast: input("Rick.and.Morty.S03.1080p.BluRay.x265-KONTRAST", 1080, "hevc", 497 * MIB, EPISODE_MINUTES),
  prof: input(
    "Rick and Morty (2013) S03 Extras (1080p x265 HEVC 10bit BluRay TrueHD 5.1) [Prof]",
    1080,
    "hevc",
    1040 * MIB,
    EPISODE_MINUTES
  ),
  cpt: input(
    "Rick and Morty S03 Season 3 [1080p BluRay REMUX AVC TrueHD 5.1]-CPT",
    1080,
    "h264",
    1677 * MIB,
    EPISODE_MINUTES
  ),
  upscale: input(
    "Rick and Morty S03 2160p BluRay AI AV1 TrueHD 5.1 [Enrav1sh]",
    2160,
    "av1",
    1365 * MIB,
    EPISODE_MINUTES
  ),
  p720: input(
    "Rick y Morty (2013) Seasons (1-7) 720p (Spanish & English Audio & Sub)",
    720,
    "unknown",
    225 * MIB,
    EPISODE_MINUTES
  ),
};

/** Film releases at 120 minutes. */
const FILM = {
  remux: input(
    "Example.Film.2024.2160p.UHD.BluRay.REMUX.HEVC.DV.HDR10.TrueHD.7.1-FraMeSToR",
    2160,
    "hevc",
    62 * GB,
    FILM_MINUTES
  ),
  flux: input("Example.Film.2024.2160p.AMZN.WEB-DL.DDP5.1.Atmos.HDR10.H.265-FLUX", 2160, "hevc", 14 * GB, FILM_MINUTES),
  ethel: input("Example.Film.2024.2160p.WEB.H265-ETHEL", 2160, "hevc", 3.5 * GB, FILM_MINUTES),
  psa: input("Example.Film.2024.1080p.WEB.H.264-PSA", 1080, "h264", 2.1 * GB, FILM_MINUTES),
  sparks: input("Example.Film.2024.1080p.BluRay.x264-SPARKS", 1080, "h264", 10 * GB, FILM_MINUTES),
  yts: input("Example.Film.2024.1080p.WEBRip.x264.AAC5.1-[YTS.MX]", 1080, "h264", 2.0 * GB, FILM_MINUTES, {
    fileName: "Example.Film.2024.1080p.WEBRip.x264.AAC5.1-[YTS.MX].mp4",
  }),
};

function rank(entries: Record<string, ReleaseQualityInput>): string[] {
  return Object.entries(entries)
    .map(([name, release]) => ({ name, quality: assessRelease(release) }))
    .sort((a, b) => compareReleaseQuality(a.quality, b.quality))
    .map((entry) => entry.name);
}

function assessed(
  title: string,
  height: ReleaseQualityInput["height"] = 1080,
  extra: Partial<ReleaseQualityInput> = {}
) {
  return assessRelease(input(title, height, "h264", null, null, extra));
}

describe("Rick and Morty S03E10 releases (23 minutes)", () => {
  it("reads RARBG as a low-quality 1080p HEVC encode at about 0.07 bits per pixel", () => {
    const q = assessRelease(RICK.rarbg);
    expect(q.flags).toContain("lq-group");
    expect(q.bpp).not.toBeNull();
    expect(q.bpp as number).toBeGreaterThan(0.07);
    expect(q.bpp as number).toBeLessThan(0.09);
    expect(q.tier).toBe(3);
    // 363 MiB over 23 minutes is 2.21 Mbit/s; the 0.4 Mbit/s audio default leaves 1.81.
    expect(q.videoMbps).toBeCloseTo(1.8066, 3);
  });

  it("scores KONTRAST above RARBG at the same tier", () => {
    const rarbg = assessRelease(RICK.rarbg);
    const kontrast = assessRelease(RICK.kontrast);
    expect(kontrast.tier).toBe(3);
    expect(kontrast.flags).not.toContain("lq-group");
    expect(kontrast.score).toBeGreaterThan(rarbg.score);
  });

  it("scores Prof above KONTRAST: its TrueHD track and bitrate outweigh the bpp gap", () => {
    // Prof's bitrate is ~2.53 Mbit/s after the 60% audio cap, so its bpp is a
    // little below KONTRAST's. The TrueHD bonus closes that gap, by about 0.2
    // points: 281.5 against 281.3. Whole-number scores would tie them.
    const kontrast = assessRelease(RICK.kontrast);
    const prof = assessRelease(RICK.prof);
    expect(prof.tier).toBe(3);
    expect(prof.score).toBeGreaterThan(kontrast.score);
    expect(prof.videoMbps).toBeCloseTo(2.5287, 3);
  });

  it("flags the REMUX as remux and ranks it best of the 1080p set", () => {
    const cpt = assessRelease(RICK.cpt);
    expect(cpt.flags).toContain("remux");
    expect(cpt.effectiveHeight).toBe(1080);
    expect(cpt.tier).toBe(3);
    for (const other of [RICK.prof, RICK.kontrast, RICK.rarbg]) {
      expect(cpt.score).toBeGreaterThan(assessRelease(other).score);
    }
  });

  it("demotes the 2160p AI AV1 upscale to effective 1080p, tier 1", () => {
    const q = assessRelease(RICK.upscale);
    expect(q.flags).toContain("upscaled");
    expect(q.effectiveHeight).toBe(1080);
    expect(q.tier).toBe(1);
    // The file is starved at its own 4K height, which is why it is demoted to 1080p at all.
    expect(q.reasons.join("\n")).toContain("starved at 4K");
  });

  it("sorts the upscale below every 1080p release that is not flagged", () => {
    const upscale = assessRelease(RICK.upscale);
    for (const other of [RICK.cpt, RICK.prof, RICK.kontrast, RICK.rarbg]) {
      expect(compareReleaseQuality(assessRelease(other), upscale)).toBeLessThan(0);
    }
  });

  it("sorts the full set as CPT REMUX, Prof, KONTRAST, RARBG, then the upscale, then the 720p", () => {
    // 720p sorts last because height is the first key: it ranks after the
    // upscale, which is effective 1080p, even though both are flagged.
    expect(rank(RICK)).toEqual(["cpt", "prof", "kontrast", "rarbg", "upscale", "p720"]);
  });

  it("flags the 720p Spanish pack as starved and sorts it last", () => {
    const q = assessRelease(RICK.p720);
    expect(q.effectiveHeight).toBe(720);
    expect(q.flags).toContain("starved");
    expect(q.tier).toBe(1);
    expect(rank(RICK).at(-1)).toBe("p720");
  });
});

describe("film releases (120 minutes)", () => {
  it("marks a 62 GB REMUX as heavy at about 65 Mbit/s of video, tier 2", () => {
    const q = assessRelease(FILM.remux);
    expect(q.flags).toContain("heavy");
    expect(q.flags).toContain("remux");
    expect(q.tier).toBe(2);
    expect(q.effectiveHeight).toBe(2160);
    expect(q.videoMbps).toBeCloseTo(64.889, 2);
    expect(q.reasons.join("\n")).toContain("group FraMeSToR remux T1 +60");
  });

  it("gives the 14 GB AMZN WEB-DL 2160p tier 3, with Atmos estimated as DD+", () => {
    const q = assessRelease(FILM.flux);
    expect(q.tier).toBe(3);
    expect(q.effectiveHeight).toBe(2160);
    // 14 GB over 120 minutes is 15.56 Mbit/s; Atmos over DDP is 0.768 Mbit/s of audio.
    expect(q.videoMbps).toBeCloseTo(14.7876, 3);
    expect(q.reasons.join("\n")).toContain("streaming service AMZN +15");
  });

  it("sorts the WEB-DL above the heavy REMUX, and both above every 1080p release", () => {
    const flux = assessRelease(FILM.flux);
    const remux = assessRelease(FILM.remux);
    expect(compareReleaseQuality(flux, remux)).toBeLessThan(0);
    for (const other of [FILM.sparks, FILM.psa, RICK.cpt]) {
      expect(compareReleaseQuality(flux, assessRelease(other))).toBeLessThan(0);
      expect(compareReleaseQuality(remux, assessRelease(other))).toBeLessThan(0);
    }
  });

  it("ranks the starved 2160p WEB encode as a 1080p picture, not starved", () => {
    const q = assessRelease(FILM.ethel);
    expect(q.effectiveHeight).toBe(1080);
    expect(q.tier).toBe(3);
    expect(q.bpp).toBeCloseTo(0.1402, 3);
    expect(q.flags).not.toContain("starved");
    expect(q.reasons.join("\n")).toContain("starved at 4K");
  });

  it("keeps a 4K file that is still starved at 1080p as starved, tier 1", () => {
    // 1.26 GB over 120 minutes is 1.4 Mbit/s, so about 1.0 Mbit/s of video: starved at 4K and at 1080p.
    const q = assessRelease(input("Example.Film.2024.2160p.WEB.H265-ETHEL", 2160, "hevc", 1.26 * GB, FILM_MINUTES));
    expect(q.effectiveHeight).toBe(1080);
    expect(q.flags).toContain("starved");
    expect(q.tier).toBe(1);
  });

  it("flags a 2.1 GB 1080p WEB encode from a low-quality group as starved, tier 1", () => {
    const q = assessRelease(FILM.psa);
    expect(q.flags).toContain("lq-group");
    expect(q.flags).toContain("starved");
    expect(q.tier).toBe(1);
  });

  it("gives a 1080p BluRay from an unlisted group full detail and no group points", () => {
    const q = assessRelease(FILM.sparks);
    expect(q.tier).toBe(3);
    expect(q.flags).toEqual([]);
    expect(q.score).toBe(460);
    expect(q.reasons.join("\n")).not.toContain("group");
  });

  it("flags the [YTS.MX] bracket group as low quality", () => {
    const q = assessRelease(FILM.yts);
    expect(q.flags).toContain("lq-group");
    expect(q.bpp as number).toBeLessThan(0.1);
  });

  it("scores unknown size as neutral detail, with no bpp and no starved flag", () => {
    const q = assessRelease(input("Example.Film.2024.1080p.BluRay.x264-SPARKS", 1080, "h264", null, FILM_MINUTES));
    expect(q.videoMbps).toBeNull();
    expect(q.bpp).toBeNull();
    expect(q.flags).not.toContain("starved");
    expect(q.tier).toBe(3);
    // Neutral detail is half the range (200), plus the BluRay source (+60).
    expect(q.score).toBe(260);
    expect(q.reasons.join("\n")).toContain("bitrate unknown");
  });

  it("sorts the film set as WEB-DL 2160p, heavy REMUX, 1080p BluRay, then starved 1080p", () => {
    expect(rank({ remux: FILM.remux, flux: FILM.flux, psa: FILM.psa, sparks: FILM.sparks })).toEqual([
      "flux",
      "remux",
      "sparks",
      "psa",
    ]);
  });
});

describe("upscale detection", () => {
  it.each([
    "Rick and Morty S03 2160p BluRay AI AV1 TrueHD 5.1 [Enrav1sh]",
    "Rick and Morty Season 1-4 Upscale 2160p x265 - Uncensored",
    "Spider-Man Brand New Day (2026) WebDL 2160p. 4K SDR AV1 AI 12Mbps Rus-Eng",
    "House.of.the.Dragon.S01.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie",
  ])("flags as upscaled: %s", (title) => {
    expect(assessed(title, 2160).flags).toContain("upscaled");
  });

  it("does not flag an 'A.I.' film title", () => {
    expect(assessed("A.I. Artificial Intelligence 2001 1080p BluRay x264").flags).not.toContain("upscaled");
  });

  it("does not flag the IMAX Enhanced phrase, which is a Dolby marketing term", () => {
    const q = assessed("Movie.2024.2160p.DSNP.WEB-DL.DV.HDR.IMAX.Enhanced.DDP5.1.H.265-FLUX", 2160);
    expect(q.flags).not.toContain("upscaled");
    expect(q.effectiveHeight).toBe(2160);
  });

  it("keeps an upscaled 1080p at effective 1080p and demotes it to tier 1", () => {
    const q = assessed("Show.S01E01.1080p.AI.Upscaled.WEB-DL.H264-GRP");
    expect(q.flags).toContain("upscaled");
    expect(q.effectiveHeight).toBe(1080);
    expect(q.tier).toBe(1);
  });

  it("flags interpolated frame rates as interpolated, tier 1", () => {
    const q = assessed("Movie.2024.1080p.BluRay.x264.60fps-GRP");
    expect(q.flags).toContain("interpolated");
    expect(q.tier).toBe(1);
  });
});

describe("hardcoded subtitle detection", () => {
  it("flags an uppercase HC token", () => {
    expect(assessed("The.Show.S01E01.HC.1080p.WEB-DL-GRP").flags).toContain("hardsub");
  });

  it("does not flag a lowercase hc, which is usually part of a word", () => {
    expect(assessed("The.Show.S01E01.hc.1080p.BluRay-GRP").flags).not.toContain("hardsub");
  });

  it("flags HC-SUBS, HARDCODED and KORSUB", () => {
    expect(assessed("The.Show.S01E01.1080p.HC-SUBS.BluRay-GRP").flags).toContain("hardsub");
    expect(assessed("Movie 2024 HARDCODED 1080p BluRay x264").flags).toContain("hardsub");
    expect(assessed("Movie 2024 KORSUB 1080p WEB-DL").flags).toContain("hardsub");
  });
});

describe("Dolby Vision without an HDR10 fallback", () => {
  it("flags DV on a WEB source with no HDR10 fallback", () => {
    const q = assessed("Show.S01E01.2160p.WEB-DL.DV.DDP5.1.H.265-GRP", 2160);
    expect(q.flags).toContain("dv-only");
    expect(q.tier).toBe(1);
  });

  it("does not flag DV that carries an HDR10 fallback", () => {
    expect(assessed("Show.S01E01.2160p.WEB-DL.DV.HDR10.DDP5.1.H.265-GRP", 2160).flags).not.toContain("dv-only");
  });

  it("does not flag DV on a disc source", () => {
    expect(assessed("Show.S01E01.2160p.BluRay.DV.HEVC-GRP", 2160).flags).not.toContain("dv-only");
  });

  it("does not flag DV from Hulu", () => {
    expect(assessed("Show.S01E01.2160p.HULU.WEB-DL.DV.DDP5.1.H.265-GRP", 2160).flags).not.toContain("dv-only");
  });

  it("reads underscore separators too", () => {
    expect(assessed("Show_S01E01_2160p_WEB_DL_DV_H265-NTb", 2160).flags).toContain("dv-only");
  });
});

describe("source, service and group detection", () => {
  it("reads dot, space and dash separators in a WEB-DL with a service and a WEB group", () => {
    const title = "South Park S29E03 You Like That On Your Face 1080p AMZN WEB-DL DDP5 1 H 264-Kitsune";
    const text = assessRelease(input(title, 1080, "h264", 2 * GB, 22)).reasons.join("\n");
    expect(text).toContain("source WEB-DL +60");
    expect(text).toContain("group Kitsune WEB T1 +40");
    expect(text).toContain("streaming service AMZN +15");
    expect(text).toContain("audio DD+/E-AC-3/DTS +8");
  });

  it("reads underscore separators for source and group", () => {
    const text = assessRelease(input("Show_S01E01_1080p_WEB_DL_x264-NTb", 1080, "h264", null, null)).reasons.join("\n");
    expect(text).toContain("source WEB-DL +60");
    expect(text).toContain("group NTb WEB T1 +40");
  });

  it("treats a bare WEB tag with a streaming service as WEB-DL", () => {
    const text = assessRelease(input("Show.S01E01.1080p.NF.WEB.H264-GRP", 1080, "h264", null, null)).reasons.join("\n");
    expect(text).toContain("source WEB-DL +60");
  });

  it("does not read the MA of DTS-HD MA as a streaming service", () => {
    const text = assessRelease(input("Show.S01E01.1080p.DTS-HD.MA.WEB-DL-GRP", 1080, "h264", null, null)).reasons.join(
      "\n"
    );
    expect(text).not.toContain("streaming service");
  });

  it("reads MA as a service when it is a platform tag", () => {
    const text = assessRelease(input("Show.S01E01.1080p.MA.WEB-DL-GRP", 1080, "h264", null, null)).reasons.join("\n");
    expect(text).toContain("streaming service MA +15");
  });

  it("gives a remux group its remux-tier points", () => {
    expect(assessed("Movie.2024.2160p.UHD.BluRay.REMUX.HEVC-FraMeSToR", 2160).reasons.join("\n")).toContain(
      "group FraMeSToR remux T1 +60"
    );
  });

  it("gives a group tiered for another source only the mismatch points", () => {
    // ATELiER is a remux and Blu-ray group, not a WEB-DL one.
    const text = assessed("Show.S01E01.1080p.WEB-DL.H264-ATELiER").reasons.join("\n");
    expect(text).toContain("group ATELiER is tiered for another source +10");
  });

  it("reads anime groups only for anime titles", () => {
    const title = "[Group] Show - 05 (WEB 1080p) -Half-Baked";
    expect(assessRelease(input(title, 1080, "h264", null, null, { anime: true })).reasons.join("\n")).toContain(
      "group Half-Baked anime WEB T2 +32"
    );
    expect(assessRelease(input(title, 1080, "h264", null, null)).reasons.join("\n")).not.toContain("Half-Baked");
  });

  it("flags anime low-quality groups only for anime titles", () => {
    const title = "Show - 05 1080p WEB-DL -Bonkai";
    expect(assessRelease(input(title, 1080, "h264", null, null, { anime: true })).flags).toContain("lq-group");
    expect(assessRelease(input(title, 1080, "h264", null, null)).flags).not.toContain("lq-group");
  });

  it("flags a title term that names a low-quality group", () => {
    expect(assessed("Movie 2024 1080p BluRay x264 YIFY").flags).toContain("lq-group");
  });
});

describe("remaining flags", () => {
  it("flags a repack, a hybrid and a 1080p cut from 4K", () => {
    expect(assessed("Movie.2024.1080p.REPACK.BluRay.x264-GRP").flags).toContain("repack");
    expect(assessed("Movie.2024.1080p.BluRay.Hybrid.x264-GRP").flags).toContain("hybrid");
    expect(assessed("Movie.2024.1080p.DS4K.BluRay.x264-GRP").flags).toContain("downscaled-4k");
  });

  it("flags downscaled-4k only on 1080p", () => {
    expect(assessed("Movie.2024.720p.DS4K.BluRay.x264-GRP", 720).flags).not.toContain("downscaled-4k");
  });
});

describe("bitrate estimation", () => {
  it("takes TrueHD and Atmos at 4.0 Mbit/s of audio", () => {
    // 10 GB over 120 minutes is 11.11 Mbit/s total; TrueHD takes 4.0 of it.
    const q = assessRelease(input("Movie.2024.1080p.BluRay.TrueHD.x264-GRP", 1080, "h264", 10 * GB, FILM_MINUTES));
    expect(q.videoMbps).toBeCloseTo(7.1111, 3);
  });

  it("takes DTS-HD MA at 3.0 Mbit/s of audio", () => {
    const q = assessRelease(input("Movie.2024.1080p.BluRay.DTS-HD.MA.x264-GRP", 1080, "h264", 10 * GB, FILM_MINUTES));
    expect(q.videoMbps).toBeCloseTo(8.1111, 3);
  });

  it("takes AAC at 0.256 Mbit/s of audio", () => {
    const q = assessRelease(input("Movie.2024.1080p.WEB-DL.AAC.x264-GRP", 1080, "h264", 2 * GB, FILM_MINUTES));
    expect(q.videoMbps).toBeCloseTo(1.9662, 3);
  });

  it("returns null bitrate and bpp when the runtime is missing", () => {
    const q = assessRelease(input("Movie.2024.1080p.BluRay.x264-GRP", 1080, "h264", 10 * GB, null));
    expect(q.videoMbps).toBeNull();
    expect(q.bpp).toBeNull();
  });

  it("counts HEVC at twice the H.264 bits per pixel", () => {
    const h264 = assessRelease(input("Movie.2024.1080p.BluRay.x264-GRP", 1080, "h264", 2 * GB, FILM_MINUTES));
    const hevc = assessRelease(input("Movie.2024.1080p.BluRay.x265-GRP", 1080, "hevc", 2 * GB, FILM_MINUTES));
    expect(hevc.bpp as number).toBeCloseTo((h264.bpp as number) * 2, 6);
  });

  it("treats a bitrate under 0.05 bits per pixel as starved", () => {
    expect(BPP_STARVED).toBe(0.05);
    expect(assessRelease(FILM.psa).bpp as number).toBeLessThan(BPP_STARVED);
  });
});

describe("compareReleaseQuality", () => {
  function quality(over: Partial<ReleaseQuality>): ReleaseQuality {
    return {
      effectiveHeight: 1080,
      tier: 3,
      score: 100,
      flags: [],
      videoMbps: 5,
      bpp: 0.1,
      reasons: [],
      ...over,
    };
  }

  it("ranks effective height first", () => {
    const upscaled2160 = quality({ effectiveHeight: 2160, tier: 1 });
    expect(compareReleaseQuality(upscaled2160, quality({ effectiveHeight: 1080 }))).toBeLessThan(0);
  });

  it("ranks tier before score", () => {
    expect(compareReleaseQuality(quality({ tier: 3, score: 1 }), quality({ tier: 2, score: 900 }))).toBeLessThan(0);
  });

  it("ranks score before bitrate", () => {
    const higherScore = quality({ score: 200, videoMbps: 1 });
    expect(compareReleaseQuality(higherScore, quality({ score: 100, videoMbps: 9 }))).toBeLessThan(0);
  });

  it("sorts an unknown bitrate last among equals", () => {
    expect(compareReleaseQuality(quality({ videoMbps: 2 }), quality({ videoMbps: null }))).toBeLessThan(0);
    expect(compareReleaseQuality(quality({ videoMbps: null }), quality({ videoMbps: 2 }))).toBeGreaterThan(0);
    expect(compareReleaseQuality(quality({ videoMbps: null }), quality({ videoMbps: null }))).toBe(0);
  });

  it("returns 0 for equal releases", () => {
    expect(compareReleaseQuality(quality({}), quality({}))).toBe(0);
  });
});

describe("assessRelease determinism", () => {
  it("returns the same assessment for the same input", () => {
    expect(assessRelease(RICK.prof)).toEqual(assessRelease(RICK.prof));
  });
});

describe("assessRelease — token forms seen in real titles", () => {
  it("reads AAC5.1 as AAC audio, not the unknown-audio default", () => {
    const withTrack = assessRelease({ releaseTitle: "Film.2024.1080p.WEBRip.x264.AAC5.1", height: 1080, codec: "h264", sizeBytes: 2_000_000_000, runtimeMinutes: 120 });
    const unknown = assessRelease({ releaseTitle: "Film.2024.1080p.WEBRip.x264", height: 1080, codec: "h264", sizeBytes: 2_000_000_000, runtimeMinutes: 120 });
    expect(withTrack.videoMbps!).toBeGreaterThan(unknown.videoMbps!);
  });

  it("reads BDRemux as a remux", () => {
    const quality = assessRelease({ releaseTitle: "Film 2024 1080p BDRemux AVC DTS-HD MA", height: 1080, codec: "h264", sizeBytes: null, runtimeMinutes: null });
    expect(quality.flags).toContain("remux");
  });

  it("gives Dolby Vision with an HDR10+ fallback the full HDR points", () => {
    const quality = assessRelease({ releaseTitle: "Film.2024.2160p.WEB-DL.DV.HDR10+.DDP5.1.H.265-FLUX", height: 2160, codec: "hevc", sizeBytes: 14_000_000_000, runtimeMinutes: 120 });
    expect(quality.reasons.some((reason) => reason.includes("+30"))).toBe(true);
  });
});

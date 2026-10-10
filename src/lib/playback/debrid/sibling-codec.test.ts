/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { debridTitleMatch, siblingTierCodec } from "./index";

describe("siblingTierCodec", () => {
  it("keeps a codec the resolver read from the file", () => {
    expect(siblingTierCodec("hevc", "Show S02 2160p BluRay AV1")).toBe("hevc");
    expect(siblingTierCodec("av1", "Show S02 2160p")).toBe("av1");
  });

  it("reads the release title when the file gave nothing (rows cached before the codec was stored)", () => {
    expect(siblingTierCodec(undefined, "Rick and Morty S02 2160p BluRay AI AV1 TrueHD 5.1 [Enrav1sh]")).toBe("av1");
    expect(siblingTierCodec("unknown", "Tires.S03.2160p.NF.WEB-DL.DV.HDR.DDP5.1.H265.MP4-BTM")).toBe("hevc");
    expect(siblingTierCodec(undefined, "Tires S03E01 1080p WEB H264-CAKES")).toBe("h264");
  });

  it("stays unknown when neither says", () => {
    expect(siblingTierCodec(undefined, "Rick and Morty S02 Season 2 [1080p] [REMUX] [BDRip]")).toBe("unknown");
  });
});

describe("debridTitleMatch", () => {
  it("takes a season pack for the episode asked for", () => {
    expect(debridTitleMatch("tv", "Rick and Morty S02 2160p BluRay AI AV1 TrueHD 5.1 [Enrav1sh]")).toBe("exact");
    expect(debridTitleMatch("tv", "Dark.Matter.2024.S01.1080p.x265-ELiTE")).toBe("exact");
    expect(debridTitleMatch("tv", "Rick and Morty Season 1-4 Upscale 2160p x265 - Uncensored")).toBe("exact");
  });

  it("still holds a film collection back", () => {
    expect(debridTitleMatch("movie", "The.Matrix.Trilogy.1999-2003.2160p.UHD.BluRay.x265")).toBe("pack");
    expect(debridTitleMatch("movie", "Project.Hail.Mary.2026.2160p.WEB-DL.H265")).toBe("exact");
  });
});

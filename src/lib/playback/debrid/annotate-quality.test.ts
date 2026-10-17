/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { annotateDebridQuality } from "./annotate-quality";
import type { PlaybackSource } from "../types";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** A native debrid source of the given height, as the Real-Debrid roster builds one. */
function debrid(overrides: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    id: "debrid-tt0-movie-0-0-native-1080-1",
    url: "https://cdn.example/d/file.mp4",
    provider: "Debrid",
    quality: "1080p",
    label: "1080p • Debrid",
    type: "mp4",
    maxHeight: 1080,
    origin: "debrid",
    compat: "native",
    codec: "h264",
    releaseTitle: "Movie.2024.1080p.WEB-DL.H264-GRP",
    ...overrides,
  };
}

describe("annotateDebridQuality", () => {
  it("sets the tier, score and flags of a debrid source from its release, and leaves its bitrate unset", () => {
    const source = debrid({ releaseTitle: "Movie.2024.2160p.WEB-DL.H264-GRP", maxHeight: 2160, quality: "2160p", sizeBytes: 20 * GiB });
    annotateDebridQuality([source], 120, false);
    expect(source?.maxHeight).toBe(2160);
    expect(source?.qualityTier).toBe(3);
    expect(source?.qualityScore).toBe(331.4);
    expect(source?.qualityFlags).toEqual([]);
    expect(source?.bitrateBps).toBeUndefined();
  });

  it("lowers an upscaled 4K to the 1080p it shows, and says so in its label", () => {
    const list = [
      debrid({
        id: "debrid-tt0-movie-0-0-native-2160",
        releaseTitle: "Rick and Morty S03 2160p BluRay AI AV1 TrueHD 5.1 [Enrav1sh]",
        codec: "av1",
        maxHeight: 2160,
        quality: "2160p",
        label: "4K • Debrid",
        sizeBytes: 1365 * MiB,
      }),
    ];
    annotateDebridQuality(list, 23, false);
    expect(list[0]).toMatchObject({
      maxHeight: 1080,
      quality: "1080p",
      label: "4K • Debrid · upscaled",
      qualityTier: 1,
      qualityScore: 475,
      qualityFlags: ["upscaled"],
    });
  });

  it("ranks a 4K that is starved at its own height as the 1080p it shows, and keeps a label that is not an upscale", () => {
    const list = [
      debrid({
        releaseTitle: "Movie.2024.2160p.WEB-DL.H264-GRP",
        maxHeight: 2160,
        quality: "2160p",
        label: "4K • Debrid",
        sizeBytes: 4 * GiB,
      }),
    ];
    annotateDebridQuality(list, 120, false);
    expect(list[0]).toMatchObject({
      maxHeight: 1080,
      quality: "1080p",
      label: "4K • Debrid",
      qualityTier: 3,
      qualityScore: 211.4,
      qualityFlags: [],
    });
  });

  it("judges the size without a runtime as unknown, so the release reads as neutral", () => {
    const list = [debrid({ releaseTitle: "Movie.2024.1080p.BluRay.H264-GRP", sizeBytes: 3 * GiB })];
    annotateDebridQuality(list, null, false);
    expect(list[0]).toMatchObject({ maxHeight: 1080, qualityTier: 3, qualityScore: 260, qualityFlags: [] });
  });

  it("leaves embed sources, and debrid sources with no release title, as they were", () => {
    const embed = { ...debrid(), origin: undefined, releaseTitle: "Movie.2024.2160p.WEB-DL.H264-GRP" } as PlaybackSource;
    const untitled = debrid({ releaseTitle: undefined });
    annotateDebridQuality([embed, untitled], 120, false);
    for (const source of [embed, untitled]) {
      expect(source.qualityTier).toBeUndefined();
      expect(source.qualityScore).toBeUndefined();
      expect(source.maxHeight).toBe(1080);
    }
  });

  it("annotates the same list and the same sources in place, so an identity-keyed answer keeps its key", () => {
    const first = debrid({ releaseTitle: "Movie.2024.1080p.BluRay.x265-GRP", sizeBytes: 9 * GiB });
    const second = debrid({ id: "debrid-tt0-movie-0-0-native-1080-2" });
    const list = [first, second];
    annotateDebridQuality(list, 120, false);
    expect(list[0]).toBe(first);
    expect(list[1]).toBe(second);
    expect(list).toHaveLength(2);
    expect(first.qualityTier).toBe(3);
    expect(first.qualityScore).toBe(460);
  });

  it("keeps the reading a source already has, so annotating an answer twice does not change it", () => {
    const list = [debrid({ releaseTitle: "Rick and Morty S03 2160p BluRay AI AV1 TrueHD 5.1 [Enrav1sh]", codec: "av1", maxHeight: 2160, quality: "2160p", label: "4K • Debrid", sizeBytes: 1365 * MiB })];
    annotateDebridQuality(list, 23, false);
    annotateDebridQuality(list, null, false);
    expect(list[0]).toMatchObject({ maxHeight: 1080, label: "4K • Debrid · upscaled", qualityScore: 475, qualityFlags: ["upscaled"] });
  });
});

import { describe, expect, it } from "bun:test";
import { providerLabel, streamQualityBucket } from "./scraper-labels";

describe("providerLabel", () => {
  it("is the provider's name in lower case, with only letters, digits, - and _", () => {
    expect(providerLabel("CinePro")).toBe("cinepro");
    expect(providerLabel("vid link!")).toBe("vidlink");
    expect(providerLabel("cinema-os_2")).toBe("cinema-os_2");
  });

  it("is other for no name, or one that is not a string", () => {
    expect(providerLabel("")).toBe("other");
    expect(providerLabel("!!!")).toBe("other");
    expect(providerLabel(42)).toBe("other");
    expect(providerLabel(undefined)).toBe("other");
  });

  it("is cut to a short label", () => {
    expect(providerLabel("a".repeat(100))).toHaveLength(24);
  });
});

describe("streamQualityBucket", () => {
  it("is the probed height when the stream was probed", () => {
    expect(streamQualityBucket({ maxHeight: 2160, quality: "1080p" })).toBe("2160");
    expect(streamQualityBucket({ maxHeight: 1080, quality: "480p" })).toBe("1080");
  });

  it("is the height its quality label names when it was not probed", () => {
    expect(streamQualityBucket({ maxHeight: 0, quality: "720p" })).toBe("720");
    expect(streamQualityBucket({ quality: "1080p" })).toBe("1080");
    expect(streamQualityBucket({ quality: "4K" })).toBe("2160");
  });

  it("is unknown when neither says a height", () => {
    expect(streamQualityBucket({ quality: "auto" })).toBe("unknown");
    expect(streamQualityBucket({})).toBe("unknown");
  });
});

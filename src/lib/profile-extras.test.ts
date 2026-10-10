/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { EXTRA_SPECS, extrasFromRows, extrasPatch, parseAccent, parseRowList } from "./profile-extras";

describe("extrasFromRows", () => {
  it("fills every default for a profile with nothing saved", () => {
    const extras = extrasFromRows(new Map());
    expect(extras.seekStep).toBe(10);
    expect(extras.autoplayNext).toBe(true);
    expect(extras.autoSkipIntro).toBe(false);
    expect(extras.stillWatchingAfter).toBe(3);
    expect(extras.homeHidden).toEqual([]);
    expect(extras.captionColor).toBe("white");
  });

  it("reads stored strings back into their types", () => {
    const extras = extrasFromRows(
      new Map([
        [EXTRA_SPECS.seekStep.key, "30"],
        [EXTRA_SPECS.autoSkipIntro.key, "on"],
        [EXTRA_SPECS.stillWatchingAfter.key, "0"],
        [EXTRA_SPECS.homeHidden.key, "anime,service:hulu"],
        [EXTRA_SPECS.accent.key, "#12ab34"],
      ])
    );
    expect(extras.seekStep).toBe(30);
    expect(extras.autoSkipIntro).toBe(true);
    expect(extras.stillWatchingAfter).toBe(0);
    expect(extras.homeHidden).toEqual(["anime", "service:hulu"]);
    expect(extras.accent).toBe("#12ab34");
  });

  it("ignores stale or corrupt values", () => {
    const extras = extrasFromRows(new Map([[EXTRA_SPECS.seekStep.key, "7"], [EXTRA_SPECS.captionSize.key, "huge"]]));
    expect(extras.seekStep).toBe(10);
    expect(extras.captionSize).toBe("medium");
  });
});

describe("extrasPatch", () => {
  it("turns API values into rows", () => {
    const patch = extrasPatch({ seekStep: 15, heroAutoplay: false, homeHidden: ["anime"], captionFont: "serif" });
    expect(patch).toEqual({
      rows: [
        [EXTRA_SPECS.captionFont.key, "serif"],
        [EXTRA_SPECS.heroAutoplay.key, "off"],
        [EXTRA_SPECS.seekStep.key, "15"],
        [EXTRA_SPECS.homeHidden.key, "anime"],
      ],
    });
  });

  it("names the first invalid field and writes nothing", () => {
    expect(extrasPatch({ seekStep: 12 })).toEqual({ invalid: "seekStep" });
    expect(extrasPatch({ accent: "javascript:alert(1)" })).toEqual({ invalid: "accent" });
    expect(extrasPatch({ homeHidden: ["ok", "<script>"] })).toEqual({ invalid: "homeHidden" });
  });

  it("leaves out fields that were not sent", () => {
    expect(extrasPatch({ playbackQuality: 1080 })).toEqual({ rows: [] });
  });
});

describe("parsers", () => {
  it("accepts preset and custom accents only", () => {
    expect(parseAccent("crimson")).toBe("crimson");
    expect(parseAccent("#ABCDEF")).toBe("#abcdef");
    expect(parseAccent("#abc")).toBeNull();
    expect(parseAccent(5)).toBeNull();
  });

  it("parses row lists from arrays and stored text", () => {
    expect(parseRowList("")).toEqual([]);
    expect(parseRowList(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(parseRowList(42)).toBeNull();
  });
});

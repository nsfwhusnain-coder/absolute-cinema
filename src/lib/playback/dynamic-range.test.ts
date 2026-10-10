/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  dynamicRangeBadge,
  dynamicRangeLimit,
  hdrOutputControllable,
  isHdrLikeRange,
  normalizeDynamicRange,
  parseHdrOutput,
} from "./dynamic-range";

describe("normalizeDynamicRange", () => {
  it("names what the remuxer and HLS playlists report", () => {
    expect(normalizeDynamicRange("SDR")).toBe("SDR");
    expect(normalizeDynamicRange("PQ")).toBe("HDR");
    expect(normalizeDynamicRange("HLG")).toBe("HDR");
    expect(normalizeDynamicRange("DV")).toBe("Dolby Vision");
    expect(normalizeDynamicRange("HDR10+")).toBe("HDR10+");
  });

  it("treats anything unrecognised as SDR", () => {
    expect(normalizeDynamicRange("")).toBe("SDR");
    expect(normalizeDynamicRange("bt709")).toBe("SDR");
    expect(isHdrLikeRange("bt709")).toBe(false);
    expect(isHdrLikeRange("PQ")).toBe(true);
  });
});

describe("HDR output choice", () => {
  it("leaves the browser alone unless the viewer turned HDR off", () => {
    expect(dynamicRangeLimit("on")).toBeUndefined();
    expect(dynamicRangeLimit("off")).toBe("standard");
  });

  it("defaults to on for anything but an explicit off", () => {
    expect(parseHdrOutput("off")).toBe("off");
    expect(parseHdrOutput("on")).toBe("on");
    expect(parseHdrOutput(null)).toBe("on");
    expect(parseHdrOutput("standard")).toBe("on");
  });

  it("is offered only where the screen shows HDR and the browser can limit it", () => {
    const env = (limit: boolean, hdrScreen: boolean) => ({
      supports: (property: string) => limit && property === "dynamic-range-limit",
      matches: (query: string) => hdrScreen && query === "(dynamic-range: high)",
    });
    expect(hdrOutputControllable(env(true, true))).toBe(true);
    expect(hdrOutputControllable(env(false, true))).toBe(false);
    expect(hdrOutputControllable(env(true, false))).toBe(false);
    expect(hdrOutputControllable(null)).toBe(false);
  });
});

describe("dynamicRangeBadge", () => {
  it("shows the range only while it is actually being shown", () => {
    expect(dynamicRangeBadge("PQ", "on")).toBe("HDR");
    expect(dynamicRangeBadge("DV", "on")).toBe("Dolby Vision");
    expect(dynamicRangeBadge("PQ", "off")).toBeNull();
    expect(dynamicRangeBadge("SDR", "on")).toBeNull();
  });
});

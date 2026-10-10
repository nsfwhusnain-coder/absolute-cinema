/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  defaultHdrOutput,
  dynamicRangeBadge,
  dynamicRangeLimit,
  hdrLiftExponent,
  hdrOutputControllable,
  isHdrLikeRange,
  isPqRange,
  normalizeDynamicRange,
  parseHdrChoice,
  parseHdrLift,
  videoFrameRange,
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

  it("keeps the viewer's choice, and has none until they make one", () => {
    expect(parseHdrChoice("off")).toBe("off");
    expect(parseHdrChoice("on")).toBe("on");
    expect(parseHdrChoice(null)).toBeNull();
    expect(parseHdrChoice("standard")).toBeNull();
  });

  it("starts in HDR only where the browser says the screen shows video in HDR", () => {
    const screen = (videoHdr: boolean) => ({
      supports: () => true,
      // A MacBook Air: "dynamic-range: high" is true, "video-dynamic-range: high" is not.
      matches: (query: string) => query === "(dynamic-range: high)" || (videoHdr && query === "(video-dynamic-range: high)"),
    });
    expect(defaultHdrOutput(screen(false))).toBe("off");
    expect(defaultHdrOutput(screen(true))).toBe("on");
    expect(defaultHdrOutput(null)).toBe("off");
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

describe("brightening HDR kept to the standard range", () => {
  it("raises PQ pictures by the chosen amount, with no filter at all for Low", () => {
    expect(hdrLiftExponent("PQ", "off", "medium")).toBe(0.75);
    expect(hdrLiftExponent("PQ", "off", "high")).toBe(0.6);
    expect(hdrLiftExponent("PQ", "off", "low")).toBeNull();
    expect(hdrLiftExponent("HDR10+", "off", "medium")).toBe(0.75);
  });

  it("leaves alone HDR shown as HDR, and pictures that are not PQ", () => {
    expect(hdrLiftExponent("PQ", "on", "high")).toBeNull();
    expect(hdrLiftExponent("SDR", "off", "high")).toBeNull();
    expect(hdrLiftExponent("HLG", "off", "high")).toBeNull();
    expect(hdrLiftExponent("DV", "off", "high")).toBeNull();
    expect(isPqRange("smpte2084")).toBe(true);
    expect(isPqRange("HLG")).toBe(false);
  });

  it("falls back to Medium for anything it does not know", () => {
    expect(parseHdrLift("high")).toBe("high");
    expect(parseHdrLift("low")).toBe("low");
    expect(parseHdrLift(null)).toBe("medium");
    expect(parseHdrLift("max")).toBe("medium");
  });
});

describe("videoFrameRange", () => {
  const video = {} as HTMLVideoElement;
  const frames = (transfer: string | null) =>
    class {
      colorSpace = { transfer };
      close(): void {}
    };

  it("reads PQ and HLG from the picture, and nothing from a standard one", () => {
    expect(videoFrameRange(video, frames("pq"))).toBe("PQ");
    expect(videoFrameRange(video, frames("hlg"))).toBe("HLG");
    expect(videoFrameRange(video, frames("bt709"))).toBeNull();
    expect(videoFrameRange(video, frames(null))).toBeNull();
  });

  it("is null where frames cannot be read", () => {
    const throws = class {
      constructor() {
        throw new Error("no frame yet");
      }
      close(): void {}
    };
    expect(videoFrameRange(video, throws)).toBeNull();
    expect(videoFrameRange(video, undefined)).toBeNull();
  });
});

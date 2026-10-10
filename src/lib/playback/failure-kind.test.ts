/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isViewerSideFailure } from "./failure-kind";

const failed = (reason: string, engine?: "hlsjs" | "native_file") => ({ event: "handoff_failed" as const, reason, engine });

describe("isViewerSideFailure", () => {
  it("is true for a codec the device cannot decode", () => {
    expect(isViewerSideFailure(failed("hls:bufferAddCodecError", "hlsjs"))).toBe(true);
    expect(isViewerSideFailure(failed("hls:bufferAppendError", "hlsjs"))).toBe(true);
    expect(isViewerSideFailure(failed("media:3", "hlsjs"))).toBe(true);
    expect(isViewerSideFailure(failed("media:3", "native_file"))).toBe(true);
  });

  it("is true for a file passed over for the profile's language or the screen's range", () => {
    expect(isViewerSideFailure(failed("no audio in the wanted language"))).toBe(true);
    expect(isViewerSideFailure(failed("Dolby Vision without an HDR10 layer needs a Dolby Vision screen"))).toBe(true);
  });

  it("takes an unsupported source for the device's fault only once hls.js had the stream", () => {
    expect(isViewerSideFailure(failed("media:4", "hlsjs"))).toBe(true);
    // On a plain file this is also what a dead link looks like.
    expect(isViewerSideFailure(failed("media:4", "native_file"))).toBe(false);
  });

  it("leaves the source's own failures alone", () => {
    expect(isViewerSideFailure(failed("timeout", "hlsjs"))).toBe(false);
    expect(isViewerSideFailure(failed("hls:fragLoadError", "hlsjs"))).toBe(false);
    expect(isViewerSideFailure(failed("remux open failed (502)"))).toBe(false);
    expect(isViewerSideFailure({ event: "stall", reason: "media:3" })).toBe(false);
    expect(isViewerSideFailure({ event: "first_frame" })).toBe(false);
  });
});

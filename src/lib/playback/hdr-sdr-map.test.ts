/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  DV_SHADOW_BRIGHTNESS,
  HDR_PEAK_CONTRAST,
  HDR_SHADOW_BRIGHTNESS,
  hdrSdrDisplayMap,
  isHdrLikeRange,
  MAX_DISPLAY_BRIGHTNESS,
  USER_BRIGHTNESS_DEFAULT,
} from "./hdr-sdr-map";

describe("hdrSdrDisplayMap — the filter the player applies", () => {
  it("leaves SDR at identity so Rec.709 titles are not washed out", () => {
    const mapped = hdrSdrDisplayMap({
      dynamicRange: "SDR",
      userBrightness: USER_BRIGHTNESS_DEFAULT,
    });
    expect(mapped.shadowLift).toBe(0);
    expect(mapped.brightness).toBe(1);
    expect(mapped.contrast).toBe(1);
    expect(mapped.cssFilter).toBe("none");
  });

  it("lifts HDR/PQ dark scenes without clipping peaks to 1.0 contrast", () => {
    const mapped = hdrSdrDisplayMap({ dynamicRange: "HDR" });
    expect(mapped.shadowLift).toBeGreaterThan(0);
    expect(mapped.brightness).toBe(HDR_SHADOW_BRIGHTNESS);
    expect(mapped.contrast).toBe(HDR_PEAK_CONTRAST);
    expect(mapped.contrast).toBeLessThan(1);
    expect(mapped.cssFilter).toContain(`brightness(${mapped.brightness})`);
    expect(mapped.cssFilter).toContain(`contrast(${HDR_PEAK_CONTRAST})`);
  });

  it("treats smpte2084 / pq labels as HDR, not SDR", () => {
    expect(isHdrLikeRange("smpte2084")).toBe(true);
    expect(hdrSdrDisplayMap({ dynamicRange: "pq" }).shadowLift).toBeGreaterThan(0);
    expect(hdrSdrDisplayMap({ dynamicRange: "hlg" }).shadowLift).toBeGreaterThan(0);
  });

  it("lifts Dolby Vision more than HDR10, still below the wash-out cap", () => {
    const hdr = hdrSdrDisplayMap({ dynamicRange: "HDR10" });
    const dv = hdrSdrDisplayMap({ dynamicRange: "Dolby Vision" });
    expect(dv.shadowLift).toBeGreaterThan(hdr.shadowLift);
    expect(dv.brightness).toBe(DV_SHADOW_BRIGHTNESS);
    expect(dv.brightness).toBeLessThanOrEqual(MAX_DISPLAY_BRIGHTNESS);
    expect(dv.contrast).toBeLessThan(1);
  });

  it("stacks the gesture brightness on top of the HDR lift", () => {
    const mapped = hdrSdrDisplayMap({
      dynamicRange: "HDR",
      userBrightness: 1.2,
    });
    expect(mapped.brightness).toBeGreaterThan(HDR_SHADOW_BRIGHTNESS);
    expect(mapped.contrast).toBe(HDR_PEAK_CONTRAST);
  });

  it("keeps an SDR gesture as brightness-only (no contrast fold)", () => {
    const mapped = hdrSdrDisplayMap({
      dynamicRange: "SDR",
      userBrightness: 1.2,
    });
    expect(mapped.shadowLift).toBe(0);
    expect(mapped.brightness).toBe(1.2);
    expect(mapped.contrast).toBe(1);
    expect(mapped.cssFilter).toBe("brightness(1.2)");
  });
});

import { describe, expect, it } from "bun:test";
import { deliveredRange, dolbyVisionDelivery, parseDolbyVisionRecord, type DolbyVisionInfo } from "./dolby-vision";

/** A 24-byte record as muxers write it: version 1.0, RPU and base layer present. */
function record(profile: number, level: number, compatibility: number): Uint8Array {
  const packed = (profile << 9) | (level << 3) | 0b101;
  return new Uint8Array([1, 0, packed >> 8, packed & 0xff, compatibility << 4, ...new Array<number>(19).fill(0)]);
}

const PROFILE_5: DolbyVisionInfo = { profile: 5, level: 6, baseLayer: "none" };
const PROFILE_8_1: DolbyVisionInfo = { profile: 8, level: 6, baseLayer: "hdr10" };

describe("parseDolbyVisionRecord", () => {
  it("reads the profile, level and what the base layer is on its own", () => {
    expect(parseDolbyVisionRecord(record(5, 6, 0))).toEqual(PROFILE_5);
    expect(parseDolbyVisionRecord(record(8, 6, 1))).toEqual(PROFILE_8_1);
    expect(parseDolbyVisionRecord(record(8, 9, 4))).toEqual({ profile: 8, level: 9, baseLayer: "hlg" });
    expect(parseDolbyVisionRecord(record(8, 5, 2))).toEqual({ profile: 8, level: 5, baseLayer: "sdr" });
    expect(parseDolbyVisionRecord(record(7, 6, 6))).toEqual({ profile: 7, level: 6, baseLayer: "hdr10" });
  });

  it("rejects a record too short to hold those fields", () => {
    expect(parseDolbyVisionRecord(new Uint8Array([1, 0, 0x0a, 0x35]))).toBeNull();
  });
});

describe("dolbyVisionDelivery", () => {
  it("plays a file with an ordinary base layer as that layer, on any screen", () => {
    expect(dolbyVisionDelivery(PROFILE_8_1, false)).toBe("base-layer");
    expect(dolbyVisionDelivery(PROFILE_8_1, true)).toBe("base-layer");
  });

  it("sends profile 5 as Dolby Vision where it can be decoded, and nowhere else", () => {
    expect(dolbyVisionDelivery(PROFILE_5, true)).toBe("dolby-vision");
    expect(dolbyVisionDelivery(PROFILE_5, false)).toBe("unplayable");
  });

  it("has nothing to say about files that are not Dolby Vision", () => {
    expect(dolbyVisionDelivery(null, true)).toBeNull();
  });
});

describe("deliveredRange", () => {
  it("reports Dolby Vision only when the stream is sent as Dolby Vision", () => {
    expect(deliveredRange("SDR", PROFILE_5, true)).toBe("DV");
  });

  it("reports the base layer's range even when the container states none", () => {
    expect(deliveredRange("SDR", PROFILE_8_1, false)).toBe("PQ");
    expect(deliveredRange("SDR", { profile: 8, level: 6, baseLayer: "hlg" }, false)).toBe("HLG");
  });

  it("otherwise keeps what the container states", () => {
    expect(deliveredRange("PQ", null, false)).toBe("PQ");
    expect(deliveredRange("SDR", { profile: 8, level: 6, baseLayer: "sdr" }, false)).toBe("SDR");
  });
});

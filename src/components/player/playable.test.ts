/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { normalizeHeight, qualityLabel } from "./playable";

describe("normalizeHeight", () => {
  it("calls an ordinary 1080-line picture 1080p, not 1440p", () => {
    expect(normalizeHeight(1080)).toBe(1080);
    expect(normalizeHeight(1038)).toBe(1080);
    expect(normalizeHeight(960)).toBe(1080);
  });

  it("snaps wide-screen pictures to the quality they are sold as", () => {
    expect(normalizeHeight(804)).toBe(1080);
    expect(normalizeHeight(800)).toBe(1080);
    expect(normalizeHeight(536)).toBe(720);
    expect(normalizeHeight(1608)).toBe(2160);
    expect(normalizeHeight(1600)).toBe(2160);
  });

  it("keeps the standard rungs as they are", () => {
    for (const rung of [360, 480, 720, 1080, 1440, 2160]) expect(normalizeHeight(rung)).toBe(rung);
  });

  it("labels 4K and everything else by lines", () => {
    expect(qualityLabel(normalizeHeight(2160))).toBe("4K");
    expect(qualityLabel(normalizeHeight(1080))).toBe("1080p");
    expect(qualityLabel(normalizeHeight(720))).toBe("720p");
  });

  it("does not invent a rung for something far below the smallest", () => {
    expect(normalizeHeight(200)).toBe(200);
  });
});

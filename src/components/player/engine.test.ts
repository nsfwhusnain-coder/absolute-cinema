import { describe, expect, it } from "bun:test";
import { openingLevel } from "./engine";

describe("openingLevel", () => {
  const levels = [{ height: 360 }, { height: 720 }, { height: 1080 }, { height: 2160 }];
  it("opens on the highest rendition at or below the target", () => {
    expect(openingLevel(levels, 1080)).toBe(2);
    expect(openingLevel(levels, 2160)).toBe(3);
    expect(openingLevel(levels, 900)).toBe(1);
  });
  it("falls back to the lowest rendition when all are above the target", () => {
    expect(openingLevel([{ height: 1080 }, { height: 720 }], 480)).toBe(1);
  });
  it("ignores renditions without a height", () => {
    expect(openingLevel([{ height: 0 }, { height: 720 }], 1080)).toBe(1);
  });
});

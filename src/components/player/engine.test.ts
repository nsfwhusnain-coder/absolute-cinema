import { describe, expect, it } from "bun:test";
import { autoFloorBitrate, openingLevel } from "./engine";

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

describe("autoFloorBitrate", () => {
  const ladder = [
    { height: 427, maxBitrate: 600_000 },
    { height: 720, maxBitrate: 2_500_000 },
    { height: 1080, maxBitrate: 5_000_000 },
    { height: 1080, maxBitrate: 4_200_000 },
  ];

  it("keeps automatic quality to the smallest 1080p rendition when there is one", () => {
    expect(autoFloorBitrate(ladder, 1_200_000)).toBe(4_200_000);
  });

  it("keeps to the tallest rendition when nothing reaches 1080p", () => {
    expect(autoFloorBitrate(ladder.slice(0, 2), 1_200_000)).toBe(2_500_000);
  });

  it("keeps to 1080p on a ladder that reaches 4K", () => {
    expect(autoFloorBitrate([...ladder, { height: 2160, maxBitrate: 16_000_000 }], 1_200_000)).toBe(4_200_000);
  });

  it("never goes under the least it is given, and ignores renditions of unknown size", () => {
    expect(autoFloorBitrate([{ height: 1080, maxBitrate: 800_000 }], 1_200_000)).toBe(1_200_000);
    expect(autoFloorBitrate([{ height: 0, maxBitrate: 9_000_000 }], 1_200_000)).toBe(1_200_000);
    expect(autoFloorBitrate([], 1_200_000)).toBe(1_200_000);
  });
});

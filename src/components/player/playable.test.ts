/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import type { PlaybackSource } from "@/lib/playback/types";
import { createRanker, isSuspect, normalizeHeight, qualityLabel } from "./playable";

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

const MBIT = 1_000_000 / 8;
const debrid = (id: string, maxHeight: number, cdnMbit?: number): PlaybackSource => ({
  id,
  url: `/${id}`,
  provider: "Debrid",
  quality: `${maxHeight}p`,
  label: id,
  type: "mp4",
  origin: "debrid",
  compat: "native",
  container: "mp4",
  codec: "h264",
  audioLanguage: "en",
  maxHeight,
  ...(cdnMbit === undefined ? {} : { cdnBytesPerSec: cdnMbit * MBIT }),
});
const web = (id: string, maxHeight: number): PlaybackSource => ({
  id,
  url: `https://example.test/${id}`,
  provider: "Vidrock",
  quality: `${maxHeight}p`,
  label: id,
  type: "hls",
  origin: "embed",
  codec: "h264",
  audioLanguage: "en",
  maxHeight,
});

describe("isSuspect", () => {
  it("doubts a file its CDN was measured too slow to carry, and no other", () => {
    expect(isSuspect(debrid("alldebrid-4k", 2160, 2.5))).toBe(true);
    expect(isSuspect(debrid("debrid-4k", 2160, 228))).toBe(false);
    expect(isSuspect(debrid("debrid-4k", 2160))).toBe(false);
  });

  it("leaves such a file for one that will play, and still takes it when it is alone", () => {
    const ranker = createRanker("auto", true, "");
    const slow = debrid("alldebrid-4k", 2160, 2.5);
    expect(ranker.pick([slow, debrid("debrid-1080", 1080, 228)])?.id).toBe("debrid-1080");
    expect(ranker.pick([slow])?.id).toBe("alldebrid-4k");
    expect(ranker.isSuspect?.(slow)).toBe(true);
  });
});

describe("a web stream against a debrid file of 1080p or better", () => {
  it("starts the debrid 1080p file over a web 2160 stream, for a 4K viewer and on auto", () => {
    const pool = [web("web-2160", 2160), debrid("debrid-1080", 1080)];
    expect(createRanker(2160, true, "").pick(pool)?.id).toBe("debrid-1080");
    expect(createRanker("auto", true, "").pick(pool)?.id).toBe("debrid-1080");
  });

  it("keeps the web 1080p stream when no debrid file reaches 1080p", () => {
    const pool = [web("web-1080", 1080), debrid("debrid-720", 720)];
    expect(createRanker("auto", true, "").pick(pool)?.id).toBe("web-1080");
  });

  it("is not pushed out by a debrid 1080p file its CDN cannot carry", () => {
    const pool = [web("web-2160", 2160), debrid("alldebrid-1080", 1080, 2.5)];
    expect(createRanker("auto", true, "").pick(pool)?.id).toBe("web-2160");
  });
});

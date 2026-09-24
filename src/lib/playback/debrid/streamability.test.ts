/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { estimatedMbps, orderForStreaming } from "./streamability";
import type { DebridCandidate } from "./torrentio";

const GB = 1024 ** 3;

function candidate(title: string, resolutionHeight: 720 | 1080 | 2160, sizeBytes?: number): DebridCandidate {
  return {
    title,
    resolutionHeight,
    seeders: 0,
    ...(sizeBytes ? { sizeBytes } : {}),
  } as DebridCandidate;
}

describe("estimatedMbps", () => {
  it("converts size and runtime to an average bitrate", () => {
    expect(Math.round(estimatedMbps(34 * GB, 62)!)).toBe(79);
  });

  it("is null without a size or runtime", () => {
    expect(estimatedMbps(undefined, 60)).toBeNull();
    expect(estimatedMbps(10 * GB, null)).toBeNull();
  });
});

describe("orderForStreaming", () => {
  it("moves a UHD remux behind a streamable 4K encode", () => {
    const remux = candidate("S01E01 2160p REMUX", 2160, 34 * GB);
    const encode = candidate("S01E01 2160p x265", 2160, 12 * GB);
    expect(orderForStreaming([remux, encode], 62).map((c) => c.title)).toEqual([encode.title, remux.title]);
  });

  it("orders heavy releases lightest first and keeps unknown sizes in front", () => {
    const heaviest = candidate("a", 2160, 60 * GB);
    const heavy = candidate("b", 2160, 30 * GB);
    const unknown = candidate("c", 2160);
    expect(orderForStreaming([heaviest, heavy, unknown], 60).map((c) => c.title)).toEqual(["c", "b", "a"]);
  });

  it("keeps the order when the runtime is unknown", () => {
    const list = [candidate("a", 2160, 60 * GB), candidate("b", 2160, 10 * GB)];
    expect(orderForStreaming(list, null)).toEqual(list);
  });
});

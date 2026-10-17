/// <reference types="bun-types" />
import { describe, expect, it, mock } from "bun:test";

mock.module("@/lib/tmdb", () => ({ tmdb: {} }));
mock.module("./cached-stream", () => ({
  getFreshCachedStream: async () => null,
  invalidateCachedStream: async () => undefined,
  upsertCachedStream: async () => undefined,
}));

const { slotHeight } = await import("./index");

describe("slotHeight", () => {
  it("reads both 720p slots as 720p: the remux one used to be offered as 1080p", () => {
    expect(slotHeight("safari-720")).toBe(720);
    expect(slotHeight("native-720")).toBe(720);
  });

  it("keeps the 1080p and 4K slots where they were", () => {
    expect(slotHeight("native-1080-1")).toBe(1080);
    expect(slotHeight("safari-1080-3")).toBe(1080);
    expect(slotHeight("safari-2160")).toBe(2160);
    expect(slotHeight("native-2160-2")).toBe(2160);
  });
});

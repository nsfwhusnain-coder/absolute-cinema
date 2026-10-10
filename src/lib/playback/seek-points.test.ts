/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { seekPointAfter, seekPointAtOrBefore, snapSeek } from "./seek-points";

const points = [0, 10.4, 20.8, 31.2];

describe("seekPointAtOrBefore", () => {
  it("finds the point a time falls after", () => {
    expect(seekPointAtOrBefore(points, 0)).toBe(0);
    expect(seekPointAtOrBefore(points, 10.39)).toBe(0);
    expect(seekPointAtOrBefore(points, 10.4)).toBe(10.4);
    expect(seekPointAtOrBefore(points, 999)).toBe(31.2);
  });

  it("clamps a time before every point, and leaves it alone when there are none", () => {
    expect(seekPointAtOrBefore([5, 9], 2)).toBe(5);
    expect(seekPointAtOrBefore([], 42)).toBe(42);
  });
});

describe("seekPointAfter", () => {
  it("finds the next point, or none past the last", () => {
    expect(seekPointAfter(points, 0)).toBe(10.4);
    expect(seekPointAfter(points, 10.4)).toBe(20.8);
    expect(seekPointAfter(points, 31.2)).toBeNull();
  });
});

describe("snapSeek", () => {
  it("lands on the point before the target", () => {
    expect(snapSeek(points, 3, 25)).toBe(20.8);
    expect(snapSeek(points, 30, 12)).toBe(10.4);
  });

  it("moves forward when the point before the target is not ahead of the playhead", () => {
    // Playing at 11 and skipping to 13: the point before 13 is 10.4, behind the playhead.
    expect(snapSeek(points, 11, 13)).toBe(20.8);
  });

  it("stays at the last point when nothing follows it", () => {
    expect(snapSeek(points, 32, 35)).toBe(31.2);
  });

  it("goes back to the start of the interval on a jump backwards within it", () => {
    expect(snapSeek(points, 19, 12)).toBe(10.4);
  });
});

import { describe, expect, it } from "bun:test";
import { ClaimSet, ExpiringMap } from "./expiring-map";

describe("ExpiringMap", () => {
  it("keeps a value for its time to live, and no longer", () => {
    const map = new ExpiringMap<string>(1000, 10);
    map.set("a", "x", 0);
    expect(map.get("a", 999)).toBe("x");
    expect(map.get("a", 1000)).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("when full, drops the expired entries first, and then the oldest live one", () => {
    const map = new ExpiringMap<number>(1000, 3);
    map.set("old", 1, 0);
    map.set("mid", 2, 500);
    map.set("new", 3, 600);
    // "old" has expired by 1100: making room for a fourth drops it and nothing else.
    map.set("fourth", 4, 1100);
    expect(map.get("old", 1100)).toBeUndefined();
    expect([map.get("mid", 1100), map.get("new", 1100), map.get("fourth", 1100)]).toEqual([2, 3, 4]);
    // Nothing has expired by 1200: the oldest live entry ("mid") is the one that goes.
    map.set("fifth", 5, 1200);
    expect(map.get("mid", 1200)).toBeUndefined();
    expect([map.get("new", 1200), map.get("fourth", 1200), map.get("fifth", 1200)]).toEqual([3, 4, 5]);
    expect(map.size).toBe(3);
  });

  it("holds a key again as the newest entry when it is set again", () => {
    const map = new ExpiringMap<string>(10_000, 2);
    map.set("a", "1", 0);
    map.set("b", "2", 1);
    map.set("a", "3", 2);
    // "b" is now the oldest, so it is the one a third key pushes out.
    map.set("c", "4", 3);
    expect(map.get("b", 3)).toBeUndefined();
    expect([map.get("a", 3), map.get("c", 3)]).toEqual(["3", "4"]);
  });

  it("never holds more than its cap", () => {
    const map = new ExpiringMap<number>(10_000, 50);
    for (let i = 0; i < 500; i++) map.set(`k${i}`, i, i);
    expect(map.size).toBeLessThanOrEqual(50);
    expect(map.get("k499", 499)).toBe(499);
    expect(map.get("k0", 499)).toBeUndefined();
  });
});

describe("ClaimSet", () => {
  it("lets a key through once per window", () => {
    const claims = new ClaimSet(10 * 60_000, 100);
    expect(claims.claim("tv:1399:1:1", 0)).toBe(true);
    expect(claims.claim("tv:1399:1:1", 5 * 60_000)).toBe(false);
    expect(claims.claim("tv:1399:1:2", 5 * 60_000)).toBe(true);
    expect(claims.claim("tv:1399:1:1", 10 * 60_000)).toBe(true);
  });

  it("does not restart the window with a refused claim", () => {
    const claims = new ClaimSet(1000, 10);
    expect(claims.claim("k", 0)).toBe(true);
    expect(claims.claim("k", 900)).toBe(false);
    // The refused claim at 900 did not extend the first one, which ends at 1000.
    expect(claims.claim("k", 1000)).toBe(true);
  });
});

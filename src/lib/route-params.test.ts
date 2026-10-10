/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { parseRouteId, parseRouteIndex } from "./route-params";

describe("parseRouteId", () => {
  it("accepts plain positive ids", () => {
    expect(parseRouteId("603")).toBe(603);
    expect(parseRouteId("1")).toBe(1);
  });
  it("refuses anything Number() would bend into an id", () => {
    for (const raw of ["603.", " 603", "603 ", "6e2", "0x10", "-5", "1.5", "abc", "", "0", undefined, "1234567890"]) {
      expect(parseRouteId(raw)).toBeNull();
    }
  });
});

describe("parseRouteIndex", () => {
  it("accepts 0 for Specials and ordinary numbers", () => {
    expect(parseRouteIndex("0")).toBe(0);
    expect(parseRouteIndex("12")).toBe(12);
  });
  it("refuses junk", () => {
    for (const raw of ["abc", "-1", "1.5", "", undefined, "99999"]) expect(parseRouteIndex(raw)).toBeNull();
  });
});

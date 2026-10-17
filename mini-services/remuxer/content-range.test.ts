import { describe, expect, it } from "bun:test";
import { totalSizeFromContentRange } from "./content-range";

describe("totalSizeFromContentRange", () => {
  it("reads the whole size", () => {
    expect(totalSizeFromContentRange("bytes 0-0/62910411606")).toBe(62910411606);
    expect(totalSizeFromContentRange("bytes */1024")).toBe(1024);
  });

  it("is null when the size is unknown or the header is not one", () => {
    expect(totalSizeFromContentRange("bytes 0-0/*")).toBeNull();
    expect(totalSizeFromContentRange("")).toBeNull();
    expect(totalSizeFromContentRange(null)).toBeNull();
    expect(totalSizeFromContentRange("bytes 0-0/0")).toBeNull();
    expect(totalSizeFromContentRange("items 0-0/5")).toBeNull();
  });
});

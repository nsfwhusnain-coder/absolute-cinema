import { describe, expect, test } from "bun:test";
import { safeCallbackPath } from "./login";

describe("safeCallbackPath", () => {
  test("defaults empty or missing values to home", () => {
    expect(safeCallbackPath(undefined)).toBe("/");
    expect(safeCallbackPath(null)).toBe("/");
    expect(safeCallbackPath("")).toBe("/");
    expect(safeCallbackPath("   ")).toBe("/");
  });

  test("accepts same-origin relative paths", () => {
    expect(safeCallbackPath("/movie/550")).toBe("/movie/550");
    expect(safeCallbackPath("/watch/tv/1396?season=2&episode=4")).toBe(
      "/watch/tv/1396?season=2&episode=4"
    );
  });

  test("keeps watch resume query strings", () => {
    expect(safeCallbackPath("/watch/tv/1396?season=0&episode=1")).toBe(
      "/watch/tv/1396?season=0&episode=1"
    );
  });

  test("rejects open redirects and login loops", () => {
    expect(safeCallbackPath("//evil.example")).toBe("/");
    expect(safeCallbackPath("/\\evil")).toBe("/");
    expect(safeCallbackPath("https://evil.example")).toBe("/");
    expect(safeCallbackPath("javascript:alert(1)")).toBe("/");
    expect(safeCallbackPath("/login")).toBe("/");
    expect(safeCallbackPath("/login?next=/")).toBe("/");
    expect(safeCallbackPath("/login/extra")).toBe("/");
  });
});

describe("safeCallbackPath keeps encoded queries intact", () => {
  test("does not decode the already-decoded value a second time", () => {
    expect(safeCallbackPath("/search?q=Fast%20%26%20Furious")).toBe("/search?q=Fast%20%26%20Furious");
    expect(safeCallbackPath("/search?q=c%2B%2B")).toBe("/search?q=c%2B%2B");
  });

  test("still refuses encoded open redirects", () => {
    expect(safeCallbackPath("%2F%2Fevil.example")).toBe("/");
    expect(safeCallbackPath("/%2Fevil.example")).toBe("/");
    expect(safeCallbackPath("/%5Cevil")).toBe("/");
  });
});

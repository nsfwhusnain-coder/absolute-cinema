/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { plainClientHeaders, wantsPlainClient } from "./cdn-request-policy";

describe("wantsPlainClient", () => {
  it("matches the MovieBox CDN and its subdomains", () => {
    expect(wantsPlainClient("https://bcdn.hakunaymatata.com/resource/h265/a.mp4?sign=1")).toBe(true);
    expect(wantsPlainClient("https://sacdn.hakunaymatata.com/bt/a.mp4")).toBe(true);
    expect(wantsPlainClient("https://hakunaymatata.com/a.mp4")).toBe(true);
  });

  it("leaves every other host, lookalikes included, on browser headers", () => {
    expect(wantsPlainClient("https://storm.vodvidl.site/a.m3u8")).toBe(false);
    expect(wantsPlainClient("https://nothakunaymatata.com/a.mp4")).toBe(false);
    expect(wantsPlainClient("https://hakunaymatata.com.example.org/a.mp4")).toBe(false);
    expect(wantsPlainClient("not a url")).toBe(false);
  });
});

describe("plainClientHeaders", () => {
  it("sends no Referer, Origin or cookies, and no browser User-Agent", () => {
    const headers = plainClientHeaders();
    expect(Object.keys(headers).sort()).toEqual(["Accept", "User-Agent"]);
    expect(headers["User-Agent"]).not.toContain("Mozilla");
  });

  it("carries the requested byte range", () => {
    expect(plainClientHeaders("bytes=0-99").Range).toBe("bytes=0-99");
    expect(plainClientHeaders(null).Range).toBeUndefined();
  });
});

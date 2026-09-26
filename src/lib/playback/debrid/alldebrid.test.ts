/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isAllDebridConfigured, pickAllDebridFile, resolveAllDebridFirstCached } from "./alldebrid";

/**
 * AllDebrid client coverage. The real API is never hit: `globalThis.fetch` is
 * replaced with a router keyed by path, so upload (the cache check), files,
 * unlock and the cleanup deletes run end-to-end without a live key.
 */

const FAKE_KEY = "test-alldebrid-key";
const CACHED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNCACHED = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MB = 1024 * 1024;

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: "success", data }), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("alldebrid — no key configured", () => {
  const original = process.env.ALLDEBRID_API_KEY;
  beforeEach(() => {
    delete process.env.ALLDEBRID_API_KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ALLDEBRID_API_KEY;
    else process.env.ALLDEBRID_API_KEY = original;
  });

  it("is dormant and makes no request", async () => {
    expect(isAllDebridConfigured()).toBe(false);
    const result = await resolveAllDebridFirstCached(
      [{ infoHash: CACHED, releaseTitle: "Film 2160p" }],
      Date.now() + 5_000
    );
    expect(result).toBeNull();
  });
});

describe("pickAllDebridFile", () => {
  const pack = [
    { name: "Show S02/Show.S02E01.1080p.WEB.mkv", bytes: 900 * MB, link: "l1" },
    { name: "Show S02/Show.S02E02.1080p.WEB.mkv", bytes: 800 * MB, link: "l2" },
    { name: "Show S02/Sample/sample.mkv", bytes: 20 * MB, link: "l3" },
    { name: "Show S02/info.nfo", bytes: 1_000, link: "l4" },
  ];

  it("takes the requested episode from a season pack, never the largest file", () => {
    const file = pickAllDebridFile(pack, { infoHash: CACHED, releaseTitle: "Show S02 1080p WEB" }, {
      season: 2,
      episode: 2,
    });
    expect(file?.link).toBe("l2");
  });

  it("returns null for a pack without the requested episode", () => {
    const file = pickAllDebridFile(pack, { infoHash: CACHED, releaseTitle: "Show S02 1080p WEB" }, {
      season: 3,
      episode: 1,
    });
    expect(file).toBeNull();
  });

  it("takes the single feature of a movie torrent", () => {
    const file = pickAllDebridFile(
      [
        { name: "Film.2019.2160p/Film.2019.2160p.mkv", bytes: 20_000 * MB, link: "m1" },
        { name: "Film.2019.2160p/Film.nfo", bytes: 2_000, link: "m2" },
      ],
      { infoHash: CACHED, releaseTitle: "Film 2019 2160p" }
    );
    expect(file?.link).toBe("m1");
  });
});

describe("alldebrid — resolve with fetch mocked", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ALLDEBRID_API_KEY;
  let deleted: string[] = [];

  beforeEach(() => {
    process.env.ALLDEBRID_API_KEY = FAKE_KEY;
    deleted = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (url.includes("/magnet/upload")) {
        return envelope({
          magnets: [
            { hash: UNCACHED, id: 1, ready: false },
            { hash: CACHED, id: 2, ready: true },
          ],
        });
      }
      if (url.includes("/magnet/files")) {
        return envelope({
          magnets: [
            {
              id: body.get("id[]"),
              files: [{ n: "Film.2019.2160p.WEB.H265.mkv", s: 9_000 * MB, l: "https://alldebrid.com/f/x" }],
            },
          ],
        });
      }
      if (url.includes("/link/unlock")) {
        return envelope({ link: "https://cdn.example.debrid.it/dl/abc/Film.2019.2160p.WEB.H265.mkv" });
      }
      if (url.includes("/magnet/delete")) {
        deleted.push(body.get("id") ?? "");
        return envelope({ message: "ok" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ALLDEBRID_API_KEY;
    else process.env.ALLDEBRID_API_KEY = originalKey;
  });

  it("skips the uncached upload, resolves the cached one and deletes only the loser", async () => {
    const result = await resolveAllDebridFirstCached(
      [
        { infoHash: UNCACHED, releaseTitle: "Film 2019 2160p REMUX" },
        { infoHash: CACHED, releaseTitle: "Film 2019 2160p WEB H265" },
      ],
      Date.now() + 5_000
    );
    expect(result?.target.infoHash).toBe(CACHED);
    expect(result?.file.url).toContain("debrid.it");
    expect(result?.file.codec).toBe("hevc");
    expect(deleted).toEqual(["1"]);
  });

  it("returns null and deletes everything when nothing is cached", async () => {
    const result = await resolveAllDebridFirstCached(
      [{ infoHash: UNCACHED, releaseTitle: "Film 2019 2160p" }],
      Date.now() + 5_000
    );
    expect(result).toBeNull();
    expect(deleted.sort()).toEqual(["1", "2"]);
  });
});

import { describe, expect, it } from "bun:test";
import { SegmentReadAhead, type ReadAheadBody } from "./hls-readahead";

const VOD = ["#EXTM3U", "#EXTINF:6,", "s0.ts", "#EXTINF:6,", "s1.ts", "#EXTINF:6,", "s2.ts", "#EXTINF:6,", "s3.ts", "#EXTINF:6,", "s4.ts", "#EXT-X-ENDLIST"].join("\n");
const session = { id: "sess" };
const resolve = (uri: string) => `https://cdn/${uri}`;
const body = (n: number): ReadAheadBody => ({ status: 200, contentType: "video/mp2t", headers: {}, bytes: new Uint8Array(n) });

function setup() {
  const fetched: string[] = [];
  const ra = new SegmentReadAhead<typeof session>(async (_s, url) => {
    fetched.push(url);
    return body(10);
  });
  return { ra, fetched };
}

describe("SegmentReadAhead", () => {
  it("fetches the next segments, never the requested one", async () => {
    const { ra, fetched } = setup();
    ra.recordPlaylist("sess", "https://cdn/p.m3u8", VOD, resolve);
    ra.schedule(session, "https://cdn/s0.ts");
    await Promise.resolve();
    expect(fetched).toEqual(["https://cdn/s1.ts", "https://cdn/s2.ts", "https://cdn/s3.ts"]);
    expect(ra.take("sess", "https://cdn/s0.ts")).toBeNull();
    expect((await ra.take("sess", "https://cdn/s1.ts"))?.bytes.byteLength).toBe(10);
    expect(ra.take("sess", "https://cdn/s1.ts")).toBeNull();
  });

  it("does not refetch what is already queued, and stops at the end", async () => {
    const { ra, fetched } = setup();
    ra.recordPlaylist("sess", "https://cdn/p.m3u8", VOD, resolve);
    ra.schedule(session, "https://cdn/s2.ts");
    ra.schedule(session, "https://cdn/s2.ts");
    expect(fetched).toEqual(["https://cdn/s3.ts", "https://cdn/s4.ts"]);
  });

  it("ignores live and byte-range playlists", () => {
    const { ra, fetched } = setup();
    ra.recordPlaylist("sess", "https://cdn/live.m3u8", VOD.replace("#EXT-X-ENDLIST", ""), resolve);
    ra.recordPlaylist("sess", "https://cdn/br.m3u8", VOD.replace("#EXTM3U", "#EXTM3U\n#EXT-X-BYTERANGE:100@0"), resolve);
    ra.schedule(session, "https://cdn/s0.ts");
    expect(fetched).toEqual([]);
  });

  it("keeps sessions apart", () => {
    const { ra, fetched } = setup();
    ra.recordPlaylist("sess", "https://cdn/p.m3u8", VOD, resolve);
    ra.schedule({ id: "other" }, "https://cdn/s0.ts");
    expect(fetched).toEqual([]);
  });
});

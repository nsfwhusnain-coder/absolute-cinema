import { describe, expect, it } from "bun:test";
import { remuxSessionIdOf } from "./remux-leave";

const ID = "0123456789abcdef01234567";

describe("remuxSessionIdOf", () => {
  it("reads the session from a remux playlist, sliced or whole, relative or absolute", () => {
    expect(remuxSessionIdOf(`/api/vod/${ID}/slices.m3u8`)).toBe(ID);
    expect(remuxSessionIdOf(`/api/vod/${ID}/index.m3u8`)).toBe(ID);
    expect(remuxSessionIdOf(`https://cinema.example/api/vod/${ID}/index.m3u8?x=1`)).toBe(ID);
  });

  it("is null for anything that is not a remux session", () => {
    expect(remuxSessionIdOf("/api/hls/abc?u=xyz")).toBeNull();
    expect(remuxSessionIdOf("https://cdn.example/film.mp4")).toBeNull();
    expect(remuxSessionIdOf("/api/vod/open?type=movie")).toBeNull();
    expect(remuxSessionIdOf(`/api/vod/${ID.slice(1)}/index.m3u8`)).toBeNull();
    expect(remuxSessionIdOf("not a url")).toBeNull();
  });
});

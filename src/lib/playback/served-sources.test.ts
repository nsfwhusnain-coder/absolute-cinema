import { describe, expect, it } from "bun:test";
import { capsRuleOutFourK, isPublicInstance, playbackCaps } from "@/lib/public-instance";
import { isDebridSource, offeredSources, sealedDebridUrl, servedAnswer, withinCaps } from "./served-sources";
import { sourceDelivery } from "./source-quality";
import type { PlaybackSource } from "./types";

const RD = "https://abc4.download.real-debrid.com/d/SECRETLINK123/Dune.2021.1080p.WEB-DL.mkv";

function debrid(id: string, url: string, extra: Partial<PlaybackSource> = {}): PlaybackSource {
  return { id, url, provider: "Real-Debrid", quality: "1080p", label: "1080p", type: "mp4", maxHeight: 1080, origin: "debrid", ...extra };
}

function web(id: string, extra: Partial<PlaybackSource> = {}): PlaybackSource {
  return { id, url: `/api/hls/s1?u=${id}`, provider: "Web", quality: "1080p", label: "1080p", type: "hls", maxHeight: 1080, origin: "embed", ...extra };
}

const PUBLIC = { PUBLIC_INSTANCE: "1", PLAYBACK_MAX_HEIGHT: "1080", PLAYBACK_MAX_MBPS: "10" };
const HOME = {};

describe("the public instance switch and the caps", () => {
  it("reads on and off however they are written, and nothing else", () => {
    expect(isPublicInstance({ PUBLIC_INSTANCE: "1" })).toBe(true);
    expect(isPublicInstance({ PUBLIC_INSTANCE: " On " })).toBe(true);
    expect(isPublicInstance({ PUBLIC_INSTANCE: "0" })).toBe(false);
    expect(isPublicInstance({ PUBLIC_INSTANCE: "yes please" })).toBe(false);
    expect(isPublicInstance(HOME)).toBe(false);
  });

  it("takes caps only inside sane bounds", () => {
    expect(playbackCaps(PUBLIC)).toEqual({ maxHeight: 1080, maxBitrateBps: 10_000_000 });
    expect(playbackCaps({ PLAYBACK_MAX_HEIGHT: "99999", PLAYBACK_MAX_MBPS: "0" })).toEqual({ maxHeight: null, maxBitrateBps: null });
    expect(playbackCaps({ PLAYBACK_MAX_HEIGHT: "", PLAYBACK_MAX_MBPS: "fast" })).toEqual({ maxHeight: null, maxBitrateBps: null });
    expect(capsRuleOutFourK(playbackCaps(PUBLIC))).toBe(true);
    expect(capsRuleOutFourK(playbackCaps(HOME))).toBe(false);
  });
});

describe("what a server offers", () => {
  const caps = playbackCaps(PUBLIC);

  it("holds a file to the caps whole, and a ladder by its lowest rung", () => {
    expect(withinCaps(debrid("a", RD, { quality: "2160p", maxHeight: 2160 }), caps)).toBe(false);
    expect(withinCaps(debrid("b", RD, { fileBitrateBps: 24_000_000 }), caps)).toBe(false);
    expect(withinCaps(debrid("c", RD, { fileBitrateBps: 7_000_000 }), caps)).toBe(true);
    // No size known: not held against it (the capacity gate weighs it once the file is open).
    expect(withinCaps(debrid("d", RD), caps)).toBe(true);
    expect(withinCaps(web("e", { maxHeight: 2160, ladder: [2160, 1080, 720], bitrateBps: 16_000_000 }), caps)).toBe(true);
    expect(withinCaps(web("f", { maxHeight: 2160, ladder: [2160], bitrateBps: 16_000_000 }), caps)).toBe(false);
  });

  it("offers a public instance's browsers no debrid file they would read themselves", () => {
    const sources = [
      debrid("mkv", RD),
      debrid("mp4", RD.replace(".mkv", ".mp4")),
      debrid("unknown", "https://abc4.download.real-debrid.com/d/OTHERLINK/stream"),
      debrid("tagged", "https://abc4.download.real-debrid.com/d/TAGGED/stream", { container: "mkv" }),
      debrid("4k", RD, { quality: "2160p", maxHeight: 2160 }),
      web("web"),
    ];
    expect(offeredSources(sources, PUBLIC).map((s) => s.id)).toEqual(["mkv", "tagged", "web"]);
  });

  it("holds a household server with caps to them, and nothing more", () => {
    const capped = { PLAYBACK_MAX_HEIGHT: "1080" };
    const sources = [debrid("mp4", RD.replace(".mkv", ".mp4"), { codec: "h264" }), debrid("4k", RD, { maxHeight: 2160 })];
    expect(offeredSources(sources, capped).map((s) => s.id)).toEqual(["mp4"]);
    const served = servedAnswer({ sources, streamUrl: RD, fourKSettled: false as boolean }, capped);
    expect(served.sources).toBe(sources);
    expect(served.fourKSettled).toBe(true);
  });

  it("changes nothing for a household server", () => {
    const sources = [debrid("mp4", RD.replace(".mkv", ".mp4")), debrid("4k", RD, { maxHeight: 2160 })];
    expect(offeredSources(sources, HOME)).toBe(sources);
  });
});

describe("knowing a debrid file", () => {
  it("by its origin, its id or its link, any one of them", () => {
    expect(isDebridSource({ id: "x", url: "/api/hls/s?u=1", origin: "debrid" })).toBe(true);
    expect(isDebridSource({ id: "alldebrid-tt0137523-movie-0-0-1080p", url: "https://cdn.example/x.mkv" })).toBe(true);
    expect(isDebridSource({ id: "x", url: "https://w1.debrid.it/dl/abc/x.mkv" })).toBe(true);
    expect(isDebridSource({ id: "x", url: "https://evil-real-debrid.com.example/x.mkv" })).toBe(false);
    expect(isDebridSource({ id: "vidlink-1080", url: "https://cdn.example/master.m3u8", origin: "embed" })).toBe(false);
  });

  it("seals one that lost its origin tag on the way", () => {
    const untagged = { ...debrid("debrid-tt1160419-movie-0-0-native-1080", RD), origin: undefined };
    const served = servedAnswer({ sources: [untagged], streamUrl: RD }, PUBLIC);
    expect(JSON.stringify(served)).not.toContain("SECRETLINK123");
  });
});

describe("the answer a public instance's browser gets", () => {
  it("keeps the file's name and loses the link", () => {
    const sealed = sealedDebridUrl({ id: "rd:tt1160419:abc", url: RD });
    expect(sealed).toBe("https://debrid.invalid/rd%3Att1160419%3Aabc/Dune.2021.1080p.WEB-DL.mkv");
    expect(sealed).not.toContain("SECRETLINK123");
    expect(sealedDebridUrl({ id: "x", url: "not a url" })).toBe("https://debrid.invalid/x/file");
  });

  it("seals every debrid link, the best start's too, and nothing else", () => {
    const answer = { sources: [debrid("rd1", RD), web("web")], streamUrl: RD, fourKSettled: false };
    const served = servedAnswer(answer, PUBLIC);
    expect(JSON.stringify(served)).not.toContain("real-debrid.com");
    expect(served.streamUrl).toBe(served.sources![0]!.url);
    expect(served.sources![1]!.url).toBe("/api/hls/s1?u=web");
    expect(served.fourKSettled).toBe(true);
  });

  it("still plays a sealed file through the remuxer, as its link would have", () => {
    const source = debrid("rd1", RD, { codec: "h264", audioCodec: "aac" });
    const sealed = servedAnswer({ sources: [source] }, PUBLIC).sources![0]!;
    expect(sourceDelivery(source)).toBe("remux");
    expect(sourceDelivery(sealed)).toBe("remux");
  });

  it("passes on no link to anything it does not offer", () => {
    const served = servedAnswer({ sources: [web("web")], streamUrl: "https://elsewhere.example/x.mp4" }, PUBLIC);
    expect(served.streamUrl).toBeUndefined();
  });

  it("leaves a household server's answer as it was", () => {
    const answer = { sources: [debrid("rd1", RD)], streamUrl: RD };
    expect(servedAnswer(answer, HOME)).toEqual(answer);
  });
});

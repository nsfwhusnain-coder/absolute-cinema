import { describe, expect, it } from "bun:test";
import { preferSharpVariants } from "./master-order";

const lines = (...l: string[]) => [...l, ""].join("\n");

describe("preferSharpVariants", () => {
  it("leaves out the renditions under 1080p and lists 1080p first", () => {
    const master = lines(
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480",
      "480/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
      "720/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080",
      "1080/index.m3u8"
    );
    expect(preferSharpVariants(master)).toBe(lines("#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080", "1080/index.m3u8"));
  });

  it("opens on 1080p and keeps 4K after it, with the other tags ahead of the renditions", () => {
    const master = lines(
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="audio/en.m3u8"',
      "#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,AUDIO=\"a\"",
      "480.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,AUDIO=\"a\"",
      "2160.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO=\"a\"",
      "1080.m3u8",
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=200000,URI="iframe.m3u8"'
    );
    const out = preferSharpVariants(master).split("\n");
    expect(out.filter((l) => !l.startsWith("#") && l)).toEqual(["1080.m3u8", "2160.m3u8"]);
    expect(out.indexOf('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="audio/en.m3u8"')).toBe(1);
    expect(out).toContain('#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=200000,URI="iframe.m3u8"');
    expect(out.at(-1)).toBe("");
  });

  it("keeps every rendition, tallest first, when none reaches 1080p", () => {
    const master = lines("#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360", "360.m3u8", "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720", "720.m3u8");
    expect(preferSharpVariants(master).split("\n").filter((l) => l && !l.startsWith("#"))).toEqual(["720.m3u8", "360.m3u8"]);
  });

  it("keeps renditions that do not say their size, last", () => {
    const master = lines("#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=3000000", "unknown.m3u8", "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080", "1080.m3u8");
    expect(preferSharpVariants(master).split("\n").filter((l) => l && !l.startsWith("#"))).toEqual(["1080.m3u8", "unknown.m3u8"]);
  });

  it("returns what it does not understand as it came", () => {
    const tagBeforeUri = lines("#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=854x480", "#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080", "1080.m3u8");
    expect(preferSharpVariants(tagBeforeUri)).toBe(tagBeforeUri);
    const single = lines("#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=854x480", "480.m3u8");
    expect(preferSharpVariants(single)).toBe(single);
    const media = lines("#EXTM3U", "#EXTINF:6,", "seg.ts");
    expect(preferSharpVariants(media)).toBe(media);
  });

  it("keeps Windows line endings", () => {
    const master = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=854x480", "480.m3u8", "#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080", "1080.m3u8", ""].join("\r\n");
    expect(preferSharpVariants(master)).toBe(["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080", "1080.m3u8", ""].join("\r\n"));
  });
});

/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { ProviderOutageError } from "./provider-outage";
import { parseAudioLanguage, resolveVixsrc } from "./vixsrc";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveVixsrc outages vs title miss", () => {
  it("returns [] on 200 without src (title miss, not an outage)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(resolveVixsrc(550, "movie")).resolves.toEqual([]);
  });

  it("throws on HTTP 502", async () => {
    globalThis.fetch = (async () =>
      new Response("down", { status: 502 })) as unknown as typeof fetch;
    await expect(resolveVixsrc(550, "movie")).rejects.toBeInstanceOf(
      ProviderOutageError
    );
  });
});

const MASTER = (audio: string[]) =>
  [
    "#EXTM3U",
    ...audio,
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Italian [Forced]",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="ita-forced",URI="x"',
    '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="subs"',
    "https://vixsrc.to/playlist/1",
  ].join("\n");

describe("parseAudioLanguage", () => {
  it("counts a master that offers English as English, even though Italian is the default", () => {
    const content = MASTER([
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Italian",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="ita",URI="a"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,LANGUAGE="eng",URI="b"',
    ]);
    expect(parseAudioLanguage(content)).toBe("en");
  });

  it("labels an Italian-only master as Italian so it is not mistaken for an unlabelled source", () => {
    const content = MASTER(['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Italian",DEFAULT=YES,LANGUAGE="ita",URI="a"']);
    expect(parseAudioLanguage(content)).toBe("ita");
  });

  it("ignores subtitle tracks when reading audio languages", () => {
    const content = MASTER(['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Spanish",DEFAULT=YES,LANGUAGE="spa",URI="a"']);
    expect(parseAudioLanguage(content)).toBe("spa");
  });

  it("returns undefined when the playlist names no audio track", () => {
    expect(parseAudioLanguage("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nx")).toBeUndefined();
  });
});

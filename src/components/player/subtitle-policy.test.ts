/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import type { SubtitleOption } from "./store";
import { betterThanExternal, hasFullEnglish, subtitlesRequired } from "./subtitle-policy";

const option = (id: string, origin: SubtitleOption["origin"], language: string, partial = false): SubtitleOption => ({
  id,
  label: id,
  language,
  origin,
  partial,
});

describe("subtitlesRequired", () => {
  it("requires subtitles for anime in Japanese, including unknown audio", () => {
    expect(subtitlesRequired("ja", "jpn")).toBe(true);
    expect(subtitlesRequired("ja", null)).toBe(true);
  });

  it("does not require them for English titles or an English dub", () => {
    expect(subtitlesRequired("en", null)).toBe(false);
    expect(subtitlesRequired("ja", "eng")).toBe(false);
    expect(subtitlesRequired(null, "jpn")).toBe(false);
  });
});

describe("hasFullEnglish", () => {
  it("ignores signs-and-songs tracks", () => {
    expect(hasFullEnglish([option("a", "stream", "eng", true)])).toBe(false);
    expect(hasFullEnglish([option("a", "stream", "eng", true), option("b", "external", "en")])).toBe(true);
  });
});

describe("betterThanExternal", () => {
  it("prefers the release's own English track over a downloaded one", () => {
    const options = [option("ext", "external", "eng"), option("stream:0", "stream", "eng")];
    expect(betterThanExternal(options, "ext")?.id).toBe("stream:0");
  });

  it("leaves in-file choices and partial tracks alone", () => {
    const options = [option("ext", "external", "eng"), option("stream:0", "stream", "eng", true), option("stream:1", "stream", "jpn")];
    expect(betterThanExternal(options, "ext")).toBeUndefined();
    expect(betterThanExternal(options, "stream:1")).toBeUndefined();
  });
});

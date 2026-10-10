import { describe, expect, test } from "bun:test";
import {
  normalizeTrackLanguage,
  selectAudioTrack,
  selectSubtitleTrack,
} from "./track-selection";

describe("track selection", () => {
  test("normalizes common ISO-639 aliases", () => {
    expect(normalizeTrackLanguage("eng")).toBe("en");
    expect(normalizeTrackLanguage("JPN")).toBe("ja");
    expect(normalizeTrackLanguage("pt-BR")).toBe("pt");
  });

  test("prefers original audio and avoids commentary", () => {
    const tracks = [
      { id: 0, lang: "eng", name: "English Director Commentary", default: true },
      { id: 1, lang: "eng", name: "English" },
      { id: 2, lang: "jpn", name: "Japanese Original" },
    ];
    expect(
      selectAudioTrack(tracks, {
        preference: "original",
        originalLanguage: "ja",
        preferredLanguage: "en",
      })?.id
    ).toBe(2);
  });

  test("falls back from missing original audio to English", () => {
    const tracks = [
      { id: 0, lang: "es", name: "Spanish" },
      { id: 1, lang: "en", name: "English" },
    ];
    expect(
      selectAudioTrack(tracks, {
        preference: "original",
        originalLanguage: "ko",
        preferredLanguage: "en",
      })?.id
    ).toBe(1);
  });

  test("overrides a provider's default dub: Vixsrc flags Italian as DEFAULT and English as optional", () => {
    const tracks = [
      { id: 0, lang: "ita", name: "Italian", default: true },
      { id: 1, lang: "eng", name: "English", default: false },
    ];
    expect(selectAudioTrack(tracks, { preference: "original", originalLanguage: "en", preferredLanguage: "en" })?.id).toBe(1);
    expect(selectAudioTrack(tracks, { preference: "original", originalLanguage: null, preferredLanguage: "en" })?.id).toBe(1);
    expect(selectAudioTrack(tracks, { preference: "english", originalLanguage: "ja", preferredLanguage: "en" })?.id).toBe(1);
  });

  test("keeps the original language of a foreign title when the stream carries it", () => {
    const tracks = [
      { id: 0, lang: "ita", name: "Italian", default: true },
      { id: 1, lang: "eng", name: "English" },
      { id: 2, lang: "kor", name: "Korean" },
    ];
    expect(selectAudioTrack(tracks, { preference: "original", originalLanguage: "ko", preferredLanguage: "en" })?.id).toBe(2);
  });

  test("falls back to the stream default only when neither original nor English exists", () => {
    const tracks = [
      { id: 0, lang: "spa", name: "Spanish (Latin American)", default: true },
      { id: 1, lang: "ita", name: "Italian" },
    ];
    expect(selectAudioTrack(tracks, { preference: "original", originalLanguage: "en", preferredLanguage: "en" })?.id).toBe(0);
  });

  test("prefers full English subtitles over SDH and forced", () => {
    const tracks = [
      { id: 0, lang: "en", name: "English Forced", forced: true },
      { id: 1, lang: "eng", name: "English SDH", default: true },
      { id: 2, lang: "en", name: "English Full" },
    ];
    expect(selectSubtitleTrack(tracks, "english")?.id).toBe(2);
    expect(selectSubtitleTrack(tracks, "off")).toBeNull();
  });
});

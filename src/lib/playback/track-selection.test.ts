import { describe, expect, test } from "bun:test";
import {
  lacksWantedAudio,
  normalizeTrackLanguage,
  selectAudioTrack,
  selectSubtitleTrack,
  wantedAudioLanguage,
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

describe("the language a viewer wants to hear", () => {
  test("is the title's own for Original, English for English, and theirs for My language", () => {
    expect(wantedAudioLanguage({ preference: "original", originalLanguage: "ja", preferredLanguage: "fr" })).toBe("ja");
    expect(wantedAudioLanguage({ preference: "english", originalLanguage: "ja", preferredLanguage: "fr" })).toBe("en");
    expect(wantedAudioLanguage({ preference: "preferred", originalLanguage: "ja", preferredLanguage: "fra" })).toBe("fr");
    expect(wantedAudioLanguage({ preference: "original", originalLanguage: null })).toBe("");
  });

  test("a file lacks it only when every track states a language and none is the one", () => {
    const original = { preference: "original" as const, originalLanguage: "en" };
    expect(lacksWantedAudio([{ language: "fre" }], original)).toBe(true);
    expect(lacksWantedAudio([{ language: "rus" }, { language: "ukr" }], original)).toBe(true);
    expect(lacksWantedAudio([{ language: "fre" }, { language: "eng" }], original)).toBe(false);
    expect(lacksWantedAudio([{ language: "eng" }], original)).toBe(false);
  });

  test("a track that states nothing may be the original, so the file is kept", () => {
    const original = { preference: "original" as const, originalLanguage: "en" };
    expect(lacksWantedAudio([{ language: null }], original)).toBe(false);
    expect(lacksWantedAudio([{ language: "und" }, { language: "fre" }], original)).toBe(false);
    expect(lacksWantedAudio([], original)).toBe(false);
    expect(lacksWantedAudio([{ language: "fre" }], { preference: "original", originalLanguage: null })).toBe(false);
  });

  test("an English dub of an anime lacks the original, and has it for a viewer who asked for English", () => {
    expect(lacksWantedAudio([{ language: "eng" }], { preference: "original", originalLanguage: "ja" })).toBe(true);
    expect(lacksWantedAudio([{ language: "eng" }], { preference: "english", originalLanguage: "ja" })).toBe(false);
  });
});

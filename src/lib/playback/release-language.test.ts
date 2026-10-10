/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isUnwantedRelease, looksLikeReleaseName, parseReleaseAudio, releaseAudioCode, releaseAudioKind } from "./release-language";

const kind = (title: string, original?: string) => releaseAudioKind(parseReleaseAudio(title), original);

describe("what a release name says about its audio", () => {
  it("takes a name with no language tag to be the original", () => {
    expect(kind("Lanterns.S01E08.2160p.WEB-DL.DV.HDR.H.265-NTb.mkv")).toBe("unstated");
    expect(kind("Interstellar.2014.1080p.BluRay.x264.DTS-HD.MA.5.1-FGT")).toBe("unstated");
    expect(releaseAudioCode("Interstellar.2014.1080p.BluRay.x264-FGT")).toBe("und");
  });

  it("recognises dubs by the tags releases really use", () => {
    expect(kind("Lanterns.S01E01.MULTi.TRUEFRENCH.1080p.WEB.H264-FW")).toBe("multi");
    expect(kind("Lanterns.S01E01.TRUEFRENCH.1080p.WEB.H264-FW")).toBe("dub");
    expect(kind("Lanterns.S01E02.VFF.1080p.WEB.x264")).toBe("dub");
    expect(kind("Lanterns.S01E01.1080p.rus")).toBe("dub");
    expect(kind("Lanterns_S01-komplet_CZ_dab [1080p]")).toBe("dub");
    expect(kind("Dune.2021.iTA.1080p.BluRay.x264")).toBe("dub");
    expect(kind("Dune.2021.LATINO.1080p.WEB-DL")).toBe("dub");
    expect(kind("Dune.2021.1080p.BluRay.Hindi.Dubbed.x264")).toBe("dub");
    expect(kind("Dune.2021.German.1080p.BluRay.x264")).toBe("dub");
    expect(kind("Dune.2021.1080p.WEB-DL.Dublado")).toBe("dub");
    expect(releaseAudioCode("Lanterns.S01E02.VFF.1080p.WEB.x264")).toBe("fr");
  });

  it("knows a Russian tracker's release by its source, and Cyrillic by sight", () => {
    expect(kind("Lanterns.S01E08.1080p.WEB-DL.RGzsRutracker.mkv")).toBe("dub");
    expect(kind("Lanterns.S01E08.1080p.WEB-DL.LostFilm.mkv")).toBe("dub");
    expect(kind("Фонари S01E08 1080p WEB-DL")).toBe("dub");
  });

  it("takes a long row of flags for the subtitles it is, not for audio", () => {
    const subtitles = "🇬🇧 / 🇯🇵 / 🇮🇹 / 🇵🇹 / 🇪🇸 / 🇫🇷 / 🇩🇪 / 🇳🇱 / 🇵🇱 / 🇨🇿 / 🇭🇺 / 🇧🇬";
    expect(kind(`Lanterns S01E08 Dirt and Stars 2160p AMZN WEB-DL DDP5 1 Atmos DV HDR H 265-FLUX\n👤 748 💾 6.1 GB ⚙️ EXT\n${subtitles}`)).toBe("unstated");
    expect(kind(`Lanterns.S01E08.2160p.HDR10Plus.DV.WEBRip.6CH.x265.HEVC-PSA\n👤 108 💾 898.8 MB\nMulti Subs / ${subtitles}`)).toBe("unstated");
    expect(kind("Lanterns.S01E08.1080p.WEB.h264\n👤 12 💾 2 GB\nMulti Audio / 🇬🇧 / 🇵🇱")).toBe("multi");
  });

  it("reads the language flags an index lists under the name", () => {
    expect(kind("Lanterns.S01E08.1080p.WEB.h264\n👤 12 💾 2 GB\n🇫🇷")).toBe("dub");
    expect(kind("Lanterns.S01E08.1080p.WEB.h264\n👤 12 💾 2 GB\nDual Audio / 🇬🇧 / 🇮🇹")).toBe("multi");
    expect(kind("Lanterns.S01E08.1080p.WEB.h264\n👤 12 💾 2 GB\n🇬🇧")).toBe("original");
  });

  it("calls several languages in one file multi, not a dub", () => {
    expect(kind("Dune.2021.MULTi.1080p.BluRay.x264")).toBe("multi");
    expect(kind("Dune.2021.German.DL.1080p.WEB-DL.x264")).toBe("multi");
    expect(kind("Dune.2021.Dual.Audio.Hindi.English.1080p")).toBe("multi");
    expect(kind("Dune.2021.ITA.ENG.1080p.BluRay")).toBe("multi");
    expect(releaseAudioCode("Dune.2021.ITA.ENG.1080p.BluRay")).toBe("xx");
  });

  it("never reads the title for a language", () => {
    expect(kind("The.French.Dispatch.2021.1080p.BluRay.x264")).toBe("unstated");
    expect(kind("The.Italian.Job.2003.1080p.BluRay.x264")).toBe("unstated");
    expect(kind("The.Russian.Sleep.Experiment.2022.1080p.WEB-DL")).toBe("unstated");
    expect(kind("Hindi.Medium.2017.1080p.BluRay")).toBe("unstated");
  });

  it("reads capital two-letter codes as languages, and several of them as several", () => {
    expect(kind("Guardians Of The Galaxy Vol 3 2023 Bluray 2160p AV1 HDR10 EN/FR/ES AC3 5.1-UH")).toBe("multi");
    expect(kind("Spider-Man: Zbrusu nový den / Spider-Man: Brand New Day (2026)(CZ/EN)[2160p][WEB-DL][DV/HDR]")).toBe("multi");
    expect(kind("Spider-Man Brand New Day [4k 2160p][Esp]")).toBe("dub");
    expect(kind("Mort.en.direct.2021.1080p.WEB.x264")).toBe("unstated");
  });

  it("does not take a language word in an episode's title for a tag", () => {
    expect(kind("Supernatural.S06E15.The.French.Mistake.1080p.BluRay.x264-GRP")).toBe("unstated");
    expect(kind("Seinfeld.S02E11.The.Chinese.Restaurant.1080p.WEB-DL")).toBe("unstated");
    expect(kind("Show.S01E03.FRENCH.1080p.WEB.H264-GRP")).toBe("dub");
    expect(kind("Show.S01E03.iTALiAN.1080p.WEB.H264-GRP")).toBe("dub");
    expect(kind("Show.S01E03.1080p.WEB.French.H264-GRP")).toBe("dub");
    expect(kind("Show.S01E03.Hindi.Dubbed.1080p.WEB")).toBe("dub");
  });

  it("does not mistake WEB-DL for a dual-language release, or subtitle languages for audio", () => {
    expect(kind("Dune.2021.1080p.WEB-DL.DDP5.1.H.264")).toBe("unstated");
    expect(kind("Dune.2021.1080p.BluRay.x264.ENG.SUB.ITA")).toBe("unstated");
    expect(kind("Dune.2021.1080p.WEB-DL.MULTi.SUBS.x264")).toBe("unstated");
    expect(kind("Dune.2021.1080p.BluRay.MSubs.x264")).toBe("unstated");
  });

  it("is the original when the stated language is the title's own", () => {
    expect(kind("Parasite.2019.KOREAN.1080p.BluRay.x264", "ko")).toBe("original");
    expect(kind("Amelie.2001.FRENCH.1080p.BluRay.x264", "fr")).toBe("original");
    expect(kind("Amelie.2001.FRENCH.1080p.BluRay.x264")).toBe("dub");
    expect(kind("Your.Name.2016.1080p.BluRay.English.Dubbed", "ja")).toBe("dub");
    expect(kind("Your.Name.2016.1080p.BluRay.Dual.Audio", "ja")).toBe("multi");
  });
});

describe("releases nobody who wants the original should be given", () => {
  it("rejects dubs and pictures with another language's subtitles over them", () => {
    expect(isUnwantedRelease("Lanterns.S01E02.VFF.1080p.WEB.x264")).toBe(true);
    expect(isUnwantedRelease("Lanterns.2026.S01E08.1080p.HDTV.Subtitulado.Esp.SC.mp4")).toBe(true);
    expect(isUnwantedRelease("Lanterns.S01E08.1080p.HDRip.KORSUB.x264")).toBe(true);
    expect(isUnwantedRelease("Lanterns.S01E08.VOSTFR.1080p.WEB.x264")).toBe(true);
  });

  it("keeps the original, multi-language files and English-subbed anime", () => {
    expect(isUnwantedRelease("Lanterns.S01E08.2160p.WEB-DL.DV.H.265-NTb")).toBe(false);
    expect(isUnwantedRelease("Lanterns.S01E08.MULTi.1080p.WEB.x264")).toBe(false);
    expect(isUnwantedRelease("[Group] Show - 01 [1080p][English Subbed]", "ja")).toBe(false);
    expect(isUnwantedRelease("Parasite.2019.KOREAN.1080p.BluRay.x264", "ko")).toBe(false);
  });
});

describe("looksLikeReleaseName", () => {
  it("tells a release name from a short provider label", () => {
    expect(looksLikeReleaseName("Dune.2021.1080p.BluRay.x264")).toBe(true);
    expect(looksLikeReleaseName("Show.S02E05.WEB.x264")).toBe(true);
    expect(looksLikeReleaseName("Cinema Hindi")).toBe(false);
  });
});

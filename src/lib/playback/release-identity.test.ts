/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { judgeRelease, parseReleaseName, type TitleFacts } from "./release-identity";

const film = (title: string, year: number, ...others: string[]): TitleFacts => ({ titles: [title, ...others], year });

describe("parseReleaseName", () => {
  it("reads the title and the year before the technical part", () => {
    expect(parseReleaseName("Project.Hail.Mary.2026.2160p.UHD.BluRay.x265-GRP")).toEqual({ title: "project hail mary", year: 2026, episodic: false });
    expect(parseReleaseName("Michael (2026) (1080p BluRay x265 10bit EAC3 Atmos 7.1 Celdra) [QxR]").title).toBe("michael");
  });

  it("keeps a year that is part of the title", () => {
    expect(parseReleaseName("Blade.Runner.2049.2017.2160p.BluRay")).toMatchObject({ title: "blade runner 2049", year: 2017 });
    expect(parseReleaseName("2001.A.Space.Odyssey.1968.1080p")).toMatchObject({ title: "2001 a space odyssey", year: 1968 });
    expect(parseReleaseName("1917.2019.1080p.BluRay")).toMatchObject({ title: "1917", year: 2019 });
  });

  it("does not cut a title at a word that is only technical after the year", () => {
    expect(parseReleaseName("Charlottes.Web.2006.1080p.WEB-DL").title).toBe("charlottes web");
    expect(parseReleaseName("Charlottes Web 1080p BluRay").title).toBe("charlottes web");
  });

  it("drops a site or group stamped in front", () => {
    expect(parseReleaseName("www.UIndex.org - Michael 2026 1080p BluRay DDP 5 1 10bit H 265-iVy")).toMatchObject({ title: "michael", year: 2026 });
    expect(parseReleaseName("[SubsPlease] Jujutsu Kaisen - 47 (1080p) [ABCD1234].mkv", "tv").title).toBe("jujutsu kaisen 47");
  });

  it("ends a series title where the seasons start", () => {
    expect(parseReleaseName("Rick and Morty S02 2160p BluRay AI AV1 TrueHD 5.1 [Enrav1sh]", "tv")).toMatchObject({ title: "rick and morty", episodic: true });
    expect(parseReleaseName("Dark.Matter.2024.S01.1080p.x265-ELiTE", "tv")).toMatchObject({ title: "dark matter", year: 2024 });
  });
});

describe("judgeRelease, films", () => {
  it("accepts the film under its own name and year", () => {
    expect(judgeRelease("Dune.2021.2160p.UHD.BluRay.x265", film("Dune", 2021), "movie")).toBe("match");
    expect(judgeRelease("Spider-Man.Brand.New.Day.2026.iTA-ENG.Bluray.2160p", film("Spider-Man: Brand New Day", 2026), "movie")).toBe("match");
    expect(judgeRelease("Léon The Professional 1994 Extended 1080p", film("Léon: The Professional", 1994), "movie")).toBe("match");
  });

  it("allows the year either side of the title's", () => {
    expect(judgeRelease("Parasite.2020.1080p.BluRay", film("Parasite", 2019), "movie")).toBe("match");
  });

  it("rejects a namesake from another year", () => {
    expect(judgeRelease("Michael.1996.1080p.BluRay.x264", film("Michael", 2026), "movie")).toBe("mismatch");
    expect(judgeRelease("The.Lion.King.2019.2160p", film("The Lion King", 1994), "movie")).toBe("mismatch");
  });

  it("rejects a sequel or spin-off that shares the title's first words", () => {
    expect(judgeRelease("Avatar.Fire.And.Ash.2025.2160p.WEB-DL", film("Avatar", 2009), "movie")).toBe("mismatch");
    expect(judgeRelease("Fall 2 Deadpoint 2026 HDR 2160p WEB H265-ETHEL", film("Fall", 2022), "movie")).toBe("mismatch");
    expect(judgeRelease("Dune.Part.Two.2024.2160p", film("Dune", 2021), "movie")).toBe("mismatch");
  });

  it("rejects a series episode filed under a film", () => {
    expect(judgeRelease("Michael.Jackson.The.Verdict.S01E01.1080p.HEVC.x265-MeGusta", film("Michael", 2026), "movie")).toBe("mismatch");
  });

  it("rejects another title that states no year", () => {
    expect(judgeRelease("Michael Jackson Live in Bucharest 1080p BluRay", film("Michael", 2026), "movie")).toBe("mismatch");
  });

  it("knows a film by its other names", () => {
    const amelie = film("Amélie", 2001, "Le Fabuleux Destin d'Amélie Poulain");
    expect(judgeRelease("Le.Fabuleux.Destin.d.Amelie.Poulain.2001.1080p.BluRay", amelie, "movie")).toBe("match");
  });

  it("neither accepts nor rejects the right year under a name not on the list", () => {
    expect(judgeRelease("Marvels.The.Avengers.2012.2160p.UHD.BluRay", film("The Avengers", 2012), "movie")).toBe("unknown");
  });

  it("matches a title that carries a year of its own", () => {
    expect(judgeRelease("Wonder.Woman.1984.2160p.WEB-DL", film("Wonder Woman 1984", 2020), "movie")).toBe("match");
    expect(judgeRelease("Blade.Runner.2049.2017.2160p", film("Blade Runner 2049", 2017), "movie")).toBe("match");
  });

  it("has no opinion on a name with nothing to read", () => {
    expect(judgeRelease("2160p.BluRay.x265-GRP", film("Dune", 2021), "movie")).toBe("unknown");
    expect(judgeRelease("Dune.2021.2160p", { titles: [], year: 2021 }, "movie")).toBe("unknown");
  });
});

describe("judgeRelease, series", () => {
  const show = (title: string, year: number, ...others: string[]): TitleFacts => ({ titles: [title, ...others], year });

  it("accepts season packs and episodes of the show", () => {
    expect(judgeRelease("Rick and Morty S02 2160p BluRay AI AV1 TrueHD 5.1 [Enrav1sh]", show("Rick and Morty", 2013), "tv")).toBe("match");
    expect(judgeRelease("Rick and Morty (2013) Season 2 S02 (1080p BluRay x265 HEVC 10bit AAC 5.1 Garshasp)", show("Rick and Morty", 2013), "tv")).toBe("match");
    expect(judgeRelease("Tires S03E01 1080p WEB H264-CAKES", show("Tires", 2024), "tv")).toBe("match");
  });

  it("reads the original name after a tracker's own", () => {
    expect(judgeRelease("Рик и Морти / Rick and Morty [S01-08] (2013-2025) BDRip 1080p", show("Rick and Morty", 2013), "tv")).toBe("match");
  });

  it("accepts a later season that carries its own year", () => {
    expect(judgeRelease("Doctor.Who.2023.S14E01.1080p", show("Doctor Who", 2005), "tv")).toBe("match");
  });

  it("rejects an older show of the same name", () => {
    expect(judgeRelease("Dark.Matter.2015.S01.1080p.BluRay", show("Dark Matter", 2024), "tv")).toBe("mismatch");
  });

  it("rejects another show that starts with the same words", () => {
    expect(judgeRelease("Percy Jackson Sea of Monsters S01E01 1080p", show("Percy Jackson and the Olympians", 2023), "tv")).toBe("mismatch");
  });

  it("takes an episode number left in an anime release's title", () => {
    expect(judgeRelease("[SubsPlease] Jujutsu Kaisen - 47 (1080p) [ABCD1234].mkv", show("Jujutsu Kaisen", 2020), "tv")).toBe("match");
  });
});

describe("judgeRelease, names seen in a real link cache", () => {
  const facts = (year: number, ...titles: string[]): TitleFacts => ({ titles, year });

  it("rejects another title from the same year", () => {
    expect(judgeRelease("Star.Wars.The.Mandalorian.and.Grogu.2026.iTA-ENG.WEBDL.2160p.HEVC.HDR.x265-CYBER.mkv", facts(2026, "Disclosure Day"), "movie")).toBe("mismatch");
    expect(judgeRelease("Tiësto - Live from Atomium Brussels (2026) [1080p h264]", facts(2026, "Disclosure Day"), "movie")).toBe("mismatch");
    expect(judgeRelease("WorldSBK 2026 - Round 07 - Emilia-RomagnaGP - Full Weekend (1080p50)", facts(2022, "Star Trek: Strange New Worlds"), "tv")).toBe("mismatch");
  });

  it("rejects collections, however they are named", () => {
    for (const name of [
      "Amazing Films 7 - Mp4 x264 AC3 1080p",
      "500 Classic Movies Part 1 of 7 - 67 Movies with IMDB Ratings from 8.0 to 9.0 jZQ 196GB Nb8",
      "Marvel Cinematic Universe Collection 2160p Bluray Remux (2008-2025)",
      "moviesbyrizzo 650 top all-time movies collection 1080p 598GB",
    ]) {
      expect(judgeRelease(name, facts(2010, "Inception", "A Origem"), "movie")).toBe("mismatch");
    }
    expect(judgeRelease("The.Godfather.trilogy.MULTi.FRENCH.2160p.10bit.4KLight", facts(1972, "The Godfather"), "movie")).toBe("mismatch");
    expect(judgeRelease("Dragon Ball Z (Complete Series) [1080p] [MP4] [English Audio]", facts(2022, "House of the Dragon"), "tv")).toBe("mismatch");
  });

  it("does not read the start of a title as a site's name", () => {
    expect(judgeRelease("The.Mentalist.S01.1080p.BluRay.REMUX.VC-1.DD5.1-NOGRP[rartv]", facts(2008, "The Mentalist"), "tv")).toBe("match");
    expect(judgeRelease("Dark.COMPLETE.MULTi.1080p.NF.WEB.DDP.5.1.AV1-BTT", facts(2017, "Dark"), "tv")).toBe("match");
    expect(judgeRelease("Narcos.Mexico.S01.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP", facts(2018, "Narcos: Mexico"), "tv")).toBe("match");
  });

  it("accepts two of the title's names side by side", () => {
    expect(judgeRelease("Money Heist (La Casa De Papel) Complete Season 1 English HD 720p", facts(2017, "Money Heist", "La Casa de Papel"), "tv")).toBe("match");
    expect(judgeRelease("Nunca te sueltes (Never Let Go) (2024) [4k 2160p][Esp]", facts(2024, "Never Let Go", "Nunca te sueltes"), "movie")).toBe("match");
    expect(judgeRelease("A.Origem.(Inception).2010.720p.HD.Dublado.PT-BR", facts(2010, "Inception", "A Origem"), "movie")).toBe("match");
  });

  it("accepts a whole run of a series under the words a run is sold with", () => {
    expect(judgeRelease("Аватар: Легенда об Аанге. Трилогия / Avatar: The Last Airbender. Trilogy [S01-03] (2005-2008) BDRip", facts(2005, "Avatar: The Last Airbender"), "tv")).toBe("match");
    expect(judgeRelease("Breaking Bad - Complete Season + Extras - BluRay 1080p", facts(2008, "Breaking Bad"), "tv")).toBe("match");
    expect(judgeRelease("The Sopranos TV Series 2160p H.264 (moviesbyrizzo conversions)", facts(1999, "The Sopranos"), "tv")).toBe("match");
  });

  it("keeps the right year under a variation of the name, without calling it a match", () => {
    expect(judgeRelease("The Godfather II (1974) 2160p (moviesbyrizzo)", facts(1974, "The Godfather Part II", "Le Parrain 2 (1974)"), "movie")).toBe("unknown");
    expect(judgeRelease("Parasites.2019.2160p.BluRay.REMUX.DV.P7", facts(2019, "Parasite", "Gisaengchung"), "movie")).toBe("unknown");
    expect(judgeRelease("Ted Laso.2020.Complete.1080p.WEBRip.AAC.x265", facts(2020, "Ted Lasso"), "tv")).toBe("unknown");
  });

  it("keeps a name with no year only when it is mostly the title itself", () => {
    const mugenTrain = facts(2020, "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train");
    expect(judgeRelease("[OZR] Demon Slayer the Movie: Mugen Train (BD 1080p HEVC Opus) [Dual-Audio]", mugenTrain, "movie")).toBe("unknown");
    expect(judgeRelease("Michael Jackson Live in Bucharest 1080p BluRay", facts(2026, "Michael"), "movie")).toBe("mismatch");
    expect(judgeRelease("Dune Part Two 2160p WEB-DL", facts(2021, "Dune"), "movie")).toBe("mismatch");
  });

  it("reads a run of seasons however it is counted", () => {
    expect(judgeRelease("True Detective - Seasons 1 and 2 - Mp4 x264 AC3 1080p", facts(2014, "True Detective"), "tv")).toBe("match");
    expect(judgeRelease("South.Park.Uncensored.S01-S21.720p.BluRay.x265-HETeam", facts(1997, "South Park"), "tv")).toBe("match");
    expect(judgeRelease("Chernobyl - Complete Mini Series - Mp4 x264 AC3 1080p", facts(2019, "Chernobyl"), "tv")).toBe("match");
  });

  it("reads a film released with no year at all", () => {
    expect(judgeRelease("300.Rise.of.an.Empire.4k.72fps.DV-HDR.DTS-HD.(WoodrowsPoo69).mkv", facts(2014, "300: Rise of an Empire"), "movie")).toBe("match");
  });
});

/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { countedEpisode, judgeRelease, judgeReleaseName, parseReleaseName, type TitleFacts } from "./release-identity";

const film = (title: string, year: number, ...others: string[]): TitleFacts => ({ titles: [title, ...others], year });

describe("parseReleaseName", () => {
  it("reads the title and the year before the technical part", () => {
    expect(parseReleaseName("Project.Hail.Mary.2026.2160p.UHD.BluRay.x265-GRP")).toEqual({ title: "project hail mary", year: 2026, episodic: false, run: false });
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

describe("judgeRelease, names in other scripts and layouts", () => {
  const facts = (year: number, ...titles: string[]): TitleFacts => ({ titles, year });
  const yourName = facts(2016, "Your Name.", "君の名は。", "Kimi no Na wa.");

  it("reads a name in any script", () => {
    expect(judgeRelease("Начало.2010.UHD.Blu-Ray.Remux.2160p.[by arxivariys].mkv", facts(2010, "Inception", "Начало"), "movie")).toBe("match");
    expect(judgeRelease("[VCB-Studio] Kimi no Na wa. / 君の名は。 10-bit 1080p HEVC BDRip [Fin]", yourName, "movie")).toBe("match");
    expect(judgeRelease("Alikara S01 1080p TOD WEB-DL [TR] AAC2.0 H.264-TURG", facts(2026, "Alıkara"), "tv")).toBe("match");
  });

  it("takes a translation beside a title in Latin letters as the same title", () => {
    expect(judgeRelease("Inception Начало 2010 BDRip 1080p", facts(2010, "Inception"), "movie")).toBe("match");
  });

  it("ends a title where its tags begin", () => {
    expect(judgeRelease("[Judas] Kimi no Na Wa. (Your Name.) [BD 2160p 4K UHD][HEVC x265 10bit][Dual-Audio][Multi-Subs]", yourName, "movie")).toBe("match");
    expect(judgeRelease("[VCB-Studio] Kimi no Na wa. -your name.- [Ma10p_1080p][x265_flac].mkv", yourName, "movie")).toBe("match");
    expect(judgeRelease("[NSDAB] your name. [BD 1080p Opus] [C34C181B].mkv", yourName, "movie")).toBe("match");
    expect(judgeRelease("[2ndfire]My_Neighbor_Totoro[DCP Theatrical Master][2160p][AV1][10bit][67695A2D].mkv", facts(1988, "My Neighbor Totoro"), "movie")).toBe("match");
  });

  it("takes the year from the tags when the name has none before them", () => {
    const interstellar = facts(2014, "Interstellar");
    expect(judgeRelease("Интерстеллар / Interstellar [2014 UHD BDRemux 2160p HDR10] [IMAX] Dub + MVO", interstellar, "movie")).toBe("match");
    expect(judgeRelease("Animals.WEB-DL.CZ.5.1.EN.5.1.2026.1080p.mkv", facts(2026, "Animals"), "movie")).toBe("match");
    expect(judgeRelease("Dune [1984 BDRemux 1080p]", facts(2021, "Dune"), "movie")).toBe("mismatch");
  });

  it("reads a year in front of the name as its date", () => {
    expect(judgeRelease("2010.Inception.1920x800.BDRip.x264.DTS-HD.MA.mkv", facts(2010, "Inception"), "movie")).toBe("match");
    expect(judgeRelease("2012.2009.1080p.BluRay.x264", facts(2009, "2012"), "movie")).toBe("match");
  });

  it("passes over what a copy says of itself before its technical part", () => {
    expect(judgeRelease("Resident Evil 1080.mkv", facts(2026, "Resident Evil"), "movie")).toBe("match");
    expect(judgeRelease("Origen.DVD.XviD.[www.DivxTotaL.com].avi", facts(2010, "Inception", "Origen"), "movie")).toBe("match");
    expect(judgeRelease("[Reaktor] Akira - 30th Anniversary [1080p][BD][x265][10-bit][Dual-Audio]", facts(1988, "Akira"), "movie")).toBe("match");
    expect(judgeRelease("Lord_of_the_Rings_Fellowship_of_the_Ring_Ext_2001_1080p_BluRay", facts(2001, "The Lord of the Rings: The Fellowship of the Ring"), "movie")).toBe("match");
  });

  it("takes a language named after the title as the copy's, and one in front of it as the title's", () => {
    expect(judgeRelease("The.Intouchables.Latino.BRrip.XviD.2011.SBT", facts(2011, "The Intouchables"), "movie")).toBe("match");
    expect(judgeRelease("The English Teacher S01E01 1080p WEB", facts(2022, "The Teacher"), "tv")).toBe("mismatch");
  });

  it("reads a title that opens with a bracket of its own", () => {
    expect(judgeRelease("[REC] 2 (2009) (1080p BluRay x265 HEVC 10bit EAC3 5.1 Spanish Ghost) [QxR]", facts(2009, "[REC]²", "[REC] 2"), "movie")).toBe("match");
  });

  it("reads a name written as tags from end to end", () => {
    const linkClick = facts(2021, "Link Click", "时光代理人");
    expect(judgeRelease("[GM-Team][国漫][时光代理人][Link Click][2021][01-11 Fin+SP][AVC][GB][1080P]", linkClick, "tv")).toBe("match");
    expect(judgeRelease("[DBD-Raws][你的颜色/Kimi no Iro][正片+特典映像][1080P][BDRip][HEVC-10bit][FLAC+DTS][MKV]", facts(2013, "Attack on Titan"), "tv")).toBe("mismatch");
  });

  it("reads both names either side of a.k.a.", () => {
    expect(judgeRelease("Anatomy.of.a.Fall.A.K.A.Anatomie.d'une.chute.2023.1080p.10bit.BluRay", facts(2023, "Anatomy of a Fall"), "movie")).toBe("match");
  });
});

describe("judgeRelease, the other films of a series", () => {
  const facts = (year: number, ...titles: string[]): TitleFacts => ({ titles, year });

  it("rejects the next film, which shares the series' name and differs after it", () => {
    const fellowship = facts(2001, "The Lord of the Rings: The Fellowship of the Ring");
    expect(judgeRelease("The.Lord.of.the.Rings.The.Two.Towers.2002.1080p.BluRay.x264", fellowship, "movie")).toBe("mismatch");
    expect(judgeRelease("Harry.Potter.and.the.Chamber.of.Secrets.2002.1080p", facts(2001, "Harry Potter and the Philosopher's Stone"), "movie")).toBe("mismatch");
    expect(judgeRelease("The.Matrix.Revolutions.2003.2160p", facts(2003, "The Matrix Reloaded"), "movie")).toBe("mismatch");
    expect(judgeRelease("Pirates.of.the.Caribbean.At.Worlds.End.2007.1080p", facts(2006, "Pirates of the Caribbean: Dead Man's Chest"), "movie")).toBe("mismatch");
  });

  it("rejects a sequel named by a subtitle after the first film's name", () => {
    expect(judgeRelease("The.Hunger.Games.Catching.Fire.2013.1080p.BluRay", facts(2012, "The Hunger Games"), "movie")).toBe("mismatch");
    expect(judgeRelease("Maze.Runner.The.Scorch.Trials.2015.1080p", facts(2014, "The Maze Runner"), "movie")).toBe("mismatch");
  });

  it("rejects a film that swaps one word of the title", () => {
    expect(judgeRelease("Your.Fault.2024.1080p.WEB", facts(2023, "My Fault"), "movie")).toBe("mismatch");
  });

  it("rejects another numbered part", () => {
    expect(judgeRelease("Kill.Bill.Vol.1.2003.1080p.BluRay", facts(2004, "Kill Bill: Vol. 2"), "movie")).toBe("mismatch");
    expect(judgeRelease("Scary.Movie.2000.1080p.BluRay", facts(2001, "Scary Movie 2"), "movie")).toBe("mismatch");
    expect(judgeRelease("Harry.Potter.and.the.Deathly.Hallows.Part.1.2010.1080p", facts(2011, "Harry Potter and the Deathly Hallows: Part 2"), "movie")).toBe("mismatch");
  });

  it("takes the series' name for a part only with that part's own year", () => {
    const catchingFire = facts(2013, "The Hunger Games: Catching Fire", "The Hunger Games");
    expect(judgeRelease("The.Hunger.Games.2012.1080p.BluRay", catchingFire, "movie")).toBe("mismatch");
    expect(judgeRelease("The Hunger Games 1080p BluRay x264", catchingFire, "movie")).toBe("mismatch");
    const borat = facts(2006, "Borat: Cultural Learnings of America for Make Benefit Glorious Nation of Kazakhstan", "Borat");
    expect(judgeRelease("Borat.2006.1080p.BluRay.x264", borat, "movie")).toBe("match");
  });

  it("keeps a shortened name only under the film's own year", () => {
    const fellowship = facts(2001, "The Lord of the Rings: The Fellowship of the Ring");
    expect(judgeRelease("The.Lord.of.the.Rings.2001.Extended.Remastered.2160p.UHD.BluRay", fellowship, "movie")).toBe("unknown");
    expect(judgeRelease("The.Lord.of.the.Rings.2002.Extended.2160p.UHD.BluRay", fellowship, "movie")).toBe("mismatch");
  });

  it("knows the first film by a number that only says it is the first", () => {
    const godfather = facts(1972, "The Godfather", "El padrino");
    expect(judgeRelease("The.Godfather.Part.I.1972.UNCUT.1080p.BluRay.x264-iLLUSiON", godfather, "movie")).toBe("match");
    expect(judgeRelease("El padrino 1 [4Kreescalado][2160p][HDR10][AC3 5.1 Castellano]", godfather, "movie")).toBe("match");
    expect(judgeRelease("The.Godfather.Part.II.1974.1080p.BluRay", godfather, "movie")).toBe("mismatch");
    const infinityCastle = facts(2025, "Demon Slayer: Kimetsu no Yaiba Infinity Castle", "Kimetsu no Yaiba: Mugenjou Hen");
    expect(judgeRelease("[Erai-raws] Kimetsu no Yaiba: Mugenjou Hen - Movie 01 [1080p CR WEBRip HEVC AAC][MultiSub]", infinityCastle, "movie")).toBe("match");
  });

  it("does not take a letter's difference for a misspelling without a year", () => {
    expect(judgeRelease("Aliens.1080p.BluRay.x264", facts(1979, "Alien"), "movie")).toBe("mismatch");
  });

  it("rejects a show that only shares the end of this one's name", () => {
    expect(judgeRelease("The.Walking.Dead.S01E01.1080p.BluRay", { titles: ["Fear the Walking Dead"], year: 2015 }, "tv")).toBe("mismatch");
    expect(judgeRelease("Fear.the.Walking.Dead.S01E01.1080p", { titles: ["The Walking Dead"], year: 2010 }, "tv")).toBe("mismatch");
  });
});

describe("judgeRelease, series counted without season tags", () => {
  const show = (year: number, ...titles: string[]): TitleFacts => ({ titles, year });

  it("ends the show's name at the episode's number", () => {
    expect(judgeRelease("[Anime Time] One Piece - 0001 - I'm Luffy! The Man Who's Gonna Be King of the Pirates!.mkv", show(1999, "One Piece"), "tv")).toBe("match");
    expect(judgeRelease("[Feibanyama] One Piece EP0001 [IQIYI WebRip 2160p HEVC OPUS Multi-Audio Multi-Subs]", show(1999, "One Piece"), "tv")).toBe("match");
    expect(judgeRelease("[Redc4t] Death Note - 01v2 [BD 1080p] [3EA65443].mkv", show(2006, "Death Note"), "tv")).toBe("match");
    expect(judgeRelease("Death Note - Episode 01 - Rebirth 1080p Hybrid ITA BDRip DTS-HD MA 2.0 Kira [SEV].mkv", show(2006, "Death Note"), "tv")).toBe("match");
    expect(judgeRelease("[CBM]_Chainsaw_Man_-_01_-_Dog_&_Chainsaw_[H.265_10bit]_[3E626F33].mkv", show(2022, "Chainsaw Man"), "tv")).toBe("match");
  });

  it("still rejects a spin-off or a special numbered the same way", () => {
    expect(judgeRelease("Fullmetal Alchemist Brotherhood OVA - 01 - The Blind Alchemist [DarkDream].mkv", show(2009, "Fullmetal Alchemist: Brotherhood"), "tv")).toBe("mismatch");
    expect(judgeRelease("[Erai-raws] Naruto Shippuuden - 001 [1080p].mkv", show(2002, "Naruto"), "tv")).toBe("mismatch");
  });

  it("knows a show by the short name it is released under", () => {
    const demonSlayer = show(2019, "Demon Slayer: Kimetsu no Yaiba", "Demon Slayer");
    expect(judgeRelease("Demon.Slayer.S01.P1.1080p.Blu-Ray.10-Bit.Dual-Audio.LPCM.x265-iAHD", demonSlayer, "tv")).toBe("match");
    expect(judgeRelease("[SCY] Demon Slayer - 01 (BD 1080p Hi10 FLAC) [4B2F39B0].mkv", demonSlayer, "tv")).toBe("match");
  });

  it("reads seasons counted in other languages", () => {
    expect(judgeRelease("Los Simpsons - Temporada 1 [HDTV][Cap.101_113][Castellano]", show(1989, "The Simpsons", "Los Simpsons"), "tv")).toBe("match");
    expect(judgeRelease("Fullmetal.Alchemist.Brotherhood.S01EP01.1080p.ITA.ENG.JPN.AAC.x265-EDGE.mkv", show(2009, "Fullmetal Alchemist: Brotherhood"), "tv")).toBe("match");
  });
});

describe("judgeReleaseName", () => {
  const facts = (year: number, ...titles: string[]): TitleFacts => ({ titles, year });

  it("says when a name states outright that it is something else", () => {
    const fightClub = facts(1999, "Fight Club");
    expect(judgeReleaseName("Nirvanna the Band the Show the Movie (2026) (1080p BluRay x265).mkv", fightClub, "movie")).toMatchObject({ verdict: "mismatch", contradicts: true });
    expect(judgeReleaseName("Dune.Part.Two.mkv", facts(2021, "Dune"), "movie")).toMatchObject({ verdict: "mismatch", contradicts: true });
    expect(judgeReleaseName("Fight.Club.S01E01.1080p.mkv", fightClub, "movie")).toMatchObject({ verdict: "mismatch", contradicts: true });
  });

  it("takes an episode's number after a film's name for the series of that name", () => {
    const film = facts(1995, "Ghost in the Shell", "The Ghost in the Shell");
    expect(judgeReleaseName("[Commie] The Ghost in the Shell - 01v2 [E99D2A66].mkv", film, "movie")).toMatchObject({ verdict: "mismatch", contradicts: true });
    expect(judgeReleaseName("[Haruhana] THE GHOST IN THE SHELL - 06 [WebRip][HEVC-10bit 1080p].mkv", film, "movie")).toMatchObject({ verdict: "mismatch", contradicts: true });
  });

  it("does not call a name it merely cannot place a contradiction", () => {
    expect(judgeReleaseName("besthd-fclub-1080p.mkv", facts(1999, "Fight Club"), "movie")).toEqual({ verdict: "mismatch", related: false, contradicts: false, anotherYear: false });
  });

  it("tells a variation of the name from a name with nothing to read", () => {
    expect(judgeReleaseName("Marvels.The.Avengers.2012.2160p.UHD.BluRay", facts(2012, "The Avengers"), "movie")).toEqual({ verdict: "unknown", related: true, contradicts: false, anotherYear: false });
    expect(judgeReleaseName("2160p.BluRay.x265-GRP", facts(2021, "Dune"), "movie")).toEqual({ verdict: "unknown", related: false, contradicts: false, anotherYear: false });
  });
});

describe("countedEpisode", () => {
  const onePiece: TitleFacts = { titles: ["One Piece"], year: 1999 };

  it("is the number a file counts itself by after the show's name", () => {
    expect(countedEpisode("[Anime Time] Naruto - 001 - Enter Naruto Uzumaki!.mkv", { titles: ["Naruto"], year: 2002 })).toEqual({ from: 1, to: 1 });
    expect(countedEpisode("One Piece English Dub 640.mp4", onePiece)).toEqual({ from: 640, to: 640 });
    expect(countedEpisode("[Feibanyama] One Piece EP0001 [IQIYI WebRip 2160p].mkv", onePiece)).toEqual({ from: 1, to: 1 });
  });

  it("spans two episodes in one file", () => {
    expect(countedEpisode("One Piece - 01-02 [1080p].mkv", onePiece)).toEqual({ from: 1, to: 2 });
  });

  it("is null for a file with a season tag, another show's, or a date", () => {
    expect(countedEpisode("One.Piece.S01E05.1080p.mkv", onePiece)).toBeNull();
    expect(countedEpisode("Naruto - 005.mkv", onePiece)).toBeNull();
    expect(countedEpisode("[Pandoratv-raws] Doraemon (2005) 2005.04.15 - (1) (EX-CS1 1280x720).mp4", { titles: ["Doraemon"], year: 2005 })).toBeNull();
  });
});

describe("judgeRelease, a later show of the same name", () => {
  const onePiece: TitleFacts = { titles: ["One Piece"], year: 1999, seasonYears: { 1: 1999, 2: 2000, 21: 2023 } };
  const doctorWho: TitleFacts = { titles: ["Doctor Who"], year: 2005, seasonYears: { 1: 2005, 14: 2024 } };

  it("rejects a year after the season asked for first aired", () => {
    const liveAction = "ONE PIECE 2023 S01E01 Romance Dawn REPACK 1080p NF WEB-DL DDP5 1 Atmos H 264-FLUX";
    expect(judgeReleaseName(liveAction, onePiece, "tv", { season: 1 })).toMatchObject({ verdict: "mismatch", anotherYear: true });
    expect(judgeReleaseName("One Piece S01E01 2023 2160p NF WEB-DL DDP5 1 Atmos DV HDR H 265-HHWEB", onePiece, "tv", { season: 1 })).toMatchObject({ anotherYear: true });
    expect(judgeRelease("ONE PIECE 2023 S02E01 1080p NF WEB-DL", onePiece, "tv", { season: 2 })).toBe("mismatch");
  });

  it("accepts a later season under its own year, or the show's", () => {
    expect(judgeRelease("Doctor.Who.2023.S14E01.1080p", doctorWho, "tv", { season: 14 })).toBe("match");
    expect(judgeRelease("Doctor.Who.2005.S14E01.1080p", doctorWho, "tv", { season: 14 })).toBe("match");
    expect(judgeRelease("One Piece 2023 S21E01 1080p WEB", onePiece, "tv", { season: 21 })).toBe("match");
  });

  it("judges a first season by the show's year when its seasons are not known", () => {
    const show: TitleFacts = { titles: ["Dark Matter"], year: 2015 };
    expect(judgeRelease("Dark.Matter.2024.S01E01.1080p.WEB", show, "tv", { season: 1 })).toBe("mismatch");
    expect(judgeRelease("Dark.Matter.2024.S03E01.1080p.WEB", show, "tv", { season: 3 })).toBe("match");
  });

  it("lets a whole run carry the year it was put together", () => {
    expect(judgeRelease("One Piece Complete Collection 2021 1080p BluRay", onePiece, "tv", { season: 1 })).toBe("match");
  });

  it("dates a run given as the years it spans by the first of them", () => {
    const demonSlayer: TitleFacts = { titles: ["Demon Slayer: Kimetsu no Yaiba", "Demon Slayer"], year: 2019 };
    const run = "[EMBER] Demon Slayer (2019-2020) (Season 1+Movie) [BDRip] [1080p Dual Audio HEVC 10 bits] (Kimetsu no Yaiba)";
    expect(parseReleaseName(run, "tv")).toMatchObject({ title: "demon slayer", year: 2019 });
    expect(judgeRelease(run, demonSlayer, "tv", { season: 1 })).toBe("match");
  });

  it("does not take a year in an episode's own title for the release's date", () => {
    const titan: TitleFacts = { titles: ["Attack on Titan"], year: 2013, seasonYears: { 1: 2013 } };
    const untagged = "Attack on Titan - Episode 01 - To You, in 2000 Years - The Fall of Shiganshina, Part 1 1080p Hybrid ITA BDRip x265";
    expect(judgeRelease(untagged, titan, "tv", { season: 1 })).toBe("match");
    const takopi: TitleFacts = { titles: ["Takopi's Original Sin"], year: 2025, seasonYears: { 1: 2025 } };
    expect(judgeRelease("Takopis.Original.Sin.S01E01.To.You.in.2016.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264-VARYG.mkv", takopi, "tv", { season: 1 })).toBe("match");
    expect(judgeRelease("[JPN-ENG] Attack on Titan : Season 01 S01 [2013] COMPLETE 1080p Hybrid ITA BDRip x265 FLAC 2.0 Kira [SEV]", titan, "tv", { season: 1 })).toBe("match");
  });

  it("does not take a series' numbered volume or chapter for another title", () => {
    const bleach: TitleFacts = { titles: ["Bleach"], year: 2004 };
    expect(judgeReleaseName("[uP] Bleach - Vol.01 (BDRip 1080p x264 AC3 Multi)", bleach, "tv", { season: 1 }).contradicts).toBe(false);
  });

  it("still ends a film's title at the year in it", () => {
    expect(parseReleaseName("Wonder.Woman.1984.2020.2160p.WEB-DL")).toMatchObject({ title: "wonder woman 1984", year: 2020 });
  });
});

describe("judgeRelease, several of a title's names in a row", () => {
  it("reads three names divided the way a tracker in another script divides them", () => {
    const yourName: TitleFacts = { titles: ["Your Name.", "君の名は。", "Kimi no Na wa."], year: 2016 };
    expect(judgeRelease("[UCCUSS] your name.／Kimi no Na wa.／君の名は。 (BD 1920x1080p AVC DTSHD SUPx4)", yourName, "movie")).toBe("match");
    expect(judgeRelease("Your Name Kimi no Na wa 君の名は 2016 1080p BluRay", yourName, "movie")).toBe("match");
  });

  it("does not take another title beside one of its names for more of its names", () => {
    const yourName: TitleFacts = { titles: ["Your Name.", "Kimi no Na wa."], year: 2016 };
    expect(judgeRelease("Your Name Weathering With You 2016 1080p BluRay", yourName, "movie")).toBe("mismatch");
  });
});

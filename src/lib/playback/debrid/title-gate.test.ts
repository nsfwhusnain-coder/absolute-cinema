/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { addTitleNames, identify, isOtherEpisode, isWrongTitle, linkFileName, rememberTitleFacts, titleFactsFor, titleFactsFrom } from "./title-gate";

const inception = { titles: ["Inception", "A Origem", "Origen"], year: 2010 };
const godfather = { titles: ["The Godfather", "Il padrino", "O Poderoso Chefão"], year: 1972 };
const rickAndMorty = { titles: ["Rick and Morty"], year: 2013 };

describe("titleFactsFrom", () => {
  it("gathers every name once, with the year", () => {
    const facts = titleFactsFrom({
      title: "Spirited Away",
      original_title: "千と千尋の神隠し",
      release_date: "2001-07-20",
      alternative_titles: { titles: [{ title: "La città incantata" }, { title: "Spirited Away" }] },
      translations: { translations: [{ data: { title: "El viaje de Chihiro" } }, { data: { title: "" } }] },
    });
    expect(facts.titles).toEqual(["Spirited Away", "千と千尋の神隠し", "La città incantata", "El viaje de Chihiro"]);
    expect(facts.year).toBe(2001);
  });

  it("keeps the year each season of a series first aired", () => {
    const facts = titleFactsFrom({
      name: "One Piece",
      first_air_date: "1999-10-20",
      seasons: [{ season_number: 0, air_date: "2000-12-20" }, { season_number: 1, air_date: "1999-10-20" }, { season_number: 2, air_date: null }],
    });
    expect(facts.seasonYears).toEqual({ 1: 1999 });
  });

  it("marks anime, whose seasons other catalogues number their own way", () => {
    const anime = titleFactsFrom({ name: "Bleach", first_air_date: "2004-10-05", original_language: "ja", genres: [{ id: 16 }, { id: 10759 }] });
    expect(anime.anime).toBe(true);
    const cartoon = titleFactsFrom({ name: "Rick and Morty", first_air_date: "2013-12-02", original_language: "en", origin_country: ["US"], genres: [{ id: 16 }] });
    expect(cartoon.anime).toBeUndefined();
  });

  it("knows a season by its own name after the show's, and not by its number", () => {
    const facts = titleFactsFrom({
      name: "Bleach",
      first_air_date: "2004-10-05",
      seasons: [{ season_number: 0, name: "Specials" }, { season_number: 1, name: "Bleach" }, { season_number: 2, name: "Thousand-Year Blood War" }, { season_number: 3, name: "Season 3" }],
    });
    expect(facts.titles).toEqual(["Bleach", "Bleach Thousand-Year Blood War"]);
    expect(facts.seasonNames).toEqual({ 2: "Thousand-Year Blood War" });
    const onePiece = titleFactsFrom({ name: "One Piece", seasons: [{ season_number: 16, name: "Dressrosa" }, { season_number: 17, name: "Dressrosa (2)" }] });
    expect(onePiece.seasonNames).toEqual({ 16: "Dressrosa", 17: "Dressrosa" });
  });

  it("reads a series' names and first year", () => {
    const facts = titleFactsFrom({ name: "Dark Matter", first_air_date: "2024-05-07", alternative_titles: { results: [{ title: "Materia oscura" }] } });
    expect(facts).toEqual({ titles: ["Dark Matter", "Materia oscura"], year: 2024 });
  });
});

describe("linkFileName", () => {
  it("is the decoded last part of the path", () => {
    expect(linkFileName("https://cdn.example/d/ABC123/Inception.2010.1080p.BluRay.x264.mp4")).toBe("Inception.2010.1080p.BluRay.x264.mp4");
    expect(linkFileName("https://cdn.example/dl/x/S02E08%20Interdimensional%20Cable%202.mkv?t=1")).toBe("S02E08 Interdimensional Cable 2.mkv");
    expect(linkFileName("not a url")).toBe("");
  });
});

describe("isOtherEpisode", () => {
  it("is true only when the file states a different episode", () => {
    expect(isOtherEpisode("Rick.and.Morty.S02E08.1080p.mkv", 2, 8)).toBe(false);
    expect(isOtherEpisode("Rick.and.Morty.S02E09.1080p.mkv", 2, 8)).toBe(true);
    expect(isOtherEpisode("Rick.and.Morty.S01E08.1080p.mkv", 2, 8)).toBe(true);
    expect(isOtherEpisode("08 - Interdimensional Cable 2.mkv", 2, 8)).toBe(false);
    expect(isOtherEpisode("Rick.and.Morty.S02E09.mkv", undefined, undefined)).toBe(false);
  });
});

describe("isOtherEpisode, anime", () => {
  it("does not hold another catalogue's season number against the episode", () => {
    expect(isOtherEpisode("[Judas] Bleach - S17E03.mkv", 2, 3, true)).toBe(false);
    expect(isOtherEpisode("Bleach.S18E01.1080p.mkv", 2, 14, true)).toBe(false);
    expect(isOtherEpisode("[Judas] Bleach - S17E03.mkv", 2, 3)).toBe(true);
  });

  it("still knows a first season is not a later one, and one episode of a season is not another", () => {
    expect(isOtherEpisode("Bleach.S17E01.1080p.BluRay.Remux.mkv", 1, 1, true)).toBe(true);
    expect(isOtherEpisode("Bleach.S02E05.1080p.mkv", 2, 3, true)).toBe(true);
  });
});

describe("isWrongTitle", () => {
  it("drops one film out of a collection when nothing names the file", () => {
    expect(isWrongTitle(inception, { mediaType: "movie", release: "Amazing Films 7 - Mp4 x264 AC3 1080p" })).toBe(true);
    expect(isWrongTitle(inception, { mediaType: "movie", release: "500 Classic Movies Part 1 of 7 - 67 Movies with IMDB Ratings from 8.0 to 9.0" })).toBe(true);
  });

  it("keeps a file named for the film, whatever it sits in", () => {
    expect(isWrongTitle(inception, { mediaType: "movie", release: "Amazing Films 7 - Mp4 x264 AC3 1080p", fileName: "Inception (2010).mp4" })).toBe(false);
  });

  it("drops a file named for another film, whatever the release was called", () => {
    expect(isWrongTitle(godfather, { mediaType: "movie", release: "The Godfather 1972 1080p BluRay", fileName: "The.Godfather.Part.III.1990.1080p.mkv" })).toBe(true);
    expect(isWrongTitle(godfather, { mediaType: "movie", release: "O Poderoso Chefão: Parte III 1080p comando4k.com" })).toBe(true);
  });

  it("knows the film under its names in other languages", () => {
    expect(isWrongTitle(inception, { mediaType: "movie", release: "A Origem (2010) 1080p Dublado" })).toBe(false);
    expect(isWrongTitle(godfather, { mediaType: "movie", release: "The.Godfather - Il.Padrino.1972.REMASTERED.BluRay.1080p" })).toBe(false);
  });

  it("drops the wrong episode of the right show", () => {
    const question = { mediaType: "tv" as const, release: "Rick and Morty S02 1080p BluRay x265", season: 2, episode: 8 };
    expect(isWrongTitle(rickAndMorty, { ...question, fileName: "Rick.and.Morty.S02E08.1080p.mkv" })).toBe(false);
    expect(isWrongTitle(rickAndMorty, { ...question, fileName: "Rick.and.Morty.S02E07.1080p.mkv" })).toBe(true);
  });

  it("does not judge a show by an episode file named for the episode alone", () => {
    expect(isWrongTitle(rickAndMorty, { mediaType: "tv", release: "Rick and Morty S02 1080p BluRay x265", fileName: "Interdimensional Cable 2 Tempting Fate.mkv", season: 2, episode: 8 })).toBe(false);
  });

  it("drops another show filed under this one", () => {
    expect(isWrongTitle({ titles: ["Your Name."], year: 2016 }, { mediaType: "movie", release: "22/7 - Ano Hi no Kanojo-tachi (01-08) + Music Videos" })).toBe(true);
  });

  it("checks nothing when the title's names could not be fetched", () => {
    expect(isWrongTitle(null, { mediaType: "movie", release: "Amazing Films 7 - Mp4 x264 AC3 1080p" })).toBe(false);
  });
});

describe("identify", () => {
  const fightClub = { titles: ["Fight Club"], year: 1999 };
  const godfatherTwo = { titles: ["The Godfather Part II"], year: 1974 };

  it("is verified by a file or a release that names the title", () => {
    expect(identify(inception, { mediaType: "movie", release: "Inception.2010.2160p.UHD.BluRay.x265" })).toBe("verified");
    expect(identify(inception, { mediaType: "movie", release: "Amazing Films 7 - Mp4 x264 AC3 1080p", fileName: "Inception (2010) 1080p Surround.mp4" })).toBe("verified");
  });

  it("keeps, unverified, a file under a name of its own in a release that names the film", () => {
    expect(identify(fightClub, { mediaType: "movie", release: "Fight Club 1999 1080p BluRay x264-BestHD", fileName: "besthd-fclub-1080p.mkv" })).toBe("unverified");
  });

  it("drops a file that states another film, in a release that names this one", () => {
    const question = { mediaType: "movie" as const, release: "Fight Club (1999) RM4K (1080p BluRay x265 10bit EAC3 5.1 Celdra)" };
    expect(identify(fightClub, { ...question, fileName: "Nirvanna the Band the Show the Movie (2026) (1080p BluRay x265).mkv" })).toBe("wrong");
  });

  it("keeps a file under a variation of the film's name, with its year, out of a pack", () => {
    const question = { mediaType: "movie" as const, release: "The Godfather Trilogy Al Pacino 2160p 4K SDR ENG-ITA 16GB UHD" };
    expect(identify(godfatherTwo, { ...question, fileName: "The Godfather II (1974) 2160p SDR ENG-ITA (moviesbyrizzo).mkv" })).toBe("unverified");
    expect(identify(godfatherTwo, { ...question, fileName: "The Godfather III (1990) 2160p SDR ENG-ITA (moviesbyrizzo).mkv" })).toBe("wrong");
  });

  it("drops a file under another name when the release has no name to vouch for it", () => {
    expect(identify(fightClub, { mediaType: "movie", release: "2160p.BluRay.x265-GRP", fileName: "Some.Other.Film.1080p.mkv" })).toBe("wrong");
  });

  it("is unverified when a variation of the name is all there is, or nothing to read", () => {
    expect(identify({ titles: ["The Avengers"], year: 2012 }, { mediaType: "movie", release: "Marvels.The.Avengers.2012.2160p.UHD.BluRay" })).toBe("unverified");
    expect(identify(inception, { mediaType: "movie", release: "2160p.BluRay.x265-GRP" })).toBe("unverified");
    expect(identify(null, { mediaType: "movie", release: "Inception.2010.2160p" })).toBe("unverified");
  });

  it("drops a first-season file that counts itself as another episode", () => {
    const onePiece = { titles: ["One Piece"], year: 1999 };
    const question = { mediaType: "tv" as const, release: "One Piece English Dubbed.EP.0001-1073.AVC.AAC.1080p", season: 1, episode: 1 };
    expect(identify(onePiece, { ...question, fileName: "One Piece English Dub 640.mp4" })).toBe("wrong");
    expect(identify(onePiece, { ...question, fileName: "One Piece English Dub 001.mp4" })).toBe("verified");
    expect(identify(onePiece, { ...question, episode: 5, fileName: "One.Piece.105.DVDRip.avi" })).toBe("verified");
  });

  it("does not judge a later season by a number that may count on from the first", () => {
    const question = { mediaType: "tv" as const, release: "Bleach Complete 1080p", season: 2, episode: 1, fileName: "Bleach - 021.mkv" };
    expect(identify({ titles: ["Bleach"], year: 2004 }, question)).toBe("verified");
  });
});

describe("identify, a later show of the same name", () => {
  const onePiece = { titles: ["One Piece"], year: 1999, seasonYears: { 1: 1999 } };
  const question = { mediaType: "tv" as const, season: 1, episode: 1 };

  it("drops it by its release's year, however its file is named", () => {
    const release = "ONE PIECE 2023 S01E01 Romance Dawn REPACK 1080p NF WEB-DL DDP5 1 Atmos H 264-FLUX";
    expect(identify(onePiece, { ...question, release })).toBe("wrong");
    expect(identify(onePiece, { ...question, release, fileName: "One.Piece.S01E01.Romance.Dawn.1080p.mkv" })).toBe("wrong");
  });

  it("drops it by its file's year, in a release that does not give one", () => {
    expect(identify(onePiece, { ...question, release: "One Piece S01 1080p WEB-DL", fileName: "One.Piece.2023.S01E01.1080p.NF.WEB-DL.mkv" })).toBe("wrong");
  });
});

describe("identify, an anime season numbered another way", () => {
  const bleach = { titles: ["Bleach"], year: 2004, seasonYears: { 1: 2004, 2: 2022 }, anime: true };

  it("keeps the episode under the number another catalogue gives its season", () => {
    const question = { mediaType: "tv" as const, release: "[Judas] Bleach (Season 17) [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]", season: 2, episode: 3 };
    expect(identify(bleach, { ...question, fileName: "[Judas] Bleach - S17E03.mkv" })).toBe("verified");
  });

  it("drops a later season's episode offered as the first season's", () => {
    const question = { mediaType: "tv" as const, release: "[LGH] Bleach Season 17 (S17) E01-E13 (BD Remux 1080p FLAC H.264) [Dual Audio]", season: 1, episode: 1 };
    expect(identify(bleach, { ...question, fileName: "Bleach.S17E01.1080p.BluRay.Remux.Dual-Audio.FLAC2.0.H.264-LGH.mkv" })).toBe("wrong");
  });
});

describe("addTitleNames", () => {
  it("widens what is remembered of a title, for every check after", () => {
    rememberTitleFacts("tt0000041", { titles: ["Bleach"], year: 2004, anime: true });
    const question = { mediaType: "tv" as const, release: "[Sakurato] Bleach: Sennen Kessen-hen - Soukoku-tan [07][AVC-8bit 1080P AAC]", season: 2, episode: 33 };
    expect(identify(titleFactsFor("tt0000041"), question)).toBe("wrong");

    addTitleNames("tt0000041", ["Bleach: Sennen Kessen-hen - Soukoku-tan", "Bleach"]);

    expect(titleFactsFor("tt0000041")?.titles).toEqual(["Bleach", "Bleach: Sennen Kessen-hen - Soukoku-tan"]);
    expect(identify(titleFactsFor("tt0000041"), question)).toBe("verified");
  });

  it("does nothing for a title nothing is remembered of", () => {
    expect(addTitleNames("tt0000042", ["Some Name"])).toBeNull();
  });
});

describe("identify, a side series out of an anime batch", () => {
  const onePiece = { titles: ["One Piece"], year: 1999, anime: true };
  const batch = { mediaType: "tv" as const, release: "[Erai-raws] One Piece - 0892 ~ 1089 [1080p][HEVC][BATCH][Multiple Subtitle]", season: 22, episode: 1 };

  it("drops a file that counts an episode of something else", () => {
    expect(identify(onePiece, { ...batch, fileName: "[Erai-raws] Barto no Himitsu no Heya! - 01 [1080p][HEVC][548D348E].mkv" })).toBe("wrong");
    expect(identify(onePiece, { ...batch, fileName: "[Erai-raws] One Piece - 1089 [1080p][HEVC].mkv" })).toBe("verified");
  });

  it("leaves a show that is not anime to its episode titles", () => {
    const question = { mediaType: "tv" as const, release: "Rick and Morty S02 1080p BluRay x265", season: 2, episode: 8, fileName: "Interdimensional Cable - 02.mkv" };
    expect(identify({ titles: ["Rick and Morty"], year: 2013 }, question)).toBe("verified");
  });
});

describe("identify, a file named for another season", () => {
  const onePiece = { titles: ["One Piece", "One Piece East Blue", "One Piece Dressrosa"], year: 1999, anime: true, seasonNames: { 1: "East Blue", 16: "Dressrosa", 17: "Dressrosa" } };
  const recut = "[Muhn Pace] One Piece - 628-745 (Dressrosa) [1080p WEB x264]";

  it("drops it for the season it is not, and keeps it for its own", () => {
    const question = { mediaType: "tv" as const, release: recut, fileName: "[Muhn Pace] Dressrosa 02 [1080p][24F67B6B].mp4" };
    expect(identify(onePiece, { ...question, season: 1, episode: 2 })).toBe("wrong");
    expect(identify(onePiece, { ...question, season: 17, episode: 2 })).not.toBe("wrong");
  });

  it("does not read a pack's name for the seasons it lists", () => {
    const question = { mediaType: "tv" as const, release: "One Piece (East Blue + Dressrosa) [1080p]", fileName: "One Piece - 002.mkv", season: 1, episode: 2 };
    expect(identify(onePiece, question)).toBe("verified");
  });
});

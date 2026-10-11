/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { identify, isOtherEpisode, isWrongTitle, linkFileName, titleFactsFrom } from "./title-gate";

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

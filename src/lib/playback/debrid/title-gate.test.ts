/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isOtherEpisode, isWrongTitle, linkFileName, titleFactsFrom } from "./title-gate";

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

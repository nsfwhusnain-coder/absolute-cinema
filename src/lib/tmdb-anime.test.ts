/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  belongsOnAnimeShelf,
  isTmdbAnimeTitle,
  withoutAnimeTitles,
  keywordsFromTmdbAppend,
  TMDB_ANIMATION_GENRE_ID,
} from "./tmdb-anime";

describe("isTmdbAnimeTitle", () => {
  it("classifies Japanese animation as anime", () => {
    expect(
      isTmdbAnimeTitle({
        genreIds: [TMDB_ANIMATION_GENRE_ID, 18],
        originalLanguage: "ja",
        originCountry: ["JP"],
      })
    ).toBe(true);
  });

  it("does not treat Western animation as anime", () => {
    expect(
      isTmdbAnimeTitle({
        genreIds: [TMDB_ANIMATION_GENRE_ID, 12],
        originalLanguage: "en",
        originCountry: ["US"],
      })
    ).toBe(false);
  });

  it("does not classify non-animation Japanese live action", () => {
    expect(
      isTmdbAnimeTitle({
        genreIds: [18, 80],
        originalLanguage: "ja",
        originCountry: "JP",
      })
    ).toBe(false);
  });

  it("accepts an anime keyword when Animation is present", () => {
    expect(
      isTmdbAnimeTitle({
        genres: [{ id: TMDB_ANIMATION_GENRE_ID, name: "Animation" }],
        originalLanguage: "en",
        originCountry: ["US"],
        keywords: ["anime", "based on manga"],
      })
    ).toBe(true);
  });

  it("reads production_countries JP the same as origin_country", () => {
    expect(
      isTmdbAnimeTitle({
        genreIds: [TMDB_ANIMATION_GENRE_ID],
        originalLanguage: "en",
        productionCountries: [{ iso_3166_1: "JP" }],
      })
    ).toBe(true);
  });
});

describe("keywordsFromTmdbAppend", () => {
  it("reads movie keywords[] and TV results[]", () => {
    expect(
      keywordsFromTmdbAppend({ keywords: [{ name: "anime" }] })
    ).toEqual(["anime"]);
    expect(
      keywordsFromTmdbAppend({ results: [{ name: "seinen" }] })
    ).toEqual(["seinen"]);
  });
});

describe("the Anime shelf", () => {
  const frieren = { id: 1, genre_ids: [16, 10759], original_language: "ja", origin_country: ["JP"] };
  const linkClick = { id: 2, genre_ids: [16, 9648], original_language: "zh", origin_country: ["CN"] };
  const arcane = { id: 3, genre_ids: [16, 10765], original_language: "en", origin_country: ["US"] };
  const shogun = { id: 4, genre_ids: [18, 10768], original_language: "ja", origin_country: ["US"] };
  const squidGame = { id: 5, genre_ids: [10759, 9648], original_language: "ko", origin_country: ["KR"] };

  it("holds Chinese and Korean animation along with Japanese anime", () => {
    expect(belongsOnAnimeShelf({ genreIds: linkClick.genre_ids, originalLanguage: "zh" })).toBe(true);
    expect(belongsOnAnimeShelf({ genreIds: [16], originalLanguage: "ko" })).toBe(true);
    expect(belongsOnAnimeShelf({ genreIds: frieren.genre_ids, originalLanguage: "ja" })).toBe(true);
  });

  it("does not change how a title is played: donghua is not anime to the player", () => {
    expect(isTmdbAnimeTitle({ genreIds: linkClick.genre_ids, originalLanguage: "zh", originCountry: ["CN"] })).toBe(false);
  });

  it("leaves Western animation and East Asian live action in the general lists", () => {
    expect(withoutAnimeTitles([frieren, linkClick, arcane, shogun, squidGame]).map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it("keeps titles that carry no genre or language at all", () => {
    const bare = { id: 9, genre_ids: undefined };
    expect(withoutAnimeTitles([bare])).toEqual([bare]);
  });
});

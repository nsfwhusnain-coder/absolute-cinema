/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { heroPicks, isShowcaseWorthy, showcase, withoutAdultTitles } from "./tmdb-filters";

describe("withoutAdultTitles", () => {
  it("keeps titles that are not flagged adult, including Animation", () => {
    const rows = [
      { id: 1, title: "Spirited Away", adult: false, genre_ids: [16] },
      { id: 2, title: "Frozen", genre_ids: [16] },
      { id: 3, title: "Fight Club", adult: false },
    ];
    expect(withoutAdultTitles(rows, true)).toEqual(rows);
  });

  it("drops only adult === true when the household filter is on", () => {
    const rows = [
      { id: 1, title: "Normal", adult: false },
      { id: 2, title: "Missing flag" },
      { id: 3, title: "Adult", adult: true },
    ];
    expect(withoutAdultTitles(rows, true).map((row) => row.id)).toEqual([1, 2]);
  });

  it("passes the catalog through when the filter is off", () => {
    const rows = [{ id: 3, title: "Adult", adult: true }];
    expect(withoutAdultTitles(rows, false)).toEqual(rows);
  });
});

describe("showcase", () => {
  const art = { backdrop_path: "/b.jpg", poster_path: "/p.jpg" };
  it("keeps popular, well-rated titles with artwork", () => {
    const rows = [
      { id: 1, ...art, vote_average: 8.1, vote_count: 5000 },
      { id: 2, ...art, vote_average: 5.9, vote_count: 900 },
      { id: 3, ...art, vote_average: 9.0, vote_count: 12 },
      { id: 4, backdrop_path: null, poster_path: "/p.jpg", vote_average: 8, vote_count: 900 },
    ];
    expect(showcase(rows, "movie").map((r) => r.id)).toEqual([1]);
  });

  it("uses a lower vote floor for series", () => {
    const row = { ...art, vote_average: 7.4, vote_count: 150 };
    expect(isShowcaseWorthy(row, "tv")).toBe(true);
    expect(isShowcaseWorthy(row, "movie")).toBe(false);
  });

  it("fills the banner with big hits, then showcase titles", () => {
    const rows = [
      { id: 1, ...art, media_type: "movie", vote_average: 7.0, vote_count: 400 },
      { id: 2, ...art, media_type: "tv", vote_average: 8.4, vote_count: 3000 },
      { id: 3, ...art, media_type: "movie", vote_average: 4.0, vote_count: 400 },
    ];
    expect(heroPicks(rows, 2).map((r) => r.id)).toEqual([2, 1]);
  });
});

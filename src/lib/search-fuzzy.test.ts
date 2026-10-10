/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { CLOSE_ENOUGH, closestMatches, editDistance, queryVariants, searchWords, titleSimilarity } from "./search-fuzzy";

describe("searchWords", () => {
  it("drops case, accents and punctuation", () => {
    expect(searchWords("Amélie: Le Fabuleux Destin!")).toEqual(["amelie", "le", "fabuleux", "destin"]);
    expect(searchWords("Spider-Man  2")).toEqual(["spider", "man", "2"]);
  });
});

describe("queryVariants", () => {
  it("cuts the last word short, where TMDB can complete it", () => {
    expect(queryVariants("intersteller")).toEqual(["interstelle", "interstell", "inters"]);
  });

  it("leaves one word out at a time, and joins two words into one", () => {
    const variants = queryVariants("the drak knight");
    expect(variants).toContain("the knight");
    expect(variants).toContain("drak knight");
    expect(queryVariants("inter stellar")).toContain("interstellar");
  });

  it("never asks for a two-letter prefix, the query itself, or more than six forms", () => {
    expect(queryVariants("up")).toEqual([]);
    expect(queryVariants("dune")).toEqual(["dun"]);
    expect(queryVariants("the lord of the rings the two towers").length).toBeLessThanOrEqual(6);
    expect(queryVariants("")).toEqual([]);
  });
});

describe("editDistance", () => {
  it("counts a swap of two neighbours as one edit", () => {
    expect(editDistance("inception", "inception")).toBe(0);
    expect(editDistance("inseption", "inception")).toBe(1);
    expect(editDistance("oppenhiemer", "oppenheimer")).toBe(1);
    expect(editDistance("avangers", "avengers")).toBe(1);
    expect(editDistance("", "dune")).toBe(4);
  });
});

describe("titleSimilarity", () => {
  it("is high for a misspelling of the title, whatever else the title carries", () => {
    expect(titleSimilarity("avangers", "Avengers: Endgame")).toBeGreaterThan(CLOSE_ENOUGH);
    expect(titleSimilarity("intersteller", "Interstellar")).toBeGreaterThan(CLOSE_ENOUGH);
    expect(titleSimilarity("the drak knight", "The Dark Knight Rises")).toBeGreaterThan(CLOSE_ENOUGH);
    expect(titleSimilarity("braking bad", "Breaking Bad")).toBeGreaterThan(CLOSE_ENOUGH);
    expect(titleSimilarity("spiderman", "Spider-Man: No Way Home")).toBeGreaterThan(CLOSE_ENOUGH);
  });

  it("is low for a different title", () => {
    expect(titleSimilarity("intersteller", "Internal Affairs")).toBeLessThan(CLOSE_ENOUGH);
    expect(titleSimilarity("avangers", "Avatar")).toBeLessThan(CLOSE_ENOUGH);
    expect(titleSimilarity("xqzv", "Dune")).toBeLessThan(CLOSE_ENOUGH);
  });

  it("does not let a leading article decide", () => {
    expect(titleSimilarity("the godfathr", "The Godfather")).toBeGreaterThan(CLOSE_ENOUGH);
    expect(titleSimilarity("the godfathr", "The Batman")).toBeLessThan(CLOSE_ENOUGH);
  });
});

describe("closestMatches", () => {
  const rows = [
    { id: 1, media_type: "movie", title: "Avatar", popularity: 900 },
    { id: 2, media_type: "movie", title: "Avengers: Endgame", popularity: 500 },
    { id: 3, media_type: "movie", title: "The Avengers", popularity: 700 },
    { id: 3, media_type: "movie", title: "The Avengers", popularity: 700 },
    { id: 4, media_type: "tv", name: "Avenue 5", popularity: 50 },
  ];

  it("keeps only the close ones, closest first and the more popular first among equals, each once", () => {
    expect(closestMatches("avangers", rows).map((row) => row.id)).toEqual([3, 2]);
  });

  it("finds nothing for nonsense", () => {
    expect(closestMatches("zzqqxx", rows)).toEqual([]);
  });

  it("reads a show's name and a title's original name", () => {
    expect(closestMatches("avenu 5", rows).map((row) => row.id)).toEqual([4]);
    expect(closestMatches("amelie", [{ id: 9, title: "Amélie", original_title: "Le Fabuleux Destin d'Amélie Poulain" }]).length).toBe(1);
  });
});

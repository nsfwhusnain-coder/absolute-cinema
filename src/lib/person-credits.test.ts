import { describe, expect, it } from "bun:test";
import type { TmdbPersonCredit } from "@/lib/tmdb";
import { isAppearanceCredit, pickFeaturedCredit } from "./person-credits";

const credit = (over: Partial<TmdbPersonCredit>): TmdbPersonCredit => ({
  id: 1,
  poster_path: "/p.jpg",
  media_type: "movie",
  ...over,
});

describe("person credits", () => {
  it("treats talk shows and self appearances as appearances", () => {
    expect(isAppearanceCredit(credit({ media_type: "tv", genre_ids: [10767] }))).toBe(true);
    expect(isAppearanceCredit(credit({ character: "Self - Guest" }))).toBe(true);
    expect(isAppearanceCredit(credit({ character: "Paul Atreides", genre_ids: [878] }))).toBe(false);
  });

  it("features a known film over a more 'popular' talk show", () => {
    const talk = credit({ id: 2, name: "The Late Show", media_type: "tv", genre_ids: [10767], popularity: 400, vote_count: 300 });
    const dune = credit({ id: 3, title: "Dune", character: "Paul Atreides", popularity: 60, vote_count: 14000, vote_average: 7.8 });
    const indie = credit({ id: 4, title: "Small Film", character: "Lead", popularity: 90, vote_count: 40 });
    expect(pickFeaturedCredit([talk, indie, dune])?.id).toBe(3);
  });

  it("falls back to appearances when that is all there is", () => {
    const talk = credit({ id: 2, media_type: "tv", genre_ids: [10767] });
    expect(pickFeaturedCredit([talk])?.id).toBe(2);
    expect(pickFeaturedCredit([])).toBeNull();
  });
});

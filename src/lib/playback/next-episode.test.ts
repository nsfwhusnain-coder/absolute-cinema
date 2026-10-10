/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { resolveNextEpisode } from "./next-episode";

const GOT = [
  { season_number: 0, episode_count: 3 },
  { season_number: 1, episode_count: 10 },
  { season_number: 2, episode_count: 10 },
];

describe("resolveNextEpisode", () => {
  it("moves to the next episode in the season", () => {
    expect(resolveNextEpisode(GOT, 1, 3)).toEqual({ season: 1, episode: 4 });
  });

  it("rolls over to the first episode of the next season", () => {
    expect(resolveNextEpisode(GOT, 1, 10)).toEqual({ season: 2, episode: 1 });
  });

  it("ends at the end of the series", () => {
    expect(resolveNextEpisode(GOT, 2, 10)).toBeNull();
  });

  it("stays inside Specials, and never jumps from Specials into Season 1", () => {
    expect(resolveNextEpisode(GOT, 0, 1)).toEqual({ season: 0, episode: 2 });
    expect(resolveNextEpisode(GOT, 0, 3)).toBeNull();
    expect(resolveNextEpisode(GOT, 0, 150)).toBeNull();
  });

  it("never offers an episode that has not aired", () => {
    const raw = [{ season_number: 34, episode_count: 43 }];
    const lastAired = { season_number: 34, episode_number: 40 };
    expect(resolveNextEpisode(raw, 34, 39, lastAired)).toEqual({ season: 34, episode: 40 });
    expect(resolveNextEpisode(raw, 34, 40, lastAired)).toBeNull();
  });

  it("does not roll into an announced season with nothing aired", () => {
    const show = [
      { season_number: 1, episode_count: 8 },
      { season_number: 2, episode_count: 8 },
    ];
    expect(resolveNextEpisode(show, 1, 8, { season_number: 1, episode_number: 8 })).toBeNull();
    expect(resolveNextEpisode(show, 1, 8, { season_number: 2, episode_number: 1 })).toEqual({ season: 2, episode: 1 });
  });

  it("guesses the next episode in the season before the season list loads", () => {
    expect(resolveNextEpisode(undefined, 1, 3)).toEqual({ season: 1, episode: 4 });
  });
});

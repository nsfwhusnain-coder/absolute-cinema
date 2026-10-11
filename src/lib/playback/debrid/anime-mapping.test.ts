import { describe, expect, it } from "bun:test";
import { absoluteEpisode, locateInChain, type KitsuEntry, entryTitles } from "./anime-mapping";

const chain: Record<number, KitsuEntry> = {
  1: { id: 1, subtype: "TV", episodeCount: 24, sequelIds: [2] },
  2: { id: 2, subtype: "movie", episodeCount: 1, sequelIds: [3] },
  3: { id: 3, subtype: "TV", episodeCount: 23, sequelIds: [4] },
  4: { id: 4, subtype: "TV", episodeCount: null, sequelIds: [] },
};
const load = async (id: number) => chain[id] ?? null;

describe("absoluteEpisode", () => {
  it("sums earlier regular seasons and ignores specials", () => {
    const seasons = [
      { season_number: 0, episode_count: 5 },
      { season_number: 1, episode_count: 24 },
      { season_number: 2, episode_count: 23 },
    ];
    expect(absoluteEpisode(seasons, 1, 3)).toBe(3);
    expect(absoluteEpisode(seasons, 2, 1)).toBe(25);
    expect(absoluteEpisode(seasons, 3, 2)).toBe(49);
  });

  it("keeps episode numbers that are already absolute (One Piece style)", () => {
    const seasons = [
      { season_number: 21, episode_count: 197 },
      { season_number: 22, episode_count: 67 },
    ];
    expect(absoluteEpisode(seasons, 22, 1100)).toBe(1100);
  });
});

describe("locateInChain", () => {
  it("finds the entry and local episode, stepping over non-TV entries", async () => {
    expect(await locateInChain(1, 5, load)).toEqual({ kitsuId: 1, episode: 5 });
    expect(await locateInChain(1, 25, load)).toEqual({ kitsuId: 3, episode: 1 });
    expect(await locateInChain(1, 47, load)).toEqual({ kitsuId: 3, episode: 23 });
  });

  it("uses an airing entry (unknown length) for anything past the known ones", async () => {
    expect(await locateInChain(1, 60, load)).toEqual({ kitsuId: 4, episode: 13 });
  });

  it("gives up when the chain runs out", async () => {
    const short: Record<number, KitsuEntry> = { 9: { id: 9, subtype: "TV", episodeCount: 12, sequelIds: [] } };
    expect(await locateInChain(9, 13, async (id) => short[id] ?? null)).toBeNull();
  });
});

describe("entryTitles", () => {
  it("gathers every name an entry has, once", () => {
    const titles = entryTitles({
      canonicalTitle: "Bleach: Sennen Kessen-hen",
      titles: { en: "Bleach: Thousand-Year Blood War", en_jp: "Bleach: Sennen Kessen-hen", ja_jp: "BLEACH 千年血戦篇", fr_fr: null },
      abbreviatedTitles: ["Bleach TYBW", null],
    });
    expect(titles).toEqual(["Bleach: Sennen Kessen-hen", "Bleach: Thousand-Year Blood War", "BLEACH 千年血戦篇", "Bleach TYBW"]);
    expect(entryTitles({})).toEqual([]);
  });
});

describe("locateInChain, the entry's names", () => {
  it("hands back the names of the entry the episode falls in", async () => {
    const entries: Record<number, KitsuEntry> = {
      1: { id: 1, subtype: "TV", episodeCount: 366, sequelIds: [2], titles: ["Bleach"] },
      2: { id: 2, subtype: "TV", episodeCount: 13, sequelIds: [], titles: ["Bleach: Sennen Kessen-hen"] },
    };
    expect(await locateInChain(1, 369, async (id) => entries[id] ?? null)).toEqual({ kitsuId: 2, episode: 3, titles: ["Bleach: Sennen Kessen-hen"] });
  });
});

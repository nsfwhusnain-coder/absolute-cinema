/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isRefusedLink, isRefusedRelease, refuseLink, refuseRelease, refusedSnapshot, restoreRefused } from "./refused-releases";

describe("refuseRelease", () => {
  const film = { imdbId: "tt0000021", season: 0, episode: 0 };

  it("keeps a release from being offered again as the title it would not play as", () => {
    expect(isRefusedRelease(film, "Some.Film.2020.1080p.BluRay")).toBe(false);
    refuseRelease(film, "Some.Film.2020.1080p.BluRay\n👤 12 💾 4 GB");
    expect(isRefusedRelease(film, "Some.Film.2020.1080p.BluRay")).toBe(true);
    expect(isRefusedRelease(film, "some.film.2020.1080p.bluray")).toBe(true);
  });

  it("holds it against that title and that episode only", () => {
    const pack = "Show.S01.1080p.BluRay.x265";
    refuseRelease({ imdbId: "tt0000022", season: 1, episode: 3 }, pack);
    expect(isRefusedRelease({ imdbId: "tt0000022", season: 1, episode: 4 }, pack)).toBe(false);
    expect(isRefusedRelease({ imdbId: "tt0000023", season: 1, episode: 3 }, pack)).toBe(false);
  });
});

describe("refuseLink", () => {
  it("knows a refused link again, and no other", () => {
    refuseLink("https://cdn.example/dl/abc/Film.2020.mkv");
    expect(isRefusedLink("https://cdn.example/dl/abc/Film.2020.mkv")).toBe(true);
    expect(isRefusedLink("https://cdn.example/dl/abd/Film.2020.mkv")).toBe(false);
  });
});

describe("refusedSnapshot and restoreRefused", () => {
  it("writes down what is refused, and leaves out what has run out", () => {
    refuseLink("https://cdn.example/dl/kept/Film.mkv");
    const later = Date.now() + 91 * 24 * 60 * 60 * 1000;
    expect(refusedSnapshot().links.map(([url]) => url)).toContain("https://cdn.example/dl/kept/Film.mkv");
    expect(refusedSnapshot(later).links).toEqual([]);
  });

  it("takes back a snapshot's live entries and passes over the rest", () => {
    const soon = Date.now() + 60_000;
    restoreRefused({
      releases: [["tt0000031:0:0:restored.film.2021.1080p", soon], ["tt0000031:0:0:lapsed.film.2021.1080p", 1], "junk"],
      links: [["https://cdn.example/dl/restored/Film.mkv", soon], [42, soon]],
    });
    const film = { imdbId: "tt0000031", season: 0, episode: 0 };
    expect(isRefusedRelease(film, "Restored.Film.2021.1080p")).toBe(true);
    expect(isRefusedRelease(film, "Lapsed.Film.2021.1080p")).toBe(false);
    expect(isRefusedLink("https://cdn.example/dl/restored/Film.mkv")).toBe(true);
    expect(() => restoreRefused("not a snapshot")).not.toThrow();
  });
});

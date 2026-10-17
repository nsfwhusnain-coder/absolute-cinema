import { describe, expect, it } from "bun:test";
import { titleKey } from "./title-key";

describe("titleKey", () => {
  it("names a film with no season or episode, whatever a request says of them", () => {
    expect(titleKey({ mediaType: "movie", tmdbId: 550 })).toBe("movie:550:0:0");
    expect(titleKey({ mediaType: "movie", tmdbId: 550, season: 2, episode: 3 })).toBe("movie:550:0:0");
  });

  it("names an episode by its season and episode, and an unknown one as zero", () => {
    expect(titleKey({ mediaType: "tv", tmdbId: 1399, season: 1, episode: 1 })).toBe("tv:1399:1:1");
    expect(titleKey({ mediaType: "tv", tmdbId: 1399, season: null, episode: null })).toBe("tv:1399:0:0");
    expect(titleKey({ mediaType: "tv", tmdbId: 1399 })).toBe("tv:1399:0:0");
  });
});

import { describe, expect, it } from "bun:test";
import { currentsMode, pickScene, sceneWeights } from "./select";

function tally(genres: number[], rolls = 2000) {
  const counts: Record<string, number> = {};
  for (let i = 0; i < rolls; i++) {
    const scene = pickScene(genres, () => (i + 0.5) / rolls);
    counts[scene] = (counts[scene] ?? 0) + 1;
  }
  return counts;
}

describe("loader scene selection", () => {
  it("favours space travel for science fiction", () => {
    const counts = tally([878, 12]);
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0];
    expect(top).toBe("stars");
  });

  it("favours aurora for romance and city lights for crime", () => {
    expect(Object.entries(tally([10749, 18])).sort((a, b) => b[1] - a[1])[0]![0]).toBe("aurora");
    expect(Object.entries(tally([80, 53])).sort((a, b) => b[1] - a[1])[0]![0]).toBe("city");
  });

  it("still gives every scene a chance, even with no genres", () => {
    expect(Object.keys(tally([])).length).toBe(6);
    expect(Object.values(sceneWeights([])).every((w) => w > 0)).toBe(true);
  });

  it("chooses the atmosphere for the film", () => {
    expect(currentsMode([37])).toBe("dust");
    expect(currentsMode([10752])).toBe("embers");
    expect(currentsMode([27])).toBe("mist");
  });
});

import { describe, expect, it } from "bun:test";
import type { PlaybackResponse, PlaybackSource } from "./types";
import { answerFacts } from "./answer-facts";

const source = (provider: string, maxHeight: number | undefined, origin?: "debrid" | "embed"): PlaybackSource =>
  ({ id: `${provider}-${maxHeight}`, url: "https://cdn.example/secret-link.mp4", provider, quality: "auto", type: "mp4", maxHeight, origin }) as PlaybackSource;

describe("answerFacts", () => {
  it("counts what was offered, by service and by height, and keeps no link", () => {
    const facts = answerFacts({
      status: "available",
      partial: true,
      fourKSettled: true,
      debridSettled: false,
      sources: [source("Debrid", 2160, "debrid"), source("Debrid", 1080, "debrid"), source("AllDebrid", 1080, "debrid"), source("Vixsrc", 1080, "embed"), source("Vidrock", undefined)],
    } as PlaybackResponse);
    expect(facts).toEqual({
      status: "available",
      sources: 5,
      debrid: 3,
      web: 2,
      bestHeight: 2160,
      bestDebridHeight: 2160,
      providers: { Debrid: 2, AllDebrid: 1, Vixsrc: 1, Vidrock: 1 },
      partial: true,
      fourKSettled: true,
      debridSettled: false,
    });
    expect(JSON.stringify(facts)).not.toContain("secret-link");
  });

  it("is all zeroes for an answer with nothing in it", () => {
    expect(answerFacts({ status: "error" } as PlaybackResponse)).toEqual({
      status: "error", sources: 0, debrid: 0, web: 0, bestHeight: 0, bestDebridHeight: 0, providers: {}, partial: false,
    });
  });
});

/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { rememberRemuxSession, remuxSessionOrigin } from "./remux-sessions";

const origin = (sourceId: string) => ({ sourceId, title: { mediaType: "movie" as const, tmdbId: 27205 } });

describe("remux sessions", () => {
  it("answers what a session was opened for", () => {
    rememberRemuxSession("a".repeat(24), origin("debrid-tt0000001-movie-0-0-safari-2160"));
    expect(remuxSessionOrigin("a".repeat(24))?.sourceId).toBe("debrid-tt0000001-movie-0-0-safari-2160");
    expect(remuxSessionOrigin("b".repeat(24))).toBeNull();
  });

  it("forgets the oldest sessions first", () => {
    for (let i = 0; i < 250; i++) rememberRemuxSession(`session-${i}`, origin(`source-${i}`));
    expect(remuxSessionOrigin("session-0")).toBeNull();
    expect(remuxSessionOrigin("session-249")?.sourceId).toBe("source-249");
  });
});

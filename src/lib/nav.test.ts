/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isNavPathActive, isPlayerPath } from "./nav";

describe("isPlayerPath", () => {
  it("matches the player's pages", () => {
    expect(isPlayerPath("/watch/movie/157336")).toBe(true);
    expect(isPlayerPath("/watch/tv/1396")).toBe(true);
    expect(isPlayerPath("/watch")).toBe(true);
  });

  it("does not take My List for the player", () => {
    expect(isPlayerPath("/watchlist")).toBe(false);
    expect(isPlayerPath("/")).toBe(false);
  });
});

describe("isNavPathActive", () => {
  it("marks a section active on its own pages only", () => {
    expect(isNavPathActive("/watchlist", "/watchlist")).toBe(true);
    expect(isNavPathActive("/movies", "/")).toBe(false);
    expect(isNavPathActive("/", "/")).toBe(true);
  });
});

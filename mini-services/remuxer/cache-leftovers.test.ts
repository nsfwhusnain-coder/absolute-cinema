import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeCacheLeftovers } from "./cache-leftovers";

describe("removeCacheLeftovers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "remux-cache-"));
    for (const name of ["vod-old1", "vod-old2", "vod-live"]) {
      mkdirSync(join(dir, name, "run-0"), { recursive: true });
      writeFileSync(join(dir, name, "run-0", "0.m4s"), "x");
    }
    writeFileSync(join(dir, "stray.tmp"), "x");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes everything a restart left behind", async () => {
    expect(await removeCacheLeftovers(dir)).toBe(4);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the folders named as live", async () => {
    expect(await removeCacheLeftovers(dir, (name) => name === "vod-live")).toBe(3);
    expect(readdirSync(dir)).toEqual(["vod-live"]);
  });

  it("does nothing, quietly, when the folder is not there", async () => {
    expect(await removeCacheLeftovers(join(dir, "missing"))).toBe(0);
  });
});

import { describe, expect, it } from "bun:test";
import type { PlaybackSource } from "../types";
import { awaitRosterWithSoftDeadline } from "./index";

const source = (id: string, maxHeight: number): PlaybackSource =>
  ({ id, url: `https://cdn.example/${id}.mp4`, provider: "Debrid", quality: `${maxHeight}p`, type: "mp4", maxHeight }) as PlaybackSource;

const never = () => new Promise<{ sources: PlaybackSource[]; candidates: [] }>(() => {});

describe("awaitRosterWithSoftDeadline", () => {
  it("returns the complete roster when it settles first", async () => {
    const full = { sources: [source("a", 2160)], candidates: [] as [] };
    const result = await awaitRosterWithSoftDeadline({ run: Promise.resolve(full), progress: [] }, 1_000);
    expect(result.complete).toBe(true);
    expect(result.sources.map((s) => s.id)).toEqual(["a"]);
  });

  it("answers early with a good partial roster once the soft deadline passes", async () => {
    const progress = [source("hd", 1080), source("hd", 1080), source("sd", 720)];
    const started = Date.now();
    const result = await awaitRosterWithSoftDeadline({ run: never(), progress }, 50);
    expect(result.complete).toBe(false);
    expect(result.sources.map((s) => s.id)).toEqual(["hd", "sd"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("keeps waiting while the partial roster has nothing 1080p or better", async () => {
    const progress = [source("sd", 720)];
    let resolveRun!: (v: { sources: PlaybackSource[]; candidates: [] }) => void;
    const run = new Promise<{ sources: PlaybackSource[]; candidates: [] }>((r) => (resolveRun = r));
    setTimeout(() => resolveRun({ sources: [source("uhd", 2160)], candidates: [] }), 400);
    const result = await awaitRosterWithSoftDeadline({ run, progress }, 50);
    expect(result.complete).toBe(true);
    expect(result.sources[0]!.id).toBe("uhd");
  });
});

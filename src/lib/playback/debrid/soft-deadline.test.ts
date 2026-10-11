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

  it("holds out for a 4K pool that is still hunting when the viewer wants 4K", async () => {
    const entry = { run: never(), progress: [source("hd", 1080)], hunting4k: true };
    setTimeout(() => entry.progress.push(source("uhd", 2160)), 300);
    const result = await awaitRosterWithSoftDeadline(entry, 50, 5_000);
    expect(result.sources.map((s) => s.id)).toContain("uhd");
  });

  it("answers the moment the caller says the start is decided, before the soft deadline", async () => {
    const entry = { run: never(), progress: [source("hd", 1080)], hunting4k: false };
    let decided = false;
    setTimeout(() => entry.progress.push(source("uhd", 2160)), 100);
    setTimeout(() => (decided = true), 150);
    const started = Date.now();
    const result = await awaitRosterWithSoftDeadline(entry, 5_000, 18_000, () => decided);
    expect(result.complete).toBe(false);
    expect(result.sources.map((s) => s.id)).toEqual(["hd", "uhd"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("answers with nothing of its own when the start is decided elsewhere", async () => {
    const entry = { run: never(), progress: [] as PlaybackSource[], hunting4k: false };
    const result = await awaitRosterWithSoftDeadline(entry, 5_000, 18_000, () => true);
    expect(result).toMatchObject({ sources: [], complete: false });
  });

  it("keeps to the soft deadline until the start is decided", async () => {
    const entry = { run: never(), progress: [source("uhd", 2160)], hunting4k: false };
    const started = Date.now();
    await awaitRosterWithSoftDeadline(entry, 400, 18_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
  });

  it("holds a decided start while its own 4K pools are still hunting", async () => {
    const entry = { run: never(), progress: [source("hd", 1080)], hunting4k: true };
    setTimeout(() => (entry.hunting4k = false), 300);
    const started = Date.now();
    await awaitRosterWithSoftDeadline(entry, 5_000, 18_000, () => true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it("returns as soon as the roster settles, not a poll later", async () => {
    let finish!: (v: { sources: PlaybackSource[]; candidates: [] }) => void;
    const run = new Promise<{ sources: PlaybackSource[]; candidates: [] }>((r) => (finish = r));
    const started = Date.now();
    setTimeout(() => finish({ sources: [source("hd", 1080)], candidates: [] }), 20);
    const result = await awaitRosterWithSoftDeadline({ run, progress: [] }, 5_000);
    expect(result.complete).toBe(true);
    expect(Date.now() - started).toBeLessThan(80);
  });

  it("settles for 1080p once the 4K hunt ends empty", async () => {
    const entry = { run: never(), progress: [source("hd", 1080)], hunting4k: true };
    setTimeout(() => (entry.hunting4k = false), 200);
    const started = Date.now();
    const result = await awaitRosterWithSoftDeadline(entry, 50, 5_000);
    expect(result.sources.map((s) => s.id)).toEqual(["hd"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

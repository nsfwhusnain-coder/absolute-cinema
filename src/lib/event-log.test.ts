import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_RETENTION_DAYS, eventFileName, eventLine, eventLogSettled, isExpiredEventFile, recordEvent, viewerTag } from "./event-log";

const NOON = Date.UTC(2026, 9, 11, 12);
const DAY_MS = 86_400_000;

describe("event log names and lines", () => {
  it("names a file for the process that wrote it and the day", () => {
    expect(eventFileName("web", NOON)).toBe("web-2026-10-11.jsonl");
    expect(eventFileName("remux", NOON + DAY_MS)).toBe("remux-2026-10-12.jsonl");
  });

  it("calls a file expired only once it is older than the days kept, and never a file that is not its own", () => {
    expect(isExpiredEventFile(eventFileName("web", NOON - (EVENT_RETENTION_DAYS + 1) * DAY_MS), NOON)).toBe(true);
    expect(isExpiredEventFile(eventFileName("web", NOON - (EVENT_RETENTION_DAYS - 1) * DAY_MS), NOON)).toBe(false);
    expect(isExpiredEventFile("custom.db", NOON)).toBe(false);
    expect(isExpiredEventFile("events-2020-01-01.jsonl", NOON)).toBe(false);
  });

  it("writes the viewer as a tag, never the account id", () => {
    const line = JSON.parse(eventLine("first_frame", { userId: "user-1", sourceId: "s" }, NOON));
    expect(line).toEqual({ at: NOON, event: "first_frame", viewer: viewerTag("user-1"), sourceId: "s" });
    expect(viewerTag("user-1")).toMatch(/^[a-f0-9]{16}$/);
    expect(viewerTag("user-1")).not.toBe(viewerTag("user-2"));
  });

  it("writes no viewer when there is none", () => {
    expect(JSON.parse(eventLine("vod", { message: "open" }, NOON))).toEqual({ at: NOON, event: "vod", message: "open" });
  });
});

describe("recordEvent", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "event-log-"));
    process.env.EVENT_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.EVENT_LOG_DIR;
    delete process.env.EVENT_LOG;
    rmSync(dir, { recursive: true, force: true });
  });
  const lines = (name: string) => readFileSync(join(dir, name), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  it("appends each event in order to the day's file of its process", async () => {
    recordEvent("web", "a", { n: 1 }, NOON);
    recordEvent("web", "b", { n: 2 }, NOON);
    recordEvent("remux", "c", {}, NOON);
    await eventLogSettled();
    expect(lines("web-2026-10-11.jsonl").map((l) => l.event)).toEqual(["a", "b"]);
    expect(lines("remux-2026-10-11.jsonl")).toEqual([{ at: NOON, event: "c" }]);
  });

  it("drops files older than the days kept, and leaves the rest of the folder alone", async () => {
    const old = eventFileName("web", NOON - 40 * DAY_MS);
    for (const name of [old, "notes.txt"]) writeFileSync(join(dir, name), "x\n");
    recordEvent("web", "a", {}, NOON + 2 * 60 * 60 * 1000);
    await eventLogSettled();
    expect(readdirSync(dir).sort()).toEqual(["notes.txt", "web-2026-10-11.jsonl"]);
  });

  it("writes nothing when turned off", async () => {
    process.env.EVENT_LOG = "0";
    recordEvent("web", "a", {}, NOON);
    await eventLogSettled();
    expect(readdirSync(dir)).toEqual([]);
  });
});

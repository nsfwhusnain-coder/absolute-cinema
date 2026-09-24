import { describe, expect, it } from "bun:test";
import { QUARANTINE_FAILURES, QUARANTINE_WINDOW_MS, SourceQuarantine } from "./source-quarantine";

describe("SourceQuarantine", () => {
  it("quarantines a source after repeated failures inside the window", () => {
    const q = new SourceQuarantine();
    for (let i = 1; i < QUARANTINE_FAILURES; i++) expect(q.recordFailure("a", i * 30)).toBe(false);
    expect(q.recordFailure("a", QUARANTINE_FAILURES * 30)).toBe(true);
    expect(q.has("a")).toBe(true);
    expect(q.filter([{ id: "a" }, { id: "b" }])).toEqual([{ id: "b" }]);
  });

  it("forgives failures spread wider than the window", () => {
    const q = new SourceQuarantine();
    for (let i = 0; i < QUARANTINE_FAILURES * 2; i++) {
      expect(q.recordFailure("a", i * (QUARANTINE_WINDOW_MS + 1))).toBe(false);
    }
    expect(q.has("a")).toBe(false);
  });

  it("reset gives every source a fresh chance", () => {
    const q = new SourceQuarantine();
    for (let i = 0; i < QUARANTINE_FAILURES; i++) q.recordFailure("a", i);
    q.reset();
    expect(q.has("a")).toBe(false);
    expect(q.filter([{ id: "a" }])).toEqual([{ id: "a" }]);
  });
});

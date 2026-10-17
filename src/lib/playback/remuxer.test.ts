import { describe, expect, it } from "bun:test";
import { watcherOf } from "./remuxer";

describe("watcherOf", () => {
  it("is stable for a viewer and differs between viewers", () => {
    expect(watcherOf("user-a")).toBe(watcherOf("user-a"));
    expect(watcherOf("user-a")).not.toBe(watcherOf("user-b"));
  });

  it("is short lowercase hex the remuxer accepts, and does not contain the id", () => {
    const watcher = watcherOf("cmrcotjom05p2nq6nf2vraiyz");
    expect(watcher).toMatch(/^[a-f0-9]{12}$/);
    expect(watcher).not.toContain("cmrco");
  });
});

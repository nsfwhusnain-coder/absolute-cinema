/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { swapProfilePrivateData } from "./profile-sync";

class MemoryStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
}

const RECENTS = "absolute-cinema:search-recents";

describe("swapProfilePrivateData", () => {
  it("gives existing data to the first profile seen on this device", () => {
    const s = new MemoryStorage();
    s.setItem(RECENTS, '["dune"]');
    swapProfilePrivateData(s as unknown as Storage, "alice");
    expect(s.getItem(RECENTS)).toBe('["dune"]');
  });

  it("hides one profile's searches from the next, and brings them back", () => {
    const s = new MemoryStorage() as unknown as Storage;
    swapProfilePrivateData(s, "alice");
    s.setItem(RECENTS, '["dune"]');
    swapProfilePrivateData(s, "bob");
    expect(s.getItem(RECENTS)).toBeNull();
    s.setItem(RECENTS, '["bluey"]');
    swapProfilePrivateData(s, "alice");
    expect(s.getItem(RECENTS)).toBe('["dune"]');
    swapProfilePrivateData(s, "bob");
    expect(s.getItem(RECENTS)).toBe('["bluey"]');
  });

  it("does nothing when the same profile signs in again", () => {
    const s = new MemoryStorage() as unknown as Storage;
    swapProfilePrivateData(s, "alice");
    s.setItem(RECENTS, '["x"]');
    swapProfilePrivateData(s, "alice");
    expect(s.getItem(RECENTS)).toBe('["x"]');
  });
});

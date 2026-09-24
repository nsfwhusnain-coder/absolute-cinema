import { describe, expect, it } from "bun:test";
import { legacyStorageMigrationScript, migrateLegacyStorage } from "./storage-migration";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, value); }
}

describe("migrateLegacyStorage", () => {
  it("moves colon and dot prefixed keys to the new prefix", () => {
    const s = new MemoryStorage();
    s.setItem("cinehome:player-volume", "0.4");
    s.setItem("cinehome.tv-mode", "1");
    s.setItem("unrelated", "x");
    expect(migrateLegacyStorage(s)).toBe(2);
    expect(s.getItem("absolute-cinema:player-volume")).toBe("0.4");
    expect(s.getItem("absolute-cinema.tv-mode")).toBe("1");
    expect(s.getItem("cinehome:player-volume")).toBeNull();
    expect(s.getItem("unrelated")).toBe("x");
  });

  it("never overwrites a value already stored under the new key", () => {
    const s = new MemoryStorage();
    s.setItem("cinehome:preferred-quality", "720");
    s.setItem("absolute-cinema:preferred-quality", "2160");
    migrateLegacyStorage(s);
    expect(s.getItem("absolute-cinema:preferred-quality")).toBe("2160");
    expect(s.getItem("cinehome:preferred-quality")).toBeNull();
  });

  it("inline script performs the same migration", () => {
    const s = new MemoryStorage();
    s.setItem("cinehome:watched", "[1]");
    new Function("localStorage", legacyStorageMigrationScript())(s);
    expect(s.getItem("absolute-cinema:watched")).toBe("[1]");
    expect(s.length).toBe(1);
  });
});

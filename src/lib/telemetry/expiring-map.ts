/**
 * A map whose entries expire, and which holds a few thousand at most: what the
 * site keeps for a few minutes about a title (a search's timings, the last
 * summary written for it), without a cache that grows with every title asked.
 *
 * Entries are kept in the order they were set, so when the map is full the
 * oldest go first. Time is a parameter so tests can run it without waiting.
 */
export class ExpiringMap<V> {
  private readonly entries = new Map<string, { value: V; at: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  /** The value set under `key` while it is still live; an expired entry is dropped. */
  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    // Setting a key again moves it to the end, which keeps the map in age order.
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) this.makeRoom(now);
    this.entries.set(key, { value, at: now });
  }

  get size(): number {
    return this.entries.size;
  }

  private makeRoom(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}

/**
 * Lets a key happen at most once per window: the first claim of a key wins and
 * every claim after it, until the window passes, is refused.
 */
export class ClaimSet {
  private readonly claimed: ExpiringMap<true>;

  constructor(windowMs: number, maxEntries: number) {
    this.claimed = new ExpiringMap<true>(windowMs, maxEntries);
  }

  /** True when the key was free, and is now claimed for the window; false while a claim holds it. */
  claim(key: string, now = Date.now()): boolean {
    if (this.claimed.get(key, now)) return false;
    this.claimed.set(key, true, now);
    return true;
  }
}

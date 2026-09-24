/**
 * Segment read-ahead for proxied HLS.
 *
 * hls.js loads one segment at a time. Many embed CDNs take seconds to send the
 * first byte of each segment, so a 6-second 4K segment can cost ~5 seconds to
 * fetch and playback runs barely faster than real time: any hiccup rebuffers.
 * When the player asks for segment N, this starts fetching the next few in the
 * background so their latency overlaps instead of adding up.
 *
 * Safety rules (the reasons an earlier prefetch was switched off):
 *  - never the segment being requested, only the ones after it;
 *  - never byte-range playlists (their "segments" can be a whole .mp4);
 *  - each body is one plain buffer, handed out once and then released — no
 *    Response.clone() tees; memory is capped per session and overall.
 */

export interface ReadAheadBody {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export type SegmentFetcher<S> = (session: S, url: string) => Promise<ReadAheadBody | null>;

interface Entry {
  sessionId: string;
  bytes: number;
  createdAt: number;
  done: Promise<ReadAheadBody | null>;
}

interface Order {
  urls: string[];
  updatedAt: number;
}

export const READ_AHEAD_SEGMENTS = 3;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 384 * 1024 * 1024;
const ENTRY_TTL_MS = 2 * 60 * 1000;
const ORDER_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ORDERS = 200;

export class SegmentReadAhead<S extends { id: string }> {
  private readonly orders = new Map<string, Order>();
  /** Where each segment URL sits in its playlist: `${sessionId} ${url}` → order key + index. */
  private readonly positions = new Map<string, { order: string; index: number }>();
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(
    private readonly fetchSegment: SegmentFetcher<S>,
    private readonly now: () => number = Date.now
  ) {}

  /** Remember a media playlist's segment order. Byte-range and live playlists are ignored. */
  recordPlaylist(sessionId: string, playlistUrl: string, playlist: string, resolve: (uri: string) => string | null): void {
    if (!/#EXT-X-ENDLIST/.test(playlist) || /#EXT-X-BYTERANGE/.test(playlist)) return;
    const urls: string[] = [];
    for (const line of playlist.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const url = resolve(trimmed);
      if (url) urls.push(url);
    }
    if (urls.length < 2) return;
    const orderKey = `${sessionId} ${playlistUrl}`;
    this.orders.set(orderKey, { urls, updatedAt: this.now() });
    urls.forEach((url, index) => this.positions.set(`${sessionId} ${url}`, { order: orderKey, index }));
    this.pruneOrders();
  }

  /** A prefetched (or in-flight) body for this segment, handed out once. */
  take(sessionId: string, url: string): Promise<ReadAheadBody | null> | null {
    const key = `${sessionId} ${url}`;
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    return entry.done;
  }

  /** The player just asked for `url`: fetch the segments after it. */
  schedule(session: S, url: string): void {
    const sessionId = session.id;
    const position = this.positions.get(`${sessionId} ${url}`);
    if (!position) return;
    const order = this.orders.get(position.order);
    if (!order) return;
    order.updatedAt = this.now();
    this.expire();
    for (let i = position.index + 1; i <= position.index + READ_AHEAD_SEGMENTS && i < order.urls.length; i++) {
      const next = order.urls[i]!;
      const key = `${sessionId} ${next}`;
      if (this.entries.has(key)) continue;
      if (this.totalBytes >= MAX_TOTAL_BYTES) return;
      const entry: Entry = { sessionId, bytes: 0, createdAt: this.now(), done: Promise.resolve(null) };
      entry.done = this.fetchSegment(session, next)
        .then((body) => {
          if (!body || body.bytes.byteLength > MAX_SEGMENT_BYTES) {
            this.drop(key, entry);
            return null;
          }
          // Only count bytes while the entry is still waiting to be taken.
          if (this.entries.get(key) === entry) {
            entry.bytes = body.bytes.byteLength;
            this.totalBytes += entry.bytes;
          }
          return body;
        })
        .catch(() => {
          this.drop(key, entry);
          return null;
        });
      this.entries.set(key, entry);
    }
  }

  stats(): { entries: number; bytes: number; playlists: number } {
    return { entries: this.entries.size, bytes: this.totalBytes, playlists: this.orders.size };
  }

  private drop(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  private expire(): void {
    const cutoff = this.now() - ENTRY_TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt < cutoff) this.drop(key, entry);
    }
  }

  private pruneOrders(): void {
    const cutoff = this.now() - ORDER_TTL_MS;
    const stale = [...this.orders.entries()]
      .filter(([, order], i, all) => order.updatedAt < cutoff || all.length - i > MAX_ORDERS)
      .map(([key]) => key);
    if (!stale.length) return;
    const gone = new Set(stale);
    stale.forEach((key) => this.orders.delete(key));
    for (const [key, position] of this.positions) if (gone.has(position.order)) this.positions.delete(key);
  }
}

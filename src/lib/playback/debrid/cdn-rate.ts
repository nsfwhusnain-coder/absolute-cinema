/**
 * How fast each debrid service's CDN is delivering, measured from here.
 *
 * The services are not equal, and not steady: measured side by side from one
 * server on one evening, one delivered 43 to 49 Mbit/s and the other 2.5 to
 * 8.7. A 4K file on the slow one opens late and then stalls, and nothing in
 * a release's name says which CDN will carry it. A link the roster already
 * holds is read for a few seconds now and then, and the rate travels with
 * each of that service's sources so the player can rank a file its CDN cannot
 * carry behind one that plays.
 */

import type { PlaybackSource } from "../types";
import type { DebridProvider } from "./cached-stream";
import { parseDebridPlaybackSourceId } from "./debrid-source-id";

/** How often a service in use is measured again. */
const MEASURE_EVERY_MS = 10 * 60 * 1000;
/** The best rate in this long is the service's: one reading taken while someone is watching says less of the CDN than of the line. */
const BEST_OF_MS = 30 * 60 * 1000;
/** A CDN delivers almost nothing for the first two seconds of a request; the rate is taken from what arrives after them. */
const SETTLE_MS = 2_500;
const MEASURE_FOR_MS = 5_500;
const MEASURE_MAX_BYTES = 64 * 1024 * 1024;
/** Read from a little way in: past the header every other reader of the file is asking for. */
const MEASURE_FROM_BYTE = 32 * 1024 * 1024;
const MS_PER_SECOND = 1000;
/** Nothing is read off a CDN under test. */
const MEASURES = process.env.NODE_ENV !== "test";

interface Reading {
  bytesPerSec: number;
  at: number;
}

const readings = new Map<DebridProvider, Reading[]>();
const lastStarted = new Map<DebridProvider, number>();

/**
 * Reads a link for a few seconds and returns the rate it settled at, in
 * bytes per second. Null when the link would not be read, or ended before
 * the rate could settle.
 */
export async function measureCdnRate(url: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      headers: { Range: `bytes=${MEASURE_FROM_BYTE}-` },
      signal: AbortSignal.timeout(MEASURE_FOR_MS + SETTLE_MS),
    });
    const reader = res.ok ? res.body?.getReader() : undefined;
    if (!reader) return null;
    let total = 0;
    let settled: { at: number; total: number } | null = null;
    for (;;) {
      const elapsed = Date.now() - started;
      if (!settled && elapsed >= SETTLE_MS) settled = { at: elapsed, total };
      if (elapsed >= MEASURE_FOR_MS || total >= MEASURE_MAX_BYTES) break;
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    const elapsed = Date.now() - started;
    if (!settled || elapsed <= settled.at) return null;
    return ((total - settled.total) * MS_PER_SECOND) / (elapsed - settled.at);
  } catch {
    return null;
  }
}

/** Notes a reading for a service (and drops the ones too old to count). */
export function recordCdnRate(provider: DebridProvider, bytesPerSec: number, now = Date.now()): void {
  const kept = (readings.get(provider) ?? []).filter((reading) => now - reading.at < BEST_OF_MS);
  readings.set(provider, [...kept, { bytesPerSec, at: now }]);
}

/** The rate a service's CDN has shown it can deliver, in bytes per second. Null when it has not been measured lately. */
export function cdnRate(provider: DebridProvider, now = Date.now()): number | null {
  const recent = (readings.get(provider) ?? []).filter((reading) => now - reading.at < BEST_OF_MS);
  return recent.length ? Math.max(...recent.map((reading) => reading.bytesPerSec)) : null;
}

/**
 * Each debrid source with what its service's CDN can deliver, as last
 * measured. Done as an answer goes out, not as its sources are made: an
 * answer is kept for minutes, and a rate measured since it was made is the
 * reason the next viewer should start somewhere else.
 */
export function withCdnRates<T extends PlaybackSource>(sources: readonly T[], now = Date.now()): T[] {
  return sources.map((source) => {
    const provider = source.origin === "debrid" ? parseDebridPlaybackSourceId(source.id)?.provider : undefined;
    const rate = provider ? cdnRate(provider, now) : null;
    return { ...source, cdnBytesPerSec: rate === null ? undefined : Math.round(rate) };
  });
}

/**
 * Called with each link a roster offers: measures that service's CDN in the
 * background when it has not been measured for a while. Never waited on.
 */
export function noteCdnLink(provider: DebridProvider, url: string, now = Date.now()): void {
  if (!MEASURES || now - (lastStarted.get(provider) ?? 0) < MEASURE_EVERY_MS) return;
  lastStarted.set(provider, now);
  void measureCdnRate(url).then((rate) => {
    if (rate !== null) recordCdnRate(provider, rate);
    // A link that would not be read says nothing of the CDN: the next roster tries again with another.
    else lastStarted.delete(provider);
  });
}

/**
 * The remuxer's capacity numbers: the container's own network counters, the
 * rates between two samples of them, and how many viewers were heard from
 * lately (docs/TELEMETRY.md, `capacity_snapshot` and the scrape gauges).
 *
 * The parser and the deltas are pure, so they are tested on fixture text and
 * fixed times; reading /proc is the only thing that touches the machine.
 */

import { readFileSync } from "node:fs";

export interface NetworkTotals {
  /** Bytes received and sent by the container's interfaces, loopback left out. */
  rxBytes: number;
  txBytes: number;
}

/**
 * The byte counters of every interface but loopback, from the text of
 * /proc/net/dev. An interface line reads `  eth0: <rx bytes> <rx packets> ... <tx bytes> ...`:
 * received bytes are the first figure after the colon, sent bytes the ninth.
 * The two header lines have no colon after an interface name and are skipped.
 * Null when no interface line is in it at all, so the text is not that file.
 */
export function parseProcNetDev(text: string): NetworkTotals | null {
  let rxBytes = 0;
  let txBytes = 0;
  let interfaces = 0;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (!name || fields.length < 9 || fields.some((n) => !Number.isFinite(n))) continue;
    interfaces++;
    if (name === "lo") continue;
    rxBytes += fields[0]!;
    txBytes += fields[8]!;
  }
  return interfaces > 0 ? { rxBytes, txBytes } : null;
}

/** The container's network counters now, or null when the file is not there (not Linux, or not in a container). */
export function readContainerNetwork(path = "/proc/net/dev"): NetworkTotals | null {
  try {
    return parseProcNetDev(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** What the remuxer was doing at one moment: the counters that rates are taken from. */
export interface CapacitySample {
  /** Epoch ms. */
  at: number;
  rxBytes: number | null;
  txBytes: number | null;
  upstreamBytes: number;
  servedBytes: number;
  /** The process's CPU time so far, user and system together, in seconds. */
  cpuSeconds: number;
}

export interface CapacityRates {
  /** Bits per second, over the interval between the two samples. Null when it cannot be taken. */
  rxBps: number | null;
  txBps: number | null;
  upstreamBps: number | null;
  servedBps: number | null;
  /** Percent of one core. */
  cpuPercent: number | null;
}

/**
 * The change of a counter over `seconds`, as bits per second. Null when it
 * cannot be taken: a counter that is missing, an interval of nothing, or a
 * counter that went back (the container or the process restarted, and its
 * count began again from zero).
 */
export function bitsPerSecond(before: number | null, after: number | null, seconds: number): number | null {
  if (before === null || after === null || !(seconds > 0) || after < before) return null;
  return ((after - before) * 8) / seconds;
}

/** The rates between two samples, each one a delta over the time between them. */
export function capacityRates(before: CapacitySample, now: CapacitySample): CapacityRates {
  const seconds = (now.at - before.at) / 1000;
  const cpuUsed = now.cpuSeconds - before.cpuSeconds;
  return {
    rxBps: bitsPerSecond(before.rxBytes, now.rxBytes, seconds),
    txBps: bitsPerSecond(before.txBytes, now.txBytes, seconds),
    upstreamBps: bitsPerSecond(before.upstreamBytes, now.upstreamBytes, seconds),
    servedBps: bitsPerSecond(before.servedBytes, now.servedBytes, seconds),
    cpuPercent: seconds > 0 && cpuUsed >= 0 ? (cpuUsed / seconds) * 100 : null,
  };
}

/** What one `capacity_snapshot` holds: the state at the snapshot, and the rates over the minute before it. */
export interface CapacityLive {
  sessions: number;
  runs: number;
  pausedRuns: number;
  viewers: number;
  rates: CapacityRates;
  loadAvg1: number;
  rssBytes: number;
  cacheBytes: number;
  /** Free bytes on the cache's disk; Infinity when it cannot be read. */
  diskFreeBytes: number;
}

const whole = (value: number | null): number | null => (value === null || !Number.isFinite(value) ? null : Math.round(value));

/** The fields of a `capacity_snapshot` event (see docs/TELEMETRY.md). Rates are whole bits per second, CPU to a tenth of a percent. */
export function capacitySnapshotFields(live: CapacityLive): Record<string, number | null> {
  const tenths = (value: number | null) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10);
  return {
    sessions: live.sessions,
    runs: live.runs,
    pausedRuns: live.pausedRuns,
    viewers: live.viewers,
    rxBps: whole(live.rates.rxBps),
    txBps: whole(live.rates.txBps),
    upstreamBps: whole(live.rates.upstreamBps),
    servedBps: whole(live.rates.servedBps),
    cpuPercent: tenths(live.rates.cpuPercent),
    loadAvg1: Math.round(live.loadAvg1 * 100) / 100,
    rssBytes: whole(live.rssBytes),
    cacheBytes: whole(live.cacheBytes),
    diskFreeBytes: whole(Number.isFinite(live.diskFreeBytes) ? live.diskFreeBytes : null),
  };
}

/** A viewer counts as watching for this long after their last request. */
export const VIEWER_WINDOW_MS = 30_000;
/** Viewers kept at most; a flood of made-up ids cannot grow the map without bound. */
const MAX_TRACKED_VIEWERS = 10_000;

/** The distinct viewers (watcher ids) heard from in the last VIEWER_WINDOW_MS. */
export class ViewerTracker {
  /** Last request per watcher, oldest first: a watcher who asks again moves to the end. */
  private readonly lastSeen = new Map<string, number>();

  /** A request from `watcher` (an empty id is nobody, and is not kept). */
  touch(watcher: string, now: number): void {
    if (!watcher) return;
    this.lastSeen.delete(watcher);
    this.lastSeen.set(watcher, now);
    while (this.lastSeen.size > MAX_TRACKED_VIEWERS) this.lastSeen.delete(this.lastSeen.keys().next().value!);
  }

  /** How many were heard from in the window ending at `now`. Forgets the ones that were not. */
  count(now: number): number {
    for (const [watcher, at] of this.lastSeen) {
      if (now - at <= VIEWER_WINDOW_MS) break;
      this.lastSeen.delete(watcher);
    }
    return this.lastSeen.size;
  }
}

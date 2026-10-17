/**
 * What the live dashboard (the web app's /hub) reads of the remuxer: a rolling
 * hour of the machine's readings, the moments worth showing as they happen,
 * and how much CPU each ffmpeg run takes. Kept in memory only: the event log
 * and Prometheus are the record; this is the window onto right now.
 */

import { readFileSync } from "node:fs";
import { statCpuSeconds } from "./capacity-signals";

/** One point of the rolling history, every HISTORY_EVERY_MS. */
export interface LivePoint {
  at: number;
  level: number;
  seats: number;
  queue: number;
  /** Viewers the remuxer heard from in the last 30 s. */
  viewers: number;
  cpuCores: number;
  cpuLimitCores: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  temperatureC: number | null;
  loopLagMs: number;
  /** The container's network: received (mostly from CDNs) and sent (mostly to players), bits per second. */
  rxBps: number;
  txBps: number;
}

export const HISTORY_EVERY_MS = 5_000;
/** An hour of points. */
const HISTORY_POINTS = 720;

export class LiveHistory {
  private readonly points: LivePoint[] = [];

  push(point: LivePoint): void {
    this.points.push(point);
    if (this.points.length > HISTORY_POINTS) this.points.shift();
  }

  /** The points of the last `ms` (all of them by default), oldest first. */
  since(ms = Number.POSITIVE_INFINITY, now = Date.now()): LivePoint[] {
    return this.points.filter((p) => now - p.at <= ms);
  }
}

/** A moment for the dashboard's activity feed. */
export interface LiveEvent {
  at: number;
  kind: string;
  [field: string]: unknown;
}

const EVENTS_KEPT = 60;

export class LiveEvents {
  private readonly events: LiveEvent[] = [];

  add(kind: string, fields: Record<string, unknown> = {}, at = Date.now()): void {
    this.events.push({ at, kind, ...fields });
    if (this.events.length > EVENTS_KEPT) this.events.shift();
  }

  /** Newest first. */
  recent(): LiveEvent[] {
    return [...this.events].reverse();
  }
}

/** CPU seconds a process has used, from /proc/<pid>/stat (user and system), or null when it has gone. */
export function processCpuSecondsOf(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    return statCpuSeconds(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The CPU share of each process between two looks, as a fraction of one core:
 * the dashboard asks every couple of seconds, and each look is measured from
 * the one before it.
 */
export class CpuRates {
  private readonly last = new Map<number, { at: number; seconds: number }>();

  rate(pid: number | undefined, now = Date.now()): number | null {
    if (!pid) return null;
    const seconds = processCpuSecondsOf(pid);
    if (seconds === null) {
      this.last.delete(pid);
      return null;
    }
    const before = this.last.get(pid);
    this.last.set(pid, { at: now, seconds });
    if (!before || now <= before.at) return null;
    return Math.max(0, (seconds - before.seconds) / ((now - before.at) / 1000));
  }

  /** Forgets processes not asked about this time (they ended). */
  keepOnly(pids: Set<number>): void {
    for (const pid of this.last.keys()) if (!pids.has(pid)) this.last.delete(pid);
  }
}

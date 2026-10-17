/**
 * The counting behind the player's heartbeats and its end-of-title summary
 * (see docs/TELEMETRY.md, "player_feedback"). Pure: the player reads its
 * element and engine and hands the numbers here. Nothing in this file touches
 * the DOM or the network, so every rule in it is tested directly.
 */

import type { SourceDelivery } from "@/lib/playback/source-quality";
import type { PlaybackSource } from "@/lib/playback/types";

/** What the viewer's file is delivered as: the remuxer, a file the browser opens itself, or a web provider's stream. */
export type PlayerDelivery = "remux" | "native" | "web";
export const PLAYER_DELIVERIES: readonly PlayerDelivery[] = ["remux", "native", "web"];

/** Why a title view ended. `failed` and `ended` take precedence over the reason given when it closed. */
export const SESSION_END_REASONS = ["ended", "left", "failed", "switched"] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * The route a source takes to the screen. Remux is what the server converts;
 * a web provider's HLS or DASH playlist is "web"; any other file the browser
 * opens itself is "native". Mirrors `sourceDelivery`, which decides the route.
 */
export function deliveryOf(delivery: SourceDelivery, type: PlaybackSource["type"]): PlayerDelivery {
  if (delivery === "remux") return "remux";
  return type === "hls" || type === "dash" ? "web" : "native";
}

/** The part of a `TimeRanges` the buffer reading needs. */
export interface BufferedRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * Seconds buffered ahead of `time`: the end of the buffered range that holds
 * it, less the time itself. Zero when no range holds it (a stall, or a jump
 * into unbuffered media).
 */
export function bufferAheadSeconds(buffered: BufferedRanges, time: number): number {
  if (!Number.isFinite(time)) return 0;
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (time >= start && time <= end) return end - time;
  }
  return 0;
}

/**
 * A running total the browser keeps for the life of an element (frames
 * decoded, bytes loaded). Each reading yields what the total rose by since the
 * last one. A total that falls back has restarted, so the whole reading is new.
 * An absent reading (the browser does not say) yields nothing and changes nothing.
 */
export class CounterDelta {
  private last = 0;

  take(total: number | null | undefined): number | null {
    if (total === null || total === undefined || !Number.isFinite(total)) return null;
    const delta = total >= this.last ? total - this.last : total;
    this.last = total;
    return Math.max(0, delta);
  }
}

/**
 * Bits per second for `bytes` moved in `ms` milliseconds, or null when either
 * is unknown or zero: a rate needs both.
 */
export function bitrateBps(bytes: number | null | undefined, ms: number | null | undefined): number | null {
  if (bytes === null || bytes === undefined || ms === null || ms === undefined) return null;
  if (!(bytes > 0) || !(ms > 0)) return null;
  return (bytes * 8 * 1000) / ms;
}

/** The state the player is in, as the element reports it: true while the picture is moving and no one is waiting on it. */
export interface WatchState {
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  buffering: boolean;
}

export function isWatching(state: WatchState): boolean {
  return !state.paused && !state.ended && !state.seeking && !state.buffering;
}

/** The cumulative numbers the player reads at each report. Null means it cannot say. */
export interface PlayerCounters {
  /** Bytes of media fragments loaded so far by hls.js; null for a file the browser loads itself. */
  bytesLoaded: number | null;
  /** Milliseconds spent loading those fragments so far. */
  loadMs: number | null;
  droppedFrames: number | null;
  decodedFrames: number | null;
  /** The picture's height now, to remember the tallest one watched. */
  decodedHeight: number;
}

/** What happened since the previous heartbeat. */
export interface HeartbeatCounts {
  watchedMs: number;
  stalledMs: number;
  stalls: number;
  bytesLoaded: number | null;
  loadMs: number | null;
  droppedFrames: number | null;
  decodedFrames: number | null;
}

/** The whole title view, as the end-of-title summary reports it. */
export interface SessionTotals {
  endReason: SessionEndReason;
  watchedMs: number;
  stalledMs: number;
  stalls: number;
  seeks: number;
  /** Open to first picture; null when the title never started. */
  startupMs: number | null;
  maxHeight: number | null;
  avgBitrateBps: number | null;
  bytesLoaded: number | null;
  sourcesTried: number;
}

interface Pending {
  watchedMs: number;
  stalledMs: number;
  stalls: number;
}

interface Totals {
  watchedMs: number;
  stalledMs: number;
  stalls: number;
  seeks: number;
  bytesLoaded: number | null;
  loadMs: number | null;
}

const span = (from: number, to: number) => Math.max(0, to - from);

/**
 * Keeps the numbers for one title view. Time is in milliseconds since any
 * fixed origin (the caller passes `Date.now()`); what the caller passes in
 * must always be the same clock.
 *
 * Watch time is the time the picture moved. A stall is a wait after the first
 * picture that ends when playback moves again: it is counted once when it
 * starts, and its time is added as it passes, so a heartbeat in the middle of
 * one reports the part so far and the next reports the rest. A jump's own wait
 * and the wait right after one are not stalls (the caller says which waits are
 * eligible), and a pause ends a stall as it ends the viewer's waiting.
 */
export class PlayerTally {
  private watchingSince: number | null = null;
  private stall: { since: number } | null = null;
  private pending: Pending = { watchedMs: 0, stalledMs: 0, stalls: 0 };
  private totals: Totals = { watchedMs: 0, stalledMs: 0, stalls: 0, seeks: 0, bytesLoaded: null, loadMs: null };
  private readonly bytes = new CounterDelta();
  private readonly loadTime = new CounterDelta();
  private readonly dropped = new CounterDelta();
  private readonly decoded = new CounterDelta();
  private started = false;
  private startupMs: number | null = null;
  private maxHeight: number | null = null;
  private readonly sources = new Set<string>();
  private reachedEnd = false;
  private failed = false;

  /** A picture is on screen. `startupMs` is given once per title, for its first picture. */
  picture(startupMs: number | null): void {
    this.started = true;
    this.failed = false;
    if (startupMs !== null && this.startupMs === null) this.startupMs = Math.round(startupMs);
  }

  /** The picture is moving again: watch time runs and any stall ends. */
  playing(now: number): void {
    this.accrue(now);
    this.stall = null;
    this.watchingSince = now;
  }

  /** The picture is not moving because of the viewer or the source: pause, a jump, the end, a new source. */
  halted(now: number): void {
    this.accrue(now);
    this.stall = null;
    this.watchingSince = null;
  }

  /**
   * The element is waiting for data. Not watch time. Starts a stall when the
   * caller says this wait is eligible (after the first picture, not a jump's own wait).
   */
  waiting(now: number, eligible: boolean): void {
    this.accrue(now);
    this.watchingSince = null;
    if (this.stall || !eligible || !this.started) return;
    this.stall = { since: now };
    this.pending.stalls += 1;
  }

  /** Sets watch time on or off from the element's state at a report, without ending a stall in progress. */
  watch(now: number, watching: boolean): void {
    this.accrue(now);
    this.watchingSince = watching ? now : null;
  }

  /** A jump the viewer made. */
  seek(): void {
    this.totals.seeks += 1;
  }

  /** The video reached its end: the view's reason is "ended" whatever comes after. */
  ended(): void {
    this.reachedEnd = true;
  }

  /** Every source has been tried and none played (until a picture comes). */
  markFailed(): void {
    this.failed = true;
  }

  /** A source was attached: the same file again (a re-open) is not a new one. */
  noteSource(sourceId: string): void {
    this.sources.add(sourceId);
  }

  /** Everything counted since the last heartbeat, and the readings' own deltas. The next heartbeat starts from zero. */
  heartbeat(now: number, counters: PlayerCounters): HeartbeatCounts {
    this.accrue(now);
    this.noteHeight(counters.decodedHeight);
    return this.take(counters);
  }

  /** The view is over: closes whatever is still running and totals the view. */
  finish(now: number, counters: PlayerCounters, requested: SessionEndReason): SessionTotals {
    this.accrue(now);
    this.watchingSince = null;
    this.stall = null;
    this.noteHeight(counters.decodedHeight);
    this.take(counters);
    const t = this.totals;
    return {
      endReason: this.reachedEnd ? "ended" : this.failed ? "failed" : requested,
      watchedMs: Math.round(t.watchedMs),
      stalledMs: Math.round(t.stalledMs),
      stalls: t.stalls,
      seeks: t.seeks,
      startupMs: this.startupMs,
      maxHeight: this.maxHeight,
      avgBitrateBps: this.averageBitrate(),
      bytesLoaded: t.bytesLoaded === null ? null : Math.round(t.bytesLoaded),
      sourcesTried: this.sources.size,
    };
  }

  /** Adds the time since the last accrual to what is running, and moves its start to `now`. */
  private accrue(now: number): void {
    if (this.watchingSince !== null) {
      this.pending.watchedMs += span(this.watchingSince, now);
      this.watchingSince = now;
    }
    if (this.stall) {
      this.pending.stalledMs += span(this.stall.since, now);
      this.stall.since = now;
    }
  }

  private noteHeight(height: number): void {
    if (height > 0) this.maxHeight = Math.max(this.maxHeight ?? 0, height);
  }

  private take(counters: PlayerCounters): HeartbeatCounts {
    const pending = this.pending;
    this.pending = { watchedMs: 0, stalledMs: 0, stalls: 0 };
    const bytes = this.bytes.take(counters.bytesLoaded);
    const loadMs = this.loadTime.take(counters.loadMs);
    this.totals.watchedMs += pending.watchedMs;
    this.totals.stalledMs += pending.stalledMs;
    this.totals.stalls += pending.stalls;
    if (bytes !== null) this.totals.bytesLoaded = (this.totals.bytesLoaded ?? 0) + bytes;
    if (loadMs !== null) this.totals.loadMs = (this.totals.loadMs ?? 0) + loadMs;
    return {
      watchedMs: Math.round(pending.watchedMs),
      stalledMs: Math.round(pending.stalledMs),
      stalls: pending.stalls,
      bytesLoaded: bytes,
      loadMs: loadMs === null ? null : Math.round(loadMs),
      droppedFrames: this.dropped.take(counters.droppedFrames),
      decodedFrames: this.decoded.take(counters.decodedFrames),
    };
  }

  private averageBitrate(): number | null {
    const bps = bitrateBps(this.totals.bytesLoaded, this.totals.loadMs);
    return bps === null ? null : Math.round(bps);
  }
}

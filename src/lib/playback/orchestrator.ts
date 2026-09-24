/**
 * Source orchestration for the player — a small, pure state machine.
 *
 * Rules (the "it just plays" contract):
 *  - Start on the best source that can play on this device. While the search
 *    is still running and only low-quality or known-unreliable sources have
 *    turned up, wait a few seconds for a better one: whatever starts is kept
 *    for the whole title.
 *  - Once a source is playing it stays: new sources arriving, better ones
 *    included, never cause an automatic switch.
 *  - An error while playing (a dropped connection, a decode hiccup) first
 *    retries the SAME source at the same position, twice, before moving on.
 *  - A stall (buffering that does not recover) means the server is too slow:
 *    playback moves straight to the next comparable source at the same
 *    position, and only retries the same one when there is nothing else.
 *  - A failed source cools down for a while; it is never marked permanently
 *    dead, and one that already played in this session cools down briefly.
 *  - A source the viewer picked by hand is honoured; if it fails, playback
 *    falls back automatically and says so.
 *
 * The component feeds events in and executes the returned command.
 */

import type { PlaybackSource } from "./types";

export type Phase = "resolving" | "starting" | "playing" | "recovering" | "failed";

export const START_FAIL_COOLDOWN_MS = 90_000;
export const PLAYED_FAIL_COOLDOWN_MS = 30_000;
export const SAME_SOURCE_RETRIES = 2;
/** Longest a start waits for a better source than the ones found so far. */
export const LOW_QUALITY_GRACE_MS = 5_000;
/**
 * With a 4K target the wait is longer: the loading scene covers it, and the
 * server's 4K hunt (placeholder-heavy on Real-Debrid) needs time to finish.
 * Starting 1080p early is what made one episode 4K and the next not.
 */
export const FOUR_K_GRACE_MS = 20_000;

export interface SourceHealth {
  failures: number;
  lastFailAt: number;
  played: boolean;
}

export interface OrchestratorState {
  phase: Phase;
  activeId: string | null;
  health: Record<string, SourceHealth>;
  /** Same-source retries spent in the current incident. */
  retries: number;
  /** Viewer picked the active source by hand. */
  pinned: boolean;
  /** True once any source has shown a frame for this title. */
  everPlayed: boolean;
  /** Last user-visible reason for a failure/switch. */
  lastReason: string | null;
  /** A better source already replaced the one being started once. */
  upgradedBeforeStart: boolean;
  /** When the first playable source turned up (for the low-quality grace). */
  firstCandidateAt: number | null;
}

export type Command =
  | { type: "attach"; sourceId: string; keepPosition: boolean; refresh: boolean; notice?: string }
  | { type: "wait"; recheckInMs?: number }
  | { type: "fail"; message: string }
  | { type: "none" };

export interface Ranker {
  /** Best source to start among `candidates` (already filtered for health). */
  pick(candidates: readonly PlaybackSource[]): PlaybackSource | null;
  /** Height worth waiting briefly for when only lower ones have been found. */
  targetHeight?: number;
  /** Known-unreliable sources are also worth waiting briefly to replace. */
  isSuspect?(source: PlaybackSource): boolean;
}

export const initialOrchestratorState: OrchestratorState = {
  phase: "resolving",
  activeId: null,
  health: {},
  retries: 0,
  pinned: false,
  everPlayed: false,
  lastReason: null,
  upgradedBeforeStart: false,
  firstCandidateAt: null,
};

export function isCoolingDown(health: SourceHealth | undefined, now: number): boolean {
  if (!health || health.failures === 0) return false;
  const cooldown = health.played ? PLAYED_FAIL_COOLDOWN_MS : START_FAIL_COOLDOWN_MS;
  return now - health.lastFailAt < cooldown;
}

function eligible(state: OrchestratorState, sources: readonly PlaybackSource[], now: number, exclude?: string | null) {
  return sources.filter((s) => s.id !== exclude && !isCoolingDown(state.health[s.id], now));
}

function recordFailure(state: OrchestratorState, id: string, now: number): Record<string, SourceHealth> {
  const prev = state.health[id] ?? { failures: 0, lastFailAt: 0, played: false };
  return { ...state.health, [id]: { ...prev, failures: prev.failures + 1, lastFailAt: now } };
}

function heightOf(source: PlaybackSource): number {
  if (source.maxHeight && source.maxHeight > 0) return source.maxHeight;
  const parsed = Number.parseInt(source.quality, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function label(source: PlaybackSource | undefined): string {
  return source?.label?.split("•")[0]?.trim() || source?.provider || "another server";
}

export interface Transition {
  state: OrchestratorState;
  command: Command;
}

/** New roster (sources list). Starts playback when nothing is running yet; never switches a running source. */
export function onRoster(
  state: OrchestratorState,
  sources: readonly PlaybackSource[],
  discovering: boolean,
  ranker: Ranker,
  now: number
): Transition {
  if (state.phase === "resolving" || state.phase === "failed") {
    const best = ranker.pick(eligible(state, sources, now));
    const weak = best && (heightOf(best) < (ranker.targetHeight ?? 0) || ranker.isSuspect?.(best) === true);
    if (best && weak && discovering && state.phase === "resolving" && !state.everPlayed) {
      const since = state.firstCandidateAt ?? now;
      const grace = (ranker.targetHeight ?? 0) >= 2160 ? FOUR_K_GRACE_MS : LOW_QUALITY_GRACE_MS;
      const left = grace - (now - since);
      if (left > 0) return { state: { ...state, firstCandidateAt: since }, command: { type: "wait", recheckInMs: left } };
    }
    if (best) {
      return {
        state: { ...state, phase: "starting", activeId: best.id, retries: 0, lastReason: null },
        command: { type: "attach", sourceId: best.id, keepPosition: state.everPlayed, refresh: false },
      };
    }
    if (!discovering && sources.length > 0 && state.phase !== "failed") {
      return { state: { ...state, phase: "failed" }, command: { type: "fail", message: failureMessage(state) } };
    }
    if (!discovering && sources.length === 0) {
      return {
        state: { ...state, phase: "failed" },
        command: { type: "fail", message: "No streams were found for this title." },
      };
    }
    return { state, command: { type: "wait" } };
  }
  // The active source vanished from a refreshed roster before it started.
  if (state.phase === "starting" && state.activeId && !sources.some((s) => s.id === state.activeId)) {
    return onStartFailed(state, sources, "source withdrawn", discovering, ranker, now);
  }
  // Nothing is on screen yet, so a clearly better source that has just
  // arrived can replace the one still loading at no cost. Once only, and
  // never after the first frame or against the viewer's own pick.
  if (state.phase === "starting" && !state.everPlayed && !state.pinned && !state.upgradedBeforeStart && state.activeId) {
    const active = sources.find((s) => s.id === state.activeId);
    const best = ranker.pick(eligible(state, sources, now));
    if (active && best && best.id !== active.id && heightOf(best) > heightOf(active)) {
      return {
        state: { ...state, activeId: best.id, upgradedBeforeStart: true },
        command: { type: "attach", sourceId: best.id, keepPosition: false, refresh: false },
      };
    }
  }
  return { state, command: { type: "none" } };
}

export function onFirstFrame(state: OrchestratorState): OrchestratorState {
  const health = { ...state.health };
  if (state.activeId) health[state.activeId] = { failures: 0, lastFailAt: 0, played: true };
  return { ...state, phase: "playing", retries: 0, everPlayed: true, health, lastReason: null };
}

/** The active source never produced a frame (timeout or fatal error while starting). */
export function onStartFailed(
  state: OrchestratorState,
  sources: readonly PlaybackSource[],
  reason: string,
  discovering: boolean,
  ranker: Ranker,
  now: number
): Transition {
  const failedId = state.activeId;
  const health = failedId ? recordFailure(state, failedId, now) : state.health;
  const next: OrchestratorState = { ...state, health, pinned: false, lastReason: reason };
  const failedSource = sources.find((s) => s.id === failedId);
  const best = ranker.pick(eligible(next, sources, now, failedId));
  if (best) {
    return {
      state: { ...next, phase: "starting", activeId: best.id, retries: 0 },
      command: {
        type: "attach",
        sourceId: best.id,
        keepPosition: state.everPlayed,
        refresh: false,
        notice: state.pinned ? `${label(failedSource)} didn't load — switched to ${label(best)}` : undefined,
      },
    };
  }
  if (discovering) {
    return { state: { ...next, phase: "resolving", activeId: null }, command: { type: "wait" } };
  }
  return {
    state: { ...next, phase: "failed", activeId: null },
    command: { type: "fail", message: failureMessage(next) },
  };
}

/** A fatal error or unrecoverable stall after the active source had been playing. */
export function onPlaybackError(
  state: OrchestratorState,
  sources: readonly PlaybackSource[],
  reason: string,
  ranker: Ranker,
  now: number,
  kind: "error" | "stall" = "error"
): Transition {
  const id = state.activeId;
  if (!id) return { state, command: { type: "none" } };
  const alternative = ranker.pick(eligible(state, sources, now, id));
  const retryFirst = kind === "error" || !alternative;
  if (retryFirst && state.retries < SAME_SOURCE_RETRIES) {
    return {
      state: { ...state, phase: "recovering", retries: state.retries + 1, lastReason: reason },
      command: { type: "attach", sourceId: id, keepPosition: true, refresh: state.retries > 0 },
    };
  }
  const health = recordFailure(state, id, now);
  const next: OrchestratorState = { ...state, health, retries: 0, pinned: false, lastReason: reason };
  const current = sources.find((s) => s.id === id);
  const best = kind === "stall" ? alternative : ranker.pick(eligible(next, sources, now, id));
  if (best) {
    return {
      state: { ...next, phase: "starting", activeId: best.id },
      command: {
        type: "attach",
        sourceId: best.id,
        keepPosition: true,
        refresh: false,
        notice:
          kind === "stall"
            ? `${label(current)} was too slow — continuing on ${label(best)}`
            : `${label(current)} stopped responding — continuing on ${label(best)}`,
      },
    };
  }
  // Nothing else to try: keep retrying this one rather than giving up while
  // it recently worked.
  return {
    state: { ...next, phase: "recovering" },
    command: { type: "attach", sourceId: id, keepPosition: true, refresh: true },
  };
}

/** The viewer chose a specific source. */
export function onUserSelect(state: OrchestratorState, sourceId: string): Transition {
  return {
    state: {
      ...state,
      phase: "starting",
      activeId: sourceId,
      pinned: true,
      retries: 0,
      health: { ...state.health, [sourceId]: { failures: 0, lastFailAt: 0, played: state.health[sourceId]?.played ?? false } },
    },
    command: { type: "attach", sourceId, keepPosition: true, refresh: false },
  };
}

/** "Try again" after a hard failure: forget cooldowns and start over. */
export function onRetryAll(state: OrchestratorState): OrchestratorState {
  return { ...state, phase: "resolving", activeId: null, health: {}, retries: 0, pinned: false, upgradedBeforeStart: false, firstCandidateAt: null };
}

/** Wait for a refreshed roster instead of failing (sources that failed stay cooled down). */
export function onAwaitRefresh(state: OrchestratorState): OrchestratorState {
  return { ...state, phase: "resolving", activeId: null };
}

function failureMessage(state: OrchestratorState): string {
  return state.everPlayed
    ? "Playback stopped and no other server could continue it."
    : "None of the servers for this title would play.";
}

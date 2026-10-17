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
/**
 * How long a source has to play after an error before its retries are given
 * back. A file this device cannot decode steadily shows a frame after every
 * recovery and fails again a second later: counted afresh each time, it was
 * retried without end (seen: eighteen times in 35 seconds), which is what
 * "plays a bit, then buffers" looks like from the sofa.
 */
export const RETRIES_FORGIVEN_AFTER_MS = 60_000;
/**
 * Longest a start waits for a better source than the best one found so far,
 * counted from when the player first asked. Debrid's 4K and good 1080p files
 * come late (the server's 4K hunt is placeholder-heavy on Real-Debrid), and a
 * web stream that turns up a few seconds early is no reason to start it.
 * Starting 1080p early is what made one episode 4K and the next not.
 */
export const START_WAIT_MS = 20_000;
/**
 * Once debrid has settled nothing better can come from it, so only the web
 * providers' slow tail is still worth waiting for: a short wait is enough.
 */
export const LOW_QUALITY_GRACE_MS = 5_000;
/** A start at this height waits for nothing once no better tier can come. */
const GOOD_START_HEIGHT = 1080;

/** What the server says can still arrive from the debrid services. */
export interface Outlook {
  /** No 4K file can still arrive. */
  fourKSettled: boolean;
  /** Nothing more can arrive from the debrid services at all. */
  debridSettled: boolean;
}

export const OPEN_OUTLOOK: Outlook = { fourKSettled: false, debridSettled: false };

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
  /** When the first playable source turned up (for the short wait once debrid has settled). */
  firstCandidateAt: number | null;
  /** When the player first asked for this title to start (for START_WAIT_MS); kept until a retry. */
  startWaitFrom: number | null;
  /** When the active source last failed while playing (for RETRIES_FORGIVEN_AFTER_MS). */
  lastErrorAt?: number | null;
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
  startWaitFrom: null,
};

export function isCoolingDown(health: SourceHealth | undefined, now: number): boolean {
  if (!health || health.failures === 0) return false;
  const cooldown = health.played ? PLAYED_FAIL_COOLDOWN_MS : START_FAIL_COOLDOWN_MS;
  return now - health.lastFailAt < cooldown;
}

function eligible(state: OrchestratorState, sources: readonly PlaybackSource[], now: number, exclude?: string | null) {
  return sources.filter((s) => s.id !== exclude && !isCoolingDown(state.health[s.id], now));
}

/** Whether another source could take over from the active one right now. */
export function hasAlternative(
  state: OrchestratorState,
  sources: readonly PlaybackSource[],
  ranker: Ranker,
  now: number
): boolean {
  return ranker.pick(eligible(state, sources, now, state.activeId)) !== null;
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

/**
 * Whether discovery may still bring a source that should start instead of
 * `best`. Below the target it may, until the server says otherwise: with no
 * 4K to come a debrid file at 1080p is the best there will be, and with
 * nothing to come from debrid at all only a start below 1080p still waits
 * (the web providers may have that much).
 */
function mayBeBettered(best: PlaybackSource, targetHeight: number, outlook: Outlook): boolean {
  const height = heightOf(best);
  if (height >= targetHeight) return false;
  if (outlook.debridSettled) return height < GOOD_START_HEIGHT;
  if (outlook.fourKSettled) return height < GOOD_START_HEIGHT || best.origin !== "debrid";
  return true;
}

/**
 * Whether discovery may still bring something that should start instead of
 * `best`: a web stream while debrid can still add a file (debrid is always
 * the first choice), a start below the target while the server says more may
 * come, or a source the server doubts.
 */
function mayStillBeBettered(best: PlaybackSource, ranker: Ranker, outlook: Outlook): boolean {
  if (best.origin !== "debrid" && !outlook.debridSettled) return true;
  return mayBeBettered(best, ranker.targetHeight ?? 0, outlook) || ranker.isSuspect?.(best) === true;
}

/** New roster (sources list). Starts playback when nothing is running yet; never switches a running source. */
export function onRoster(
  before: OrchestratorState,
  sources: readonly PlaybackSource[],
  discovering: boolean,
  ranker: Ranker,
  now: number,
  outlook: Outlook = OPEN_OUTLOOK
): Transition {
  // The first roster while the player is waiting to start marks when it was
  // asked, whether or not any source has turned up yet.
  const state: OrchestratorState =
    before.phase === "resolving" && !before.everPlayed && before.startWaitFrom === null
      ? { ...before, startWaitFrom: now }
      : before;
  if (state.phase === "resolving" || state.phase === "failed") {
    const best = ranker.pick(eligible(state, sources, now));
    const weak = best && mayStillBeBettered(best, ranker, outlook);
    if (best && weak && discovering && state.phase === "resolving" && !state.everPlayed) {
      const since = state.firstCandidateAt ?? now;
      // Debrid settled: only the web tail is left to wait for, so the short
      // wait runs from the candidate. Otherwise the wait runs from the ask.
      const left = outlook.debridSettled
        ? LOW_QUALITY_GRACE_MS - (now - since)
        : START_WAIT_MS - (now - (state.startWaitFrom ?? now));
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

export function onFirstFrame(state: OrchestratorState, now: number = Date.now()): OrchestratorState {
  const health = { ...state.health };
  if (state.activeId) health[state.activeId] = { failures: 0, lastFailAt: 0, played: true };
  // A frame straight after a recovery proves only that the recovery ran.
  const recovering = state.phase === "recovering" && now - (state.lastErrorAt ?? 0) < RETRIES_FORGIVEN_AFTER_MS;
  return { ...state, phase: "playing", retries: recovering ? state.retries : 0, everPlayed: true, health, lastReason: null };
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
  // Retries used a while ago, with steady play since, are given back.
  const used = now - (state.lastErrorAt ?? 0) < RETRIES_FORGIVEN_AFTER_MS ? state.retries : 0;
  if (retryFirst && used < SAME_SOURCE_RETRIES) {
    return {
      state: { ...state, phase: "recovering", retries: used + 1, lastReason: reason, lastErrorAt: now },
      command: { type: "attach", sourceId: id, keepPosition: true, refresh: state.retries > 0 },
    };
  }
  const health = recordFailure(state, id, now);
  const next: OrchestratorState = { ...state, health, retries: 0, pinned: false, lastReason: reason, lastErrorAt: null };
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
  return { ...state, phase: "resolving", activeId: null, health: {}, retries: 0, pinned: false, upgradedBeforeStart: false, firstCandidateAt: null, startWaitFrom: null };
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

/**
 * When the end-of-episode card appears, and when it may start the next episode.
 *
 * Pure so it can be tested without a DOM, a store or a running stream — the
 * card itself (`NextEpisodeCard` in views/watch.tsx) is markup plus a timer
 * around this.
 *
 * Two different questions, kept apart on purpose:
 *  - OFFER: show a "Play next episode" card the viewer can press. It may appear
 *    early (inside the credits, or a fixed tail before the end) because
 *    pressing it is the viewer's decision.
 *  - COUNTDOWN: start the next episode on its own. That only ever happens once
 *    the video has actually ended. Nothing upstream marks where credits end, and
 *    episodes often carry a closing scene after them, so a timer started
 *    anywhere before the real end skips content.
 */

/** How far before the end the offer may appear when no credits time is known. */
export const UP_NEXT_TAIL_S = 60;
/** Below this, a fixed tail would be a large fraction of the whole runtime. */
export const UP_NEXT_MIN_DURATION_S = 420;
/** Catalog runtimes shorter than this are too rough to judge a stream's length by. */
export const RUNTIME_CHECK_MIN_S = 600;
/** A stream that stopped before this share of the catalog runtime was cut short, not finished. */
export const ENDED_MIN_RUNTIME_SHARE = 0.6;
/** Credits times (AniSkip) are trusted when the file is this close to the length they were measured on. */
export const CREDITS_LENGTH_TOLERANCE_S = 20;

export type UpNextPhase = "hidden" | "offer" | "countdown";

export interface UpNextInput {
  currentTime: number;
  duration: number;
  /** The video element reported `ended`. */
  ended: boolean;
  /**
   * True while `duration` is still growing — a stream produced live reports how
   * much exists so far, not how long the episode is.
   */
  durationProvisional?: boolean;
  /** Catalog runtime in seconds; stands in for a provisional duration and sanity-checks an ending. */
  fallbackDurationS?: number;
  /** Where the credits begin, when a community database knows (anime). */
  creditsStartS?: number | null;
}

/** Whether the offer window has opened: inside the credits, or the fixed tail. */
export function shouldShowUpNext(
  currentTime: number,
  duration: number,
  durationProvisional = false,
  fallbackDurationS = 0,
  creditsStartS: number | null = null
): boolean {
  if (creditsStartS != null && Number.isFinite(creditsStartS) && creditsStartS > 0 && currentTime >= creditsStartS) {
    return true;
  }
  // A provisional duration is unusable, but the catalog's runtime is not.
  const effective = durationProvisional ? fallbackDurationS : duration;
  // `duration` is 0 until metadata loads. Without this guard the tail test is
  // trivially true at t=0 and the card appears before playback starts.
  if (!Number.isFinite(effective) || effective < UP_NEXT_MIN_DURATION_S) return false;
  return currentTime >= effective - UP_NEXT_TAIL_S;
}

/**
 * True when playback stopped where an episode ends. A stream that quits at a
 * third of the catalog runtime (a truncated file, a dropped connection that
 * the browser treats as the end) must not be taken as "finished".
 */
export function playedToTheEnd(currentTime: number, duration: number, fallbackDurationS = 0): boolean {
  if (!(fallbackDurationS >= RUNTIME_CHECK_MIN_S)) return true;
  const reached = Math.max(Number.isFinite(currentTime) ? currentTime : 0, Number.isFinite(duration) ? duration : 0);
  return reached >= fallbackDurationS * ENDED_MIN_RUNTIME_SHARE;
}

/** Where the credits start, if the times fit this file. */
export function creditsStartFor(
  segments: ReadonlyArray<{ kind: string; start: number; episodeLength?: number }> | undefined,
  duration: number
): number | null {
  const credits = segments?.find((segment) => segment.kind === "credits");
  if (!credits) return null;
  const fits =
    !credits.episodeLength || !duration || Math.abs(credits.episodeLength - duration) <= CREDITS_LENGTH_TOLERANCE_S;
  return fits ? credits.start : null;
}

export function upNextPhase(input: UpNextInput): UpNextPhase {
  const { currentTime, duration, ended, durationProvisional, fallbackDurationS = 0, creditsStartS = null } = input;
  if (ended) return playedToTheEnd(currentTime, duration, fallbackDurationS) ? "countdown" : "offer";
  return shouldShowUpNext(currentTime, duration, durationProvisional, fallbackDurationS, creditsStartS) ? "offer" : "hidden";
}

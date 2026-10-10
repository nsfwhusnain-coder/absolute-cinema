/**
 * Sleep timer: pauses playback after a stretch of watching, or when the
 * episode (or film) on screen ends, fading the sound out over the last
 * seconds so nobody is woken by a cut to silence.
 *
 * Pure so it can be tested without a DOM, a store or a running stream; the
 * clock, the store and the fade live in use-sleep-timer.ts.
 *
 * Two kinds of timer, kept apart on purpose:
 *  - MINUTES counts playing time only. Buffering, a paused video or a server
 *    change between episodes never uses it up, so "30 minutes" means thirty
 *    minutes of something actually playing.
 *  - EPISODES stops when the episode on screen plays to its end; with a count
 *    above one, the next episodes start as usual until the count is used up.
 *    Moving to another episode by hand does not use up the count: the timer
 *    follows the viewer to whatever is playing.
 */

/** Durations offered in the menu, in minutes. */
export const SLEEP_MINUTE_CHOICES = [15, 30, 45, 60, 90, 120] as const;
/** Episode counts offered for shows ("End of this episode", "After 2 episodes"...). */
export const SLEEP_EPISODE_CHOICES = [1, 2, 3] as const;
/** The sound fades to silence over this much playing time before the pause. */
export const SLEEP_FADE_MS = 30_000;
/** The "going to sleep" card appears this long before the pause. */
export const SLEEP_WARNING_MS = 60_000;
/** What "+15 min" on the warning card adds to a minutes timer. */
export const SLEEP_EXTEND_MINUTES = 15;

export type SleepSetting =
  | { kind: "off" }
  | { kind: "minutes"; minutes: number }
  /** Stop once this many episodes, counting the one playing, have played to the end. 1 = this episode or film. */
  | { kind: "episodes"; count: number };

export interface SleepTimer {
  setting: SleepSetting;
  /** Playing time left, for a minutes timer. */
  remainingMs: number;
  /** Episodes still to finish, counting the one playing, for an episodes timer. */
  episodesLeft: number;
}

export const SLEEP_OFF: SleepTimer = { setting: { kind: "off" }, remainingMs: 0, episodesLeft: 0 };

export function startSleepTimer(setting: SleepSetting): SleepTimer {
  if (setting.kind === "minutes" && Number.isFinite(setting.minutes) && setting.minutes > 0) {
    return { setting, remainingMs: setting.minutes * 60_000, episodesLeft: 0 };
  }
  if (setting.kind === "episodes" && Number.isInteger(setting.count) && setting.count > 0) {
    return { setting, remainingMs: 0, episodesLeft: setting.count };
  }
  return SLEEP_OFF;
}

export function sleepTimerActive(timer: SleepTimer): boolean {
  return timer.setting.kind !== "off";
}

/**
 * Advances a minutes timer by `elapsedMs` of playing time. Callers pass only
 * time during which the video was really playing. Other timers are untouched.
 */
export function tickSleepTimer(timer: SleepTimer, elapsedMs: number): { timer: SleepTimer; expired: boolean } {
  if (timer.setting.kind !== "minutes" || !(elapsedMs > 0)) return { timer, expired: false };
  const remainingMs = Math.max(0, timer.remainingMs - elapsedMs);
  return { timer: { ...timer, remainingMs }, expired: remainingMs === 0 };
}

/** The episode or film on screen played to its end. */
export function sleepEpisodeEnded(timer: SleepTimer): { timer: SleepTimer; expired: boolean } {
  if (timer.setting.kind !== "episodes") return { timer, expired: false };
  const episodesLeft = Math.max(0, timer.episodesLeft - 1);
  return { timer: { ...timer, episodesLeft }, expired: episodesLeft === 0 };
}

/** "+15 min" for a minutes timer, "one more episode" for an episodes timer. */
export function extendSleepTimer(timer: SleepTimer): SleepTimer {
  if (timer.setting.kind === "minutes") {
    return { ...timer, remainingMs: timer.remainingMs + SLEEP_EXTEND_MINUTES * 60_000 };
  }
  if (timer.setting.kind === "episodes") return { ...timer, episodesLeft: timer.episodesLeft + 1 };
  return timer;
}

/** True when the timer will stop playback at the end of the episode or film now playing. */
export function stopsAtThisEnd(timer: SleepTimer): boolean {
  return timer.setting.kind === "episodes" && timer.episodesLeft === 1;
}

export interface SleepPlayback {
  currentTime: number;
  duration: number;
  /** Playback speed: at 2x an episode's last minute passes in thirty seconds. */
  rate: number;
}

/**
 * Real time until the timer pauses playback, or Infinity when that is not
 * yet known (an episodes timer with more than one episode to go, an unknown
 * duration, or no timer).
 */
export function msUntilSleep(timer: SleepTimer, playback: SleepPlayback): number {
  if (timer.setting.kind === "minutes") return timer.remainingMs;
  if (!stopsAtThisEnd(timer)) return Number.POSITIVE_INFINITY;
  const { currentTime, duration } = playback;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return Number.POSITIVE_INFINITY;
  const rate = playback.rate > 0 ? playback.rate : 1;
  return (Math.max(0, duration - currentTime) * 1000) / rate;
}

/**
 * Share of the viewer's volume to play at with `msLeft` until the pause:
 * full until the fade starts, then down to silence on a squared curve, which
 * sounds like an even fade (a straight line seems to hold, then drop off).
 */
export function sleepVolume(msLeft: number): number {
  if (!(msLeft < SLEEP_FADE_MS)) return 1;
  const share = Math.max(0, msLeft) / SLEEP_FADE_MS;
  return share * share;
}

/** "15 minutes", "1 hour", "1.5 hours". */
export function minutesChoiceLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

/** "End of this episode", "After 3 episodes", "End of the film". */
export function episodesChoiceLabel(count: number, mediaType: "movie" | "tv"): string {
  if (mediaType === "movie") return "End of the film";
  return count === 1 ? "End of this episode" : `After ${count} episodes`;
}

/** What the viewer chose, for the settings menu: "Off", "30 min", "End of episode". */
export function sleepSettingLabel(timer: SleepTimer, mediaType: "movie" | "tv"): string {
  const { setting } = timer;
  if (setting.kind === "off") return "Off";
  if (setting.kind === "minutes") return formatSleepLeft(timer.remainingMs);
  if (mediaType === "movie") return "End of film";
  return timer.episodesLeft <= 1 ? "End of episode" : `${timer.episodesLeft} episodes`;
}

/**
 * Time until the pause, as the player shows it: "1 h 25 min", "23 min",
 * then a ticking "0:42" in the last minute.
 */
export function formatSleepLeft(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const safe = Math.max(0, ms);
  if (safe < 60_000) {
    const s = Math.ceil(safe / 1000);
    return `0:${String(Math.min(59, s)).padStart(2, "0")}`;
  }
  const minutes = Math.ceil(safe / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function sameSleepSetting(a: SleepSetting, b: SleepSetting): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "minutes" && b.kind === "minutes") return a.minutes === b.minutes;
  if (a.kind === "episodes" && b.kind === "episodes") return a.count === b.count;
  return true;
}

"use client";

import { useEffect, type RefObject } from "react";
import { create } from "zustand";
import {
  SLEEP_FADE_MS,
  SLEEP_OFF,
  extendSleepTimer,
  msUntilSleep,
  sleepEpisodeEnded,
  sleepVolume,
  startSleepTimer,
  tickSleepTimer,
  type SleepSetting,
  type SleepTimer,
} from "./sleep-timer";
import { usePlayerState } from "./store";

/** How often the clock checks the timer and steps the fade. */
const TICK_MS = 250;
/**
 * The most playing time one tick may count. A laptop that slept, or a tab the
 * browser froze, reports a long gap in which nothing played.
 */
const MAX_TICK_MS = 2_000;

export type AsleepReason = "timer" | "ended";

interface SleepTimerStore {
  timer: SleepTimer;
  /** The timer ran out: playback is paused and the sleep screen is up. */
  asleep: AsleepReason | null;
  /** Where playback stopped, for the sleep screen. */
  asleepAt: number;
  /**
   * The sound is being faded out. The player must not take the lowered
   * element volume for the viewer's own level (and save it).
   */
  fading: boolean;
  choose(setting: SleepSetting): void;
  extend(): void;
  cancel(): void;
  /** Playback started again after the timer ran out: back to no timer. */
  wake(): void;
}

/**
 * Lives outside the player on purpose: the player remounts for every
 * episode, and a timer set during episode 3 must still be running in
 * episode 4. The watch page cancels it when the viewer leaves.
 */
export const useSleepTimer = create<SleepTimerStore>((set) => ({
  timer: SLEEP_OFF,
  asleep: null,
  asleepAt: 0,
  fading: false,
  choose: (setting) => set({ timer: startSleepTimer(setting), asleep: null }),
  extend: () => set((s) => ({ timer: extendSleepTimer(s.timer) })),
  cancel: () => set({ timer: SLEEP_OFF, asleep: null }),
  wake: () => set({ timer: SLEEP_OFF, asleep: null }),
}));

/**
 * Runs the sleep timer against the player's video: counts playing time,
 * fades the sound over the last seconds, pauses when the time is up and
 * stops at the end of the episode when that is what was chosen.
 *
 * The fade only works where the page may set the volume: iPhone and iPad
 * Safari ignore `video.volume` (the hardware buttons own it), so there the
 * timer simply pauses on time.
 */
export function useSleepTimerClock(videoRef: RefObject<HTMLVideoElement | null>): void {
  useEffect(() => {
    const video = videoRef.current;
    return video ? startSleepClock(video) : undefined;
  }, [videoRef]);
}

/** The parts of the video element the clock uses (a stand-in in tests). */
export type SleepVideo = Pick<
  HTMLVideoElement,
  "paused" | "ended" | "muted" | "volume" | "currentTime" | "playbackRate" | "pause" | "addEventListener" | "removeEventListener"
>;

export interface SleepClockTime {
  now(): number;
  /** Calls `fn` every `ms`; returns a function that stops it. */
  every(fn: () => void, ms: number): () => void;
}

const realTime: SleepClockTime = {
  now: () => performance.now(),
  every: (fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};

/** Starts the clock on a video; returns the function that stops it. */
export function startSleepClock(video: SleepVideo, time: SleepClockTime = realTime): () => void {
  const sleep = useSleepTimer;
  // A new episode was opened from the sleep screen ("Play next episode").
  if (sleep.getState().asleep) sleep.getState().wake();

  let last = time.now();
  let faded = false;
  // The clock keeps the exact time left here and publishes it to the store
  // only when the whole second changes: the chip and the warning card show
  // seconds at most, and every publish re-renders them. A store value other
  // than the one last seen here was changed by the viewer (chosen, extended,
  // cancelled) and becomes the new starting point.
  let seen: SleepTimer | null = null;
  let exact: SleepTimer = SLEEP_OFF;

  const restoreVolume = () => {
    if (!faded) return;
    faded = false;
    video.volume = usePlayerState.getState().volume;
    sleep.setState({ fading: false });
  };

  const fallAsleep = (reason: AsleepReason) => {
    // Pause first, then put the volume back, so the last word is not heard at full volume.
    video.pause();
    restoreVolume();
    sleep.setState({ timer: SLEEP_OFF, asleep: reason, asleepAt: video.currentTime, fading: false });
  };

  const tick = () => {
    const now = time.now();
    const elapsed = Math.min(now - last, MAX_TICK_MS);
    last = now;
    const { timer: stored, asleep } = sleep.getState();
    if (stored !== seen) {
      seen = stored;
      exact = stored;
    }
    if (asleep || exact.setting.kind === "off") {
      restoreVolume();
      return;
    }
    const player = usePlayerState.getState();
    const playing = !video.paused && !video.ended && !player.buffering;
    if (exact.setting.kind === "minutes" && playing) {
      const next = tickSleepTimer(exact, elapsed);
      if (next.expired) {
        fallAsleep("timer");
        return;
      }
      const secondChanged = Math.ceil(next.timer.remainingMs / 1000) !== Math.ceil(exact.remainingMs / 1000);
      exact = next.timer;
      if (secondChanged) {
        seen = exact;
        sleep.setState({ timer: exact });
      }
    }
    const left = msUntilSleep(exact, { currentTime: video.currentTime, duration: player.duration, rate: video.playbackRate });
    if (left < SLEEP_FADE_MS && playing && !video.muted) {
      if (!faded) {
        faded = true;
        sleep.setState({ fading: true });
      }
      video.volume = Math.max(0, Math.min(1, player.volume * sleepVolume(left)));
    } else if (left >= SLEEP_FADE_MS) {
      // Extended or cancelled mid-fade: back to the viewer's level.
      restoreVolume();
    }
  };

  const onEnded = () => {
    const { timer, asleep } = sleep.getState();
    if (asleep || timer.setting.kind !== "episodes") return;
    const next = sleepEpisodeEnded(timer);
    if (next.expired) fallAsleep("ended");
    else sleep.setState({ timer: next.timer });
  };
  // Any way of starting playback again (play button, space bar, headphones)
  // ends the sleep: the viewer is awake.
  const onPlay = () => {
    if (sleep.getState().asleep) sleep.getState().wake();
  };

  const stop = time.every(tick, TICK_MS);
  video.addEventListener("ended", onEnded);
  video.addEventListener("play", onPlay);
  return () => {
    stop();
    video.removeEventListener("ended", onEnded);
    video.removeEventListener("play", onPlay);
    restoreVolume();
  };
}

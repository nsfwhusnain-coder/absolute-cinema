/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import { usePlayerState } from "./store";
import { startSleepClock, useSleepTimer, type SleepClockTime, type SleepVideo } from "./use-sleep-timer";

const MIN = 60_000;

class FakeVideo extends EventTarget {
  paused = false;
  ended = false;
  muted = false;
  volume = 0.8;
  currentTime = 0;
  playbackRate = 1;
  pauses = 0;
  pause() {
    this.paused = true;
    this.pauses += 1;
  }
}

function fakeTime() {
  let now = 0;
  let tick: (() => void) | null = null;
  const time: SleepClockTime = {
    now: () => now,
    every: (fn) => {
      tick = fn;
      return () => {
        tick = null;
      };
    },
  };
  /** Moves time on in 250 ms steps, running the clock at each, as the real interval would. */
  const advance = (ms: number, video?: FakeVideo) => {
    for (let t = 0; t < ms; t += 250) {
      now += 250;
      if (video && !video.paused) video.currentTime += 0.25 * video.playbackRate;
      tick?.();
    }
  };
  /** One long silent gap (a laptop asleep), then a single tick. */
  const jump = (ms: number) => {
    now += ms;
    tick?.();
  };
  return { time, advance, jump };
}

function setup() {
  usePlayerState.getState().reset();
  usePlayerState.getState().set({ buffering: false, duration: 1380, volume: 0.8 });
  useSleepTimer.setState({ fading: false });
  useSleepTimer.getState().cancel();
  const video = new FakeVideo();
  const clock = fakeTime();
  const stop = startSleepClock(video as unknown as SleepVideo, clock.time);
  return { video, ...clock, stop };
}

const remaining = () => useSleepTimer.getState().timer.remainingMs;

describe("sleep clock: minutes", () => {
  beforeEach(() => useSleepTimer.getState().cancel());

  it("counts down while playing and pauses when the time is up", () => {
    const { video, advance } = setup();
    useSleepTimer.getState().choose({ kind: "minutes", minutes: 15 });
    advance(5 * MIN, video);
    expect(remaining()).toBeLessThanOrEqual(10 * MIN + 1000);
    expect(remaining()).toBeGreaterThanOrEqual(10 * MIN - 1000);
    advance(10 * MIN + 1000, video);
    expect(video.paused).toBe(true);
    expect(useSleepTimer.getState().asleep).toBe("timer");
    expect(useSleepTimer.getState().timer.setting.kind).toBe("off");
    expect(useSleepTimer.getState().asleepAt).toBeGreaterThan(0);
  });

  it("does not count while the video is paused or buffering", () => {
    const { video, advance } = setup();
    useSleepTimer.getState().choose({ kind: "minutes", minutes: 15 });
    video.paused = true;
    advance(5 * MIN);
    expect(remaining()).toBe(15 * MIN);
    video.paused = false;
    usePlayerState.getState().set({ buffering: true });
    advance(5 * MIN, video);
    expect(remaining()).toBe(15 * MIN);
  });

  it("counts a long gap (laptop asleep) as at most a moment", () => {
    const { jump } = setup();
    useSleepTimer.getState().choose({ kind: "minutes", minutes: 15 });
    jump(60 * MIN);
    expect(remaining()).toBeGreaterThanOrEqual(15 * MIN - 2000);
  });

  it("fades the element's volume over the last 30 seconds without touching the viewer's level", () => {
    const { video, advance } = setup();
    useSleepTimer.getState().choose({ kind: "minutes", minutes: 15 });
    advance(15 * MIN - 15_000, video);
    expect(useSleepTimer.getState().fading).toBe(true);
    expect(video.volume).toBeGreaterThan(0.15);
    expect(video.volume).toBeLessThan(0.25);
    expect(usePlayerState.getState().volume).toBe(0.8);
  });

  it("puts the volume back when extended mid-fade, and after the pause", () => {
    const { video, advance } = setup();
    useSleepTimer.getState().choose({ kind: "minutes", minutes: 15 });
    advance(15 * MIN - 10_000, video);
    expect(video.volume).toBeLessThan(0.1);
    useSleepTimer.getState().extend();
    advance(500, video);
    expect(video.volume).toBe(0.8);
    expect(useSleepTimer.getState().fading).toBe(false);
    advance(15 * MIN + 10_000, video);
    expect(useSleepTimer.getState().asleep).toBe("timer");
    expect(video.volume).toBe(0.8);
  });

  it("stops the fade when the timer is turned off", () => {
    const { video, advance } = setup();
    useSleepTimer.getState().choose({ kind: "minutes", minutes: 15 });
    advance(15 * MIN - 5_000, video);
    useSleepTimer.getState().cancel();
    advance(500, video);
    expect(video.volume).toBe(0.8);
    advance(MIN, video);
    expect(video.paused).toBe(false);
  });

  it("wakes up when playback starts again", () => {
    const { video, advance } = setup();
    useSleepTimer.getState().choose({ kind: "minutes", minutes: 15 });
    advance(15 * MIN + 1000, video);
    expect(useSleepTimer.getState().asleep).toBe("timer");
    video.paused = false;
    video.dispatchEvent(new Event("play"));
    expect(useSleepTimer.getState().asleep).toBeNull();
  });
});

describe("sleep clock: episodes", () => {
  beforeEach(() => useSleepTimer.getState().cancel());

  it("stops at the end of this episode", () => {
    const { video } = setup();
    useSleepTimer.getState().choose({ kind: "episodes", count: 1 });
    video.ended = true;
    video.paused = true;
    video.dispatchEvent(new Event("ended"));
    expect(useSleepTimer.getState().asleep).toBe("ended");
  });

  it("lets the next episode start when more than one was chosen", () => {
    const { video } = setup();
    useSleepTimer.getState().choose({ kind: "episodes", count: 2 });
    video.dispatchEvent(new Event("ended"));
    expect(useSleepTimer.getState().asleep).toBeNull();
    expect(useSleepTimer.getState().timer.episodesLeft).toBe(1);
  });

  it("fades over the last 30 seconds of the episode it stops at", () => {
    const { video, advance } = setup();
    useSleepTimer.getState().choose({ kind: "episodes", count: 1 });
    video.currentTime = 1380 - 20;
    advance(500, video);
    expect(video.volume).toBeLessThan(0.8 * 0.5);
    expect(useSleepTimer.getState().fading).toBe(true);
  });

  it("wakes on a new episode's clock (Play next episode from the sleep screen)", () => {
    const first = setup();
    useSleepTimer.getState().choose({ kind: "episodes", count: 1 });
    first.video.dispatchEvent(new Event("ended"));
    expect(useSleepTimer.getState().asleep).toBe("ended");
    first.stop();
    startSleepClock(new FakeVideo() as unknown as SleepVideo, fakeTime().time);
    expect(useSleepTimer.getState().asleep).toBeNull();
  });
});

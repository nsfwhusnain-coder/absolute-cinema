/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  SLEEP_FADE_MS,
  SLEEP_OFF,
  episodesChoiceLabel,
  extendSleepTimer,
  formatSleepLeft,
  minutesChoiceLabel,
  msUntilSleep,
  sameSleepSetting,
  sleepEpisodeEnded,
  sleepSettingLabel,
  sleepTimerActive,
  sleepVolume,
  startSleepTimer,
  stopsAtThisEnd,
  tickSleepTimer,
} from "./sleep-timer";

const MIN = 60_000;
const playing = (currentTime: number, duration: number, rate = 1) => ({ currentTime, duration, rate });

describe("startSleepTimer", () => {
  it("starts a minutes timer with the full time left", () => {
    const timer = startSleepTimer({ kind: "minutes", minutes: 30 });
    expect(timer.remainingMs).toBe(30 * MIN);
    expect(sleepTimerActive(timer)).toBe(true);
  });

  it("starts an episodes timer counting the episode on screen", () => {
    expect(startSleepTimer({ kind: "episodes", count: 2 }).episodesLeft).toBe(2);
  });

  it("treats nonsense as off rather than a timer that fires at once", () => {
    expect(startSleepTimer({ kind: "minutes", minutes: 0 })).toEqual(SLEEP_OFF);
    expect(startSleepTimer({ kind: "minutes", minutes: Number.NaN })).toEqual(SLEEP_OFF);
    expect(startSleepTimer({ kind: "episodes", count: 0 })).toEqual(SLEEP_OFF);
    expect(startSleepTimer({ kind: "episodes", count: 1.5 })).toEqual(SLEEP_OFF);
    expect(sleepTimerActive(startSleepTimer({ kind: "off" }))).toBe(false);
  });
});

describe("tickSleepTimer (minutes)", () => {
  it("counts down by the playing time it is given and expires at zero", () => {
    let timer = startSleepTimer({ kind: "minutes", minutes: 15 });
    ({ timer } = tickSleepTimer(timer, 14 * MIN));
    expect(timer.remainingMs).toBe(MIN);
    const last = tickSleepTimer(timer, 2 * MIN);
    expect(last.expired).toBe(true);
    expect(last.timer.remainingMs).toBe(0);
  });

  it("ignores zero, negative and NaN elapsed time", () => {
    const timer = startSleepTimer({ kind: "minutes", minutes: 15 });
    for (const elapsed of [0, -500, Number.NaN]) {
      const next = tickSleepTimer(timer, elapsed);
      expect(next.expired).toBe(false);
      expect(next.timer.remainingMs).toBe(15 * MIN);
    }
  });

  it("never touches an episodes timer", () => {
    const timer = startSleepTimer({ kind: "episodes", count: 1 });
    expect(tickSleepTimer(timer, 99 * MIN)).toEqual({ timer, expired: false });
  });
});

describe("sleepEpisodeEnded (episodes)", () => {
  it("stops at the end of this episode", () => {
    expect(sleepEpisodeEnded(startSleepTimer({ kind: "episodes", count: 1 })).expired).toBe(true);
  });

  it("lets the next episodes play until the count is used up", () => {
    let timer = startSleepTimer({ kind: "episodes", count: 3 });
    let ended = sleepEpisodeEnded(timer);
    expect(ended.expired).toBe(false);
    timer = ended.timer;
    ended = sleepEpisodeEnded(timer);
    expect(ended.expired).toBe(false);
    expect(stopsAtThisEnd(ended.timer)).toBe(true);
    expect(sleepEpisodeEnded(ended.timer).expired).toBe(true);
  });

  it("does nothing for a minutes timer or no timer", () => {
    const minutes = startSleepTimer({ kind: "minutes", minutes: 30 });
    expect(sleepEpisodeEnded(minutes)).toEqual({ timer: minutes, expired: false });
    expect(sleepEpisodeEnded(SLEEP_OFF).expired).toBe(false);
  });
});

describe("extendSleepTimer", () => {
  it("adds fifteen minutes to a minutes timer", () => {
    const timer = { ...startSleepTimer({ kind: "minutes", minutes: 30 }), remainingMs: 20_000 };
    expect(extendSleepTimer(timer).remainingMs).toBe(20_000 + 15 * MIN);
  });

  it("adds one episode to an episodes timer", () => {
    const timer = startSleepTimer({ kind: "episodes", count: 1 });
    const extended = extendSleepTimer(timer);
    expect(extended.episodesLeft).toBe(2);
    expect(stopsAtThisEnd(extended)).toBe(false);
  });

  it("leaves no timer as no timer", () => {
    expect(extendSleepTimer(SLEEP_OFF)).toEqual(SLEEP_OFF);
  });
});

describe("msUntilSleep", () => {
  it("is the time left on a minutes timer, whatever is playing", () => {
    const timer = { ...startSleepTimer({ kind: "minutes", minutes: 30 }), remainingMs: 42_000 };
    expect(msUntilSleep(timer, playing(10, 3000))).toBe(42_000);
  });

  it("is the rest of the episode when the timer stops at its end", () => {
    const timer = startSleepTimer({ kind: "episodes", count: 1 });
    expect(msUntilSleep(timer, playing(2580, 2640))).toBe(60_000);
  });

  it("allows for playback speed", () => {
    const timer = startSleepTimer({ kind: "episodes", count: 1 });
    expect(msUntilSleep(timer, playing(2580, 2640, 2))).toBe(30_000);
    expect(msUntilSleep(timer, playing(2580, 2640, 0))).toBe(60_000);
  });

  it("is unknown before the last episode, before the duration loads, or with no timer", () => {
    expect(msUntilSleep(startSleepTimer({ kind: "episodes", count: 2 }), playing(2580, 2640))).toBe(Infinity);
    expect(msUntilSleep(startSleepTimer({ kind: "episodes", count: 1 }), playing(0, 0))).toBe(Infinity);
    expect(msUntilSleep(startSleepTimer({ kind: "episodes", count: 1 }), playing(0, Number.NaN))).toBe(Infinity);
    expect(msUntilSleep(SLEEP_OFF, playing(0, 100))).toBe(Infinity);
  });

  it("never goes negative past the end", () => {
    expect(msUntilSleep(startSleepTimer({ kind: "episodes", count: 1 }), playing(2700, 2640))).toBe(0);
  });
});

describe("sleepVolume (the fade)", () => {
  it("keeps full volume until the fade starts", () => {
    expect(sleepVolume(Infinity)).toBe(1);
    expect(sleepVolume(10 * MIN)).toBe(1);
    expect(sleepVolume(SLEEP_FADE_MS)).toBe(1);
  });

  it("falls smoothly to silence, quieter every step", () => {
    let previous = 1;
    for (let ms = SLEEP_FADE_MS - 1000; ms >= 0; ms -= 1000) {
      const v = sleepVolume(ms);
      expect(v).toBeLessThan(previous);
      expect(v).toBeGreaterThanOrEqual(0);
      previous = v;
    }
    expect(sleepVolume(0)).toBe(0);
    expect(sleepVolume(-5)).toBe(0);
  });

  it("is a quarter volume halfway through the fade", () => {
    expect(sleepVolume(SLEEP_FADE_MS / 2)).toBeCloseTo(0.25, 5);
  });
});

describe("labels", () => {
  it("names the minute choices", () => {
    expect(minutesChoiceLabel(15)).toBe("15 minutes");
    expect(minutesChoiceLabel(60)).toBe("1 hour");
    expect(minutesChoiceLabel(90)).toBe("1.5 hours");
    expect(minutesChoiceLabel(120)).toBe("2 hours");
  });

  it("names the episode choices, and the film's", () => {
    expect(episodesChoiceLabel(1, "tv")).toBe("End of this episode");
    expect(episodesChoiceLabel(3, "tv")).toBe("After 3 episodes");
    expect(episodesChoiceLabel(1, "movie")).toBe("End of the film");
  });

  it("formats the time left like the player shows it", () => {
    expect(formatSleepLeft(42_000)).toBe("0:42");
    expect(formatSleepLeft(500)).toBe("0:01");
    expect(formatSleepLeft(0)).toBe("0:00");
    expect(formatSleepLeft(59_500)).toBe("0:59");
    expect(formatSleepLeft(60_000)).toBe("1 min");
    expect(formatSleepLeft(22 * MIN + 1)).toBe("23 min");
    expect(formatSleepLeft(60 * MIN)).toBe("1 h");
    expect(formatSleepLeft(85 * MIN)).toBe("1 h 25 min");
    expect(formatSleepLeft(Infinity)).toBe("");
  });

  it("summarises the setting for the menu", () => {
    expect(sleepSettingLabel(SLEEP_OFF, "tv")).toBe("Off");
    expect(sleepSettingLabel(startSleepTimer({ kind: "minutes", minutes: 30 }), "tv")).toBe("30 min");
    expect(sleepSettingLabel(startSleepTimer({ kind: "episodes", count: 1 }), "tv")).toBe("End of episode");
    expect(sleepSettingLabel(startSleepTimer({ kind: "episodes", count: 3 }), "tv")).toBe("3 episodes");
    expect(sleepSettingLabel(startSleepTimer({ kind: "episodes", count: 1 }), "movie")).toBe("End of film");
  });
});

describe("sameSleepSetting", () => {
  it("compares kind and amount", () => {
    expect(sameSleepSetting({ kind: "off" }, { kind: "off" })).toBe(true);
    expect(sameSleepSetting({ kind: "minutes", minutes: 30 }, { kind: "minutes", minutes: 30 })).toBe(true);
    expect(sameSleepSetting({ kind: "minutes", minutes: 30 }, { kind: "minutes", minutes: 45 })).toBe(false);
    expect(sameSleepSetting({ kind: "episodes", count: 1 }, { kind: "minutes", minutes: 1 })).toBe(false);
  });
});

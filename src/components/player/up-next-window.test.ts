/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { creditsStartFor, playedToTheEnd, shouldShowUpNext, upNextPhase } from "./up-next-window";

const HOUR = 3600;
const EPISODE = 44 * 60;

describe("shouldShowUpNext (the offer window)", () => {
  it("stays hidden through the body of an episode", () => {
    expect(shouldShowUpNext(0, HOUR)).toBe(false);
    expect(shouldShowUpNext(HOUR / 2, HOUR)).toBe(false);
    expect(shouldShowUpNext(HOUR - 120, HOUR)).toBe(false);
  });

  it("appears inside the tail window and stays up to the end", () => {
    expect(shouldShowUpNext(HOUR - 59, HOUR)).toBe(true);
    expect(shouldShowUpNext(HOUR, HOUR)).toBe(true);
  });

  it("never fires on short content, where the tail would be most of the runtime", () => {
    expect(shouldShowUpNext(299, 300)).toBe(false);
  });

  it("never fires before duration is known", () => {
    expect(shouldShowUpNext(0, 0)).toBe(false);
    expect(shouldShowUpNext(5, 0)).toBe(false);
    expect(shouldShowUpNext(5, Number.NaN)).toBe(false);
  });

  it("ignores a still-growing duration rather than firing an episode early", () => {
    expect(shouldShowUpNext(480, 491.9, true)).toBe(false);
    expect(shouldShowUpNext(480, 491.9, false)).toBe(true);
  });

  it("falls back to the catalog runtime while the stream's own duration is growing", () => {
    expect(shouldShowUpNext(480, 491.9, true, EPISODE)).toBe(false);
    expect(shouldShowUpNext(EPISODE - 30, 491.9, true, EPISODE)).toBe(true);
  });

  it("does not use the fallback once the real duration is known", () => {
    expect(shouldShowUpNext(100, HOUR, false, 200)).toBe(false);
  });

  it("opens at the credits when their time is known, and not before", () => {
    expect(shouldShowUpNext(1300, EPISODE, false, 0, 1320)).toBe(false);
    expect(shouldShowUpNext(1320, EPISODE, false, 0, 1320)).toBe(true);
  });
});

describe("upNextPhase", () => {
  it("never counts down while the video is still playing, however close to the end", () => {
    for (const t of [EPISODE - 70, EPISODE - 30, EPISODE - 5, EPISODE - 0.2]) {
      expect(upNextPhase({ currentTime: t, duration: EPISODE, ended: false, fallbackDurationS: EPISODE })).not.toBe("countdown");
    }
  });

  it("offers the next episode in the tail but does not start it", () => {
    expect(upNextPhase({ currentTime: EPISODE - 40, duration: EPISODE, ended: false })).toBe("offer");
  });

  it("counts down once the episode has really ended", () => {
    expect(upNextPhase({ currentTime: EPISODE, duration: EPISODE, ended: true, fallbackDurationS: EPISODE })).toBe("countdown");
  });

  it("does not count down when the stream stopped far short of the episode", () => {
    expect(upNextPhase({ currentTime: 900, duration: 900, ended: true, fallbackDurationS: EPISODE })).toBe("offer");
  });

  it("counts down when the catalog has no runtime to judge by", () => {
    expect(upNextPhase({ currentTime: 900, duration: 900, ended: true, fallbackDurationS: 0 })).toBe("countdown");
  });

  it("stays hidden mid-episode", () => {
    expect(upNextPhase({ currentTime: 600, duration: EPISODE, ended: false })).toBe("hidden");
  });
});

describe("playedToTheEnd", () => {
  it("accepts an ending near the catalog runtime, including a slightly shorter cut", () => {
    expect(playedToTheEnd(EPISODE - 90, EPISODE - 90, EPISODE)).toBe(true);
  });
  it("rejects an ending at a fraction of it", () => {
    expect(playedToTheEnd(600, 600, EPISODE)).toBe(false);
  });
  it("trusts the stream when the runtime is missing or implausibly small", () => {
    expect(playedToTheEnd(600, 600, 0)).toBe(true);
    expect(playedToTheEnd(100, 100, 300)).toBe(true);
  });
});

describe("creditsStartFor", () => {
  const segments = [{ kind: "intro", start: 30, episodeLength: 1440 }, { kind: "credits", start: 1320, episodeLength: 1440 }];
  it("returns the credits time when the file matches the measured episode", () => {
    expect(creditsStartFor(segments, 1445)).toBe(1320);
  });
  it("ignores times measured on a different cut", () => {
    expect(creditsStartFor(segments, 1500)).toBeNull();
  });
  it("returns null without credits data", () => {
    expect(creditsStartFor([{ kind: "intro", start: 30 }], 1440)).toBeNull();
    expect(creditsStartFor(undefined, 1440)).toBeNull();
  });
});

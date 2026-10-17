import { describe, expect, it } from "bun:test";
import { metrics } from "../metrics";
import { playbackStatusLabel, recordPlaybackAnswer } from "./playback-answers";

/** The value of one series in the live metrics text, or 0 while it has not been seen. */
function sample(series: string): number {
  const row = metrics().render().split("\n").find((line) => line.startsWith(`${series} `));
  return row === undefined ? 0 : Number(row.slice(series.length + 1));
}

describe("playbackStatusLabel", () => {
  it("keeps the statuses an answer can carry, and labels anything else other", () => {
    for (const status of ["available", "requestable", "external", "not_configured", "error", "empty"]) {
      expect(playbackStatusLabel(status)).toBe(status);
    }
    expect(playbackStatusLabel("some new status")).toBe("other");
    expect(playbackStatusLabel(undefined)).toBe("other");
    expect(playbackStatusLabel(null)).toBe("other");
  });
});

describe("recordPlaybackAnswer", () => {
  it("counts the answer by mode, cache and status, and times it", () => {
    const counter = 'ac_web_playback_answers_total{mode="fast",cache="hit",status="available"}';
    const seconds = 'ac_web_playback_answer_seconds_count{mode="fast",cache="hit"}';
    const sum = 'ac_web_playback_answer_seconds_sum{mode="fast",cache="hit"}';
    const before = [sample(counter), sample(seconds), sample(sum)];
    recordPlaybackAnswer({ fast: true, cacheHit: true, status: "available", totalMs: 120 });
    expect(sample(counter) - before[0]!).toBe(1);
    expect(sample(seconds) - before[1]!).toBe(1);
    expect(sample(sum) - before[2]!).toBeCloseTo(0.12, 6);
  });

  it("counts a full answer from the cache miss under its own labels", () => {
    const counter = 'ac_web_playback_answers_total{mode="full",cache="miss",status="error"}';
    const before = sample(counter);
    recordPlaybackAnswer({ fast: false, cacheHit: false, status: "error", totalMs: 9000 });
    expect(sample(counter) - before).toBe(1);
  });

  it("labels an unknown status other, and does not time an answer with no time", () => {
    const counter = 'ac_web_playback_answers_total{mode="full",cache="miss",status="other"}';
    const seconds = 'ac_web_playback_answer_seconds_count{mode="full",cache="miss"}';
    const before = [sample(counter), sample(seconds)];
    recordPlaybackAnswer({ fast: false, cacheHit: false, status: "weird", totalMs: Number.NaN });
    expect(sample(counter) - before[0]!).toBe(1);
    expect(sample(seconds) - before[1]!).toBe(0);
  });
});

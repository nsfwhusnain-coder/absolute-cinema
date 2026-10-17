import { describe, expect, it } from "bun:test";
import { BufferBudget, minimumBackSeconds } from "./buffer-budget";
import { bufferProfileFor } from "./device-profile";

const MB = 1_000_000;
const chromium = bufferProfileFor("chromium");
const firefox = bufferProfileFor("firefox");
const tv = bufferProfileFor("tv");

/** Megabits per second, as a bitrate in bits per second. */
const mbit = (megabits: number) => megabits * 1_000_000;

/** Thirty two-second segments at `bytesPerSecond`: a steady stream, fully measured. */
function feed(budget: BufferBudget, bytesPerSecond: number): void {
  for (let i = 0; i < 30; i++) budget.observe(bytesPerSecond * 2, 2);
}

describe("BufferBudget", () => {
  it("uses the fallback seconds until a bitrate is known", () => {
    expect(new BufferBudget(chromium).lengths()).toEqual({
      maxBufferLengthS: 30,
      maxMaxBufferLengthS: 30,
      backBufferLengthS: 10,
      maxBufferSize: 105 * MB,
    });
    // The TV's fallback 4 s behind is raised to the 8 s a trim needs to stay clear of the picture being played.
    expect(new BufferBudget(tv).lengths()).toMatchObject({ maxBufferLengthS: 12, backBufferLengthS: 8 });
  });

  it("holds 4K at 40 Mbit/s to 18 s ahead and 8 s behind on Chromium, inside 130 MB", () => {
    // 8 s behind is 40 MB; the forward part keeps to the 90 MB left of the 130 MB budget.
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(40) / 8);
    const lengths = budget.lengths();
    expect(lengths.maxBufferLengthS).toBeCloseTo(18, 6);
    expect(lengths.maxMaxBufferLengthS).toBeCloseTo(18, 6);
    expect(lengths.backBufferLengthS).toBeCloseTo(8, 6);
    expect(lengths.maxBufferSize).toBeCloseTo(90 * MB, 0);
  });

  it("keeps more than the longest keyframe gap behind, taking it from the forward part", () => {
    // Keyframes 10 s apart: 14 s (70 MB) stay behind, so 60 MB are left ahead.
    const budget = new BufferBudget(chromium, mbit(40), 10);
    const lengths = budget.lengths();
    expect(lengths.backBufferLengthS).toBeCloseTo(14, 6);
    expect(lengths.maxBufferLengthS).toBeCloseTo(12, 6);
    expect(lengths.maxBufferSize).toBeCloseTo(60 * MB, 0);
  });

  it("never trims into the picture group being played, even with the budget at its smallest", () => {
    const budget = new BufferBudget(chromium, mbit(40), 10.4);
    for (let i = 0; i < 10; i++) budget.full();
    expect(budget.lengths().backBufferLengthS).toBeCloseTo(14.4, 6);
  });

  it("holds a Firefox 4K stream to 7 s ahead and 8 s behind", () => {
    // Firefox's 75 MB: 40 MB behind leaves 35 MB ahead.
    const budget = new BufferBudget(firefox);
    feed(budget, mbit(40) / 8);
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(7, 6);
    expect(budget.lengths().backBufferLengthS).toBeCloseTo(8, 6);
  });

  it("holds 1080p at 8 Mbit/s to 105 s ahead and 25 s behind, inside the second caps", () => {
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(8) / 8);
    const lengths = budget.lengths();
    expect(lengths.maxBufferLengthS).toBeCloseTo(105, 6);
    expect(lengths.backBufferLengthS).toBeCloseTo(25, 6);
  });

  it("holds a TV at 20 Mbit/s to 11.2 s ahead and 8 s behind", () => {
    // The TV's 48 MB: 20 MB behind leaves 28 MB ahead.
    const budget = new BufferBudget(tv);
    feed(budget, mbit(20) / 8);
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(11.2, 6);
    expect(budget.lengths().backBufferLengthS).toBeCloseTo(8, 6);
  });

  it("holds a TV at 80 Mbit/s at the 6 s floor ahead and the 8 s floor behind", () => {
    // 80 Mbit/s is 10 MB a second: the floors win over the TV's 48 MB.
    const budget = new BufferBudget(tv);
    feed(budget, mbit(80) / 8);
    expect(budget.lengths().maxBufferLengthS).toBe(6);
    expect(budget.lengths().backBufferLengthS).toBe(8);
  });

  it("holds Chromium at the 6 s floor at 160 Mbit/s", () => {
    // 160 Mbit/s is 20 MB a second: what is left ahead is below the floor.
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(160) / 8);
    expect(budget.lengths().maxBufferLengthS).toBe(6);
  });

  it("never exceeds the second caps, even at a trickle", () => {
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(0.1) / 8);
    expect(budget.lengths().maxBufferLengthS).toBe(120);
    expect(budget.lengths().backBufferLengthS).toBe(30);
  });

  it("uses the server's declared average before anything is measured", () => {
    const budget = new BufferBudget(chromium, mbit(40));
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(18, 6);
    expect(budget.lengths().backBufferLengthS).toBeCloseTo(8, 6);
  });

  it("smooths the measured rate, so one segment does not swing the buffer", () => {
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(8) / 8);
    budget.observe(5 * MB * 2, 2);
    // 1 MB/s moved 30% of the way toward the 5 MB/s segment: 2.2 MB/s.
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(105 / 2.2, 6);
  });

  it("holds a declared average at 70% when the measurements run far below it", () => {
    const budget = new BufferBudget(chromium, mbit(40));
    for (let i = 0; i < 30; i++) budget.observe(1000, 2);
    // Without the floor, 500 B/s would ask for the 120 s cap. The file averages 5 MB/s, so the buffer is planned at 70% of that.
    // 8 s behind (28 MB), and the 102 MB left of 130 MB ahead.
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(102 / (0.7 * 5), 6);
    expect(budget.lengths().backBufferLengthS).toBeCloseTo(8, 6);
  });

  it("follows a manifest's rendition bitrate until a segment is measured, then the measurement", () => {
    const budget = new BufferBudget(chromium);
    budget.seed(mbit(40));
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(18, 6);
    // Adaptive switching moves to a 1 MB/s rendition: no declared average floors it.
    feed(budget, mbit(8) / 8);
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(105, 6);
  });

  it("lets the server's declared average outrank a manifest seed", () => {
    const budget = new BufferBudget(chromium, mbit(8));
    budget.seed(mbit(40));
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(105, 6);
  });

  it("holds less after the browser reports the buffer full, down to a quarter of the budget", () => {
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(8) / 8);
    const before = budget.lengths().maxBufferLengthS;
    budget.full();
    expect(budget.lengths().maxBufferLengthS).toBeLessThan(before);
    for (let i = 0; i < 10; i++) budget.full();
    // A quarter of 130 MB is 32.5 MB; 8 s (8 MB) stay behind, 24.5 MB ahead at 1 MB/s.
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(24.5, 6);
    expect(budget.lengths().maxBufferSize).toBeCloseTo(24.5 * MB, 0);
  });

  it("shrinks the fallback seconds too, so a refusal before any measurement still has an effect", () => {
    const budget = new BufferBudget(chromium);
    budget.full();
    expect(budget.lengths().maxBufferLengthS).toBe(15);
  });

  it("ignores empty or impossible measurements", () => {
    const budget = new BufferBudget(chromium);
    budget.observe(0, 2);
    budget.observe(100, 0);
    budget.observe(Number.NaN, 2);
    expect(budget.lengths().maxBufferLengthS).toBe(30);
  });

  it("follows a change of bitrate", () => {
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(40) / 8);
    const heavy = budget.lengths().maxBufferLengthS;
    feed(budget, mbit(8) / 8);
    expect(budget.lengths().maxBufferLengthS).toBeGreaterThan(heavy);
  });

  it("needs the keyframe gap plus a margin behind, 8 s when the gap is unknown, 40 s at most", () => {
    expect(minimumBackSeconds(10.4)).toBeCloseTo(14.4, 6);
    expect(minimumBackSeconds(2)).toBe(6);
    expect(minimumBackSeconds(undefined)).toBe(8);
    expect(minimumBackSeconds(0)).toBe(8);
    expect(minimumBackSeconds(90)).toBe(40);
  });
});

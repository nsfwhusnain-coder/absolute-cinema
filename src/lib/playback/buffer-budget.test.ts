import { describe, expect, it } from "bun:test";
import { BufferBudget } from "./buffer-budget";
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
      maxBufferSize: 90 * MB,
    });
    expect(new BufferBudget(tv).lengths()).toMatchObject({ maxBufferLengthS: 12, backBufferLengthS: 4 });
  });

  it("holds 4K at 40 Mbit/s to about 18 s ahead and 4 s behind on Chromium", () => {
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(40) / 8);
    const lengths = budget.lengths();
    expect(lengths.maxBufferLengthS).toBeCloseTo(18, 6);
    expect(lengths.maxMaxBufferLengthS).toBeCloseTo(18, 6);
    expect(lengths.backBufferLengthS).toBeCloseTo(4, 6);
    expect(lengths.maxBufferSize).toBe(90 * MB);
  });

  it("holds a Firefox 4K stream to about 12 s ahead and 3 s behind", () => {
    const budget = new BufferBudget(firefox);
    feed(budget, mbit(40) / 8);
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(12, 6);
    expect(budget.lengths().backBufferLengthS).toBeCloseTo(3, 6);
  });

  it("holds 1080p at 8 Mbit/s to 90 s ahead and 20 s behind, inside the second caps", () => {
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(8) / 8);
    const lengths = budget.lengths();
    expect(lengths.maxBufferLengthS).toBeCloseTo(90, 6);
    expect(lengths.backBufferLengthS).toBeCloseTo(20, 6);
  });

  it("holds a TV at 20 Mbit/s to 16 s ahead and 3.2 s behind", () => {
    const budget = new BufferBudget(tv);
    feed(budget, mbit(20) / 8);
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(16, 6);
    expect(budget.lengths().backBufferLengthS).toBeCloseTo(3.2, 6);
  });

  it("holds a TV at 80 Mbit/s at the 6 s floor, and never below 2 s behind", () => {
    // 80 Mbit/s is 10 MB a second, so the TV's 40 MB lasts 4 s: the floor wins.
    const budget = new BufferBudget(tv);
    feed(budget, mbit(80) / 8);
    expect(budget.lengths().maxBufferLengthS).toBe(6);
    expect(budget.lengths().backBufferLengthS).toBe(2);
  });

  it("holds Chromium at the 6 s floor at 160 Mbit/s", () => {
    // 160 Mbit/s is 20 MB a second: 90 MB is 4.5 s, below the floor.
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
    expect(budget.lengths().backBufferLengthS).toBeCloseTo(4, 6);
  });

  it("smooths the measured rate, so one segment does not swing the buffer", () => {
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(8) / 8);
    budget.observe(5 * MB * 2, 2);
    // 1 MB/s moved 30% of the way toward the 5 MB/s segment: 2.2 MB/s.
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(90 / 2.2, 6);
  });

  it("holds a declared average at 70% when the measurements run far below it", () => {
    const budget = new BufferBudget(chromium, mbit(40));
    for (let i = 0; i < 30; i++) budget.observe(1000, 2);
    // Without the floor, 500 B/s would ask for the 120 s cap. The file averages 5 MB/s, so the buffer is planned at 70% of that.
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(90 / (0.7 * 5), 6);
    expect(budget.lengths().backBufferLengthS).toBeCloseTo(20 / (0.7 * 5), 6);
  });

  it("follows a manifest's rendition bitrate until a segment is measured, then the measurement", () => {
    const budget = new BufferBudget(chromium);
    budget.seed(mbit(40));
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(18, 6);
    // Adaptive switching moves to a 1 MB/s rendition: no declared average floors it.
    feed(budget, mbit(8) / 8);
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(90, 6);
  });

  it("lets the server's declared average outrank a manifest seed", () => {
    const budget = new BufferBudget(chromium, mbit(8));
    budget.seed(mbit(40));
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(90, 6);
  });

  it("holds less after the browser reports the buffer full, down to a quarter of the budget", () => {
    const budget = new BufferBudget(chromium);
    feed(budget, mbit(8) / 8);
    const before = budget.lengths().maxBufferLengthS;
    budget.full();
    expect(budget.lengths().maxBufferLengthS).toBeLessThan(before);
    for (let i = 0; i < 10; i++) budget.full();
    // A quarter of 90 MB at 1 MB/s.
    expect(budget.lengths().maxBufferLengthS).toBeCloseTo(22.5, 6);
    expect(budget.lengths().maxBufferSize).toBe(22.5 * MB);
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
});

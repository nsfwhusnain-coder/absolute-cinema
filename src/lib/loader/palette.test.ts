import { describe, expect, it } from "bun:test";
import { clusterPixels, derivePalette, rgbToHsl, type LoaderPalette } from "./palette";

const FALLBACK: LoaderPalette = { background: "#050510", main: "#3b82f6", accent: "#a5f3fc", highlight: "#ffffff" };
const hueOf = (hex: string) => rgbToHsl([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);

function image(parts: Array<[number, [number, number, number]]>) {
  return parts.flatMap(([n, rgb]) => Array.from({ length: n }, () => rgb));
}

describe("loader palette", () => {
  it("takes the main colour from the most colourful plentiful area and a distinct accent", () => {
    // Mostly dark desert orange, some sky blue, a little black.
    const pixels = image([
      [500, [196, 108, 40]],
      [300, [40, 90, 170]],
      [200, [8, 6, 5]],
    ]);
    const p = derivePalette(clusterPixels(pixels), FALLBACK);
    expect(hueOf(p.main)[0]).toBeGreaterThan(15);
    expect(hueOf(p.main)[0]).toBeLessThan(40);
    expect(hueOf(p.accent)[0]).toBeGreaterThan(190);
    expect(hueOf(p.background)[2]).toBeLessThan(0.1);
    expect(hueOf(p.highlight)[2]).toBeGreaterThan(0.85);
  });

  it("keeps effects visible: main is always mid-bright and saturated", () => {
    const pixels = image([[900, [60, 20, 20]], [100, [20, 20, 20]]]);
    const [, s, l] = hueOf(derivePalette(clusterPixels(pixels), FALLBACK).main);
    expect(s).toBeGreaterThanOrEqual(0.5);
    expect(l).toBeGreaterThan(0.45);
    expect(l).toBeLessThan(0.65);
  });

  it("falls back for black-and-white artwork", () => {
    const pixels = image([[500, [240, 240, 240]], [500, [15, 15, 15]]]);
    const p = derivePalette(clusterPixels(pixels), FALLBACK);
    expect(p.main).toBe(FALLBACK.main);
    expect(p.accent).toBe(FALLBACK.accent);
  });
});

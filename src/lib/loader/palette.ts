/**
 * Loader palettes from artwork.
 *
 * Pixels from a title's poster and backdrop are clustered (k-means) into a few
 * representative colours, then refined into four roles the loading scenes
 * use: a dark background, a main colour, a contrasting accent and a pale
 * highlight. Brightness and saturation are normalised so the effects stay
 * visible whatever the artwork looks like.
 */

export interface LoaderPalette {
  background: string;
  main: string;
  accent: string;
  highlight: string;
}

type Rgb = [number, number, number];
type Hsl = [number, number, number];

interface Cluster {
  rgb: Rgb;
  weight: number;
}

const CLUSTERS = 8;
const ITERATIONS = 8;
/** Hues closer than this count as the same colour. */
const SAME_HUE_DEG = 28;
/** An accent should be at least this far round the colour wheel from the main colour. */
const ACCENT_MIN_HUE_DEG = 45;
/** Below this saturation a colour reads as grey and cannot carry the scene. */
const MIN_VIVID_SATURATION = 0.18;

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

export function hslToHex([h, s, l]: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Deterministic k-means over RGB pixels (seeded by spreading initial centres across the data). */
export function clusterPixels(pixels: readonly Rgb[], k = CLUSTERS): Cluster[] {
  if (!pixels.length) return [];
  const centres: Rgb[] = [];
  for (let i = 0; i < k; i++) centres.push([...pixels[Math.floor(((i + 0.5) / k) * pixels.length)]!] as Rgb);
  const assign = new Array<number>(pixels.length).fill(0);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    pixels.forEach((p, i) => {
      let best = 0;
      let bestD = Infinity;
      centres.forEach((c, j) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      assign[i] = best;
    });
    const sums = centres.map(() => [0, 0, 0, 0]);
    pixels.forEach((p, i) => {
      const s = sums[assign[i]!]!;
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3] += 1;
    });
    sums.forEach((s, j) => {
      if (s[3]) centres[j] = [s[0]! / s[3], s[1]! / s[3], s[2]! / s[3]];
    });
  }
  const counts = new Array<number>(k).fill(0);
  assign.forEach((j) => (counts[j] += 1));
  return centres
    .map((rgb, j) => ({ rgb, weight: counts[j]! / pixels.length }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

/**
 * Four roles from clustered colours. `fallback` supplies any role the
 * artwork cannot (a black-and-white poster has no main colour).
 */
export function derivePalette(clusters: readonly Cluster[], fallback: LoaderPalette): LoaderPalette {
  const hsl = clusters.map((c) => ({ hsl: rgbToHsl(c.rgb), weight: c.weight }));
  const vivid = hsl.filter((c) => c.hsl[1] >= MIN_VIVID_SATURATION && c.hsl[2] > 0.08 && c.hsl[2] < 0.92);

  // Main: plenty of it and colourful. Weight × saturation, lightly favouring mid tones.
  const score = (c: { hsl: Hsl; weight: number }) => c.weight * c.hsl[1] * (1 - Math.abs(c.hsl[2] - 0.5));
  const mainPick = [...vivid].sort((a, b) => score(b) - score(a))[0];
  const accentPick = mainPick
    ? [...vivid]
        .filter((c) => hueDistance(c.hsl[0], mainPick.hsl[0]) >= ACCENT_MIN_HUE_DEG)
        .sort((a, b) => score(b) - score(a))[0]
    : undefined;

  const darkest = [...hsl].sort((a, b) => a.hsl[2] - b.hsl[2])[0];
  const bgHue = darkest && darkest.hsl[1] > 0.08 ? darkest.hsl[0] : mainPick?.hsl[0];
  const background =
    bgHue === undefined ? fallback.background : hslToHex([bgHue, clamp(darkest?.hsl[1] ?? 0.3, 0.2, 0.5), 0.07]);

  if (!mainPick) return { ...fallback, background };

  const mainHue = mainPick.hsl[0];
  const main = hslToHex([mainHue, clamp(mainPick.hsl[1], 0.55, 0.85), 0.55]);
  // No distinct second colour: a warm/cool split of the main hue reads better than a clash.
  const accentHue =
    accentPick && hueDistance(accentPick.hsl[0], mainHue) >= SAME_HUE_DEG ? accentPick.hsl[0] : (mainHue + 150) % 360;
  const accent = hslToHex([accentHue, clamp(accentPick?.hsl[1] ?? 0.6, 0.5, 0.8), 0.6]);
  const highlight = hslToHex([mainHue, 0.45, 0.9]);
  return { background, main, accent, highlight };
}

/**
 * HDR/PQ → SDR display map for the household player.
 *
 * Browsers do not run a Netflix-grade HDR10+ tonemapper. PQ-tagged 4K that
 * reaches `<video>` on an SDR panel looks crushed in the shadows. This module
 * is the function the player actually applies: a CSS filter that lifts
 * shadows and slightly compresses peaks. SDR is identity (plus the user's
 * gesture brightness). No GPU, no movie file required to test.
 */

export const USER_BRIGHTNESS_MIN = 0.3;
export const USER_BRIGHTNESS_MAX = 1.5;
export const USER_BRIGHTNESS_DEFAULT = 1;

/** Extra gain on HDR10 / HLG / PQ so shadow detail is visible on SDR. */
export const HDR_SHADOW_BRIGHTNESS = 1.16;
/** Dolby Vision masters are graded hotter; they need a touch more lift. */
export const DV_SHADOW_BRIGHTNESS = 1.22;
/**
 * Contrast below 1 folds the highlights back so the brightness gain does not
 * clip them into a washed-out image.
 */
export const HDR_PEAK_CONTRAST = 0.93;
/** Tiny sat restore after the contrast fold. */
export const HDR_SATURATE = 1.03;
/** Hard cap so a maxed gesture + DV lift cannot blow the panel. */
export const MAX_DISPLAY_BRIGHTNESS = 1.6;
const PEAK_NITS_UHD = 1000;
const PEAK_NITS_HDR10_PLUS = 4000;
const PEAK_NITS_BOOST_UHD = 0.02;
const PEAK_NITS_BOOST_HDR10_PLUS = 0.04;

export type DynamicRangeLabel = "SDR" | "HDR" | "HDR10+" | "Dolby Vision";

export interface HdrSdrMapInput {
  dynamicRange: string;
  peakNits?: number | null;
  userBrightness?: number;
}

export interface HdrSdrDisplayMap {
  brightness: number;
  contrast: number;
  saturate: number;
  /** Extra shadow gain vs the user's SDR brightness. 0 = no HDR lift. */
  shadowLift: number;
  cssFilter: string;
}

export function isHdrLikeRange(dynamicRange: string): boolean {
  const label = normalizeDynamicRange(dynamicRange);
  return label !== "SDR";
}

export function normalizeDynamicRange(dynamicRange: string): DynamicRangeLabel {
  const raw = dynamicRange.trim().toLowerCase();
  if (raw.includes("dolby") || raw === "dv" || raw.includes("dvhe") || raw.includes("dvh1")) {
    return "Dolby Vision";
  }
  if (raw.includes("hdr10+") || raw.includes("hdr10plus")) return "HDR10+";
  if (
    raw === "hdr" ||
    raw === "hdr10" ||
    raw === "pq" ||
    raw === "hlg" ||
    raw.includes("smpte2084") ||
    raw.includes("arib-std-b67")
  ) {
    return "HDR";
  }
  return "SDR";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatFilter(brightness: number, contrast: number, saturate: number): string {
  if (brightness === 1 && contrast === 1 && saturate === 1) return "none";
  const parts = [`brightness(${brightness})`];
  if (contrast !== 1) parts.push(`contrast(${contrast})`);
  if (saturate !== 1) parts.push(`saturate(${saturate})`);
  return parts.join(" ");
}

/**
 * The mapping the `<video>` element uses. SDR is identity at default
 * brightness. HDR/PQ/DV get a shadow lift with peak compression.
 */
export function hdrSdrDisplayMap(input: HdrSdrMapInput): HdrSdrDisplayMap {
  const user = clamp(
    input.userBrightness ?? USER_BRIGHTNESS_DEFAULT,
    USER_BRIGHTNESS_MIN,
    USER_BRIGHTNESS_MAX
  );
  const range = normalizeDynamicRange(input.dynamicRange);
  if (range === "SDR") {
    const brightness = round4(user);
    return {
      brightness,
      contrast: 1,
      saturate: 1,
      shadowLift: 0,
      cssFilter: formatFilter(brightness, 1, 1),
    };
  }

  const baseGain = range === "Dolby Vision" ? DV_SHADOW_BRIGHTNESS : HDR_SHADOW_BRIGHTNESS;
  const peak = input.peakNits ?? 0;
  const peakBoost =
    peak >= PEAK_NITS_HDR10_PLUS
      ? PEAK_NITS_BOOST_HDR10_PLUS
      : peak >= PEAK_NITS_UHD
        ? PEAK_NITS_BOOST_UHD
        : 0;
  const brightness = round4(
    clamp(user * (baseGain + peakBoost), USER_BRIGHTNESS_MIN, MAX_DISPLAY_BRIGHTNESS)
  );
  return {
    brightness,
    contrast: HDR_PEAK_CONTRAST,
    saturate: HDR_SATURATE,
    shadowLift: round4(brightness - user),
    cssFilter: formatFilter(brightness, HDR_PEAK_CONTRAST, HDR_SATURATE),
  };
}

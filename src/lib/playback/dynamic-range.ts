/**
 * Dynamic range of the picture being played, and the viewer's say over how
 * much of it reaches the screen.
 *
 * The browser and operating system convert HDR to whatever the display can
 * show; the player never adjusts the picture with filters. An earlier build
 * brightened HDR with a CSS brightness/contrast filter, and contrast below 1
 * raised pure black to grey, which washed out every dark scene. The only
 * control now is the standard one: `dynamic-range-limit`, which keeps HDR
 * within the standard range for screens where HDR does more harm than good.
 */

export type DynamicRangeLabel = "SDR" | "HDR" | "HDR10+" | "Dolby Vision";

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

export function isHdrLikeRange(dynamicRange: string): boolean {
  return normalizeDynamicRange(dynamicRange) !== "SDR";
}

/** Whether HDR video is shown as HDR ("on") or kept to the standard range ("off"). */
export type HdrOutput = "on" | "off";

export const HDR_OUTPUT_DEFAULT: HdrOutput = "on";

export function parseHdrOutput(value: unknown): HdrOutput {
  return value === "off" ? "off" : HDR_OUTPUT_DEFAULT;
}

/**
 * The CSS `dynamic-range-limit` for a choice. "on" sets nothing, leaving the
 * browser's own behaviour untouched.
 */
export function dynamicRangeLimit(output: HdrOutput): "standard" | undefined {
  return output === "off" ? "standard" : undefined;
}

interface RangeEnvironment {
  supports(property: string, value: string): boolean;
  matches(query: string): boolean;
}

function browserEnvironment(): RangeEnvironment | null {
  if (typeof window === "undefined" || typeof CSS === "undefined" || !window.matchMedia) return null;
  return {
    supports: (property, value) => CSS.supports(property, value),
    matches: (query) => window.matchMedia(query).matches,
  };
}

/**
 * True where the HDR choice does something: the screen shows HDR and the
 * browser can be told to hold it back. Elsewhere the control is not offered.
 */
export function hdrOutputControllable(env: RangeEnvironment | null = browserEnvironment()): boolean {
  if (!env) return false;
  return env.supports("dynamic-range-limit", "standard") && env.matches("(dynamic-range: high)");
}

/** The badge beside the resolution: nothing for SDR, or for HDR the viewer has turned off. */
export function dynamicRangeBadge(dynamicRange: string, output: HdrOutput): string | null {
  const label = normalizeDynamicRange(dynamicRange);
  return label === "SDR" || output === "off" ? null : label;
}

/**
 * Dynamic range of the picture being played, and how much of it reaches the
 * screen.
 *
 * An HDR picture is graded for a screen with headroom above its ordinary
 * white, in a dim room: mid-tones sit near 26 nits and a dark scene's
 * backgrounds at a few nits. A laptop LCD has little headroom, and loses the
 * last of it as its brightness goes up, so the browser shows that grade
 * against a white twenty times brighter and everything but the faces sinks
 * into black. Turning the brightness up made it worse, not better.
 *
 * On such screens HDR is kept to the standard range (CSS `dynamic-range-limit`),
 * so the picture follows the brightness setting like everything else, and its
 * shadows and mid-tones are raised with a gamma curve. A gamma curve leaves
 * black at black and white at white: an earlier build used a brightness and
 * contrast filter for the same job, and contrast below 1 raised black to grey.
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

/** What the viewer chose on this device, or null when they have not chosen. */
export function parseHdrChoice(value: unknown): HdrOutput | null {
  return value === "on" || value === "off" ? value : null;
}

/** How far an HDR picture's shadows and mid-tones are raised when it is kept to the standard range. */
export type HdrLift = "low" | "medium" | "high";

export const HDR_LIFT_DEFAULT: HdrLift = "medium";

export function parseHdrLift(value: unknown): HdrLift {
  return value === "low" || value === "high" ? value : HDR_LIFT_DEFAULT;
}

/**
 * Gamma exponents for each lift, applied to the picture the browser has
 * already brought into the standard range. That conversion puts HDR's
 * 26-nit mid-grey at about 37% signal where a standard-range picture has it
 * at 46%; 0.75 closes that gap. 0.6 is for a bright room. 1 is no lift.
 */
const LIFT_EXPONENTS: Record<HdrLift, number> = { low: 1, medium: 0.75, high: 0.6 };

/** PQ pictures (HDR10, HDR10+). HLG is already bright in the standard range, and Dolby Vision maps itself. */
export function isPqRange(dynamicRange: string): boolean {
  const raw = dynamicRange.trim().toLowerCase();
  return raw === "pq" || raw === "hdr" || raw === "hdr10" || raw.includes("hdr10+") || raw.includes("hdr10plus") || raw.includes("smpte2084");
}

/** The gamma exponent to show this picture with, or null when it is shown untouched. */
export function hdrLiftExponent(dynamicRange: string, output: HdrOutput, lift: HdrLift): number | null {
  if (output !== "off" || !isPqRange(dynamicRange)) return null;
  const exponent = LIFT_EXPONENTS[lift];
  return exponent === 1 ? null : exponent;
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
 * What a device shows before the viewer has chosen: HDR where the browser says
 * the screen shows video in high dynamic range, the standard range elsewhere.
 *
 * `dynamic-range: high` is no guide here: a MacBook Air answers yes to it on
 * an LCD with at most twice the brightness of white to spare. Chromium answers
 * no to `video-dynamic-range: high` on that same screen, which is the answer
 * that matches what HDR looks like on it.
 */
export function defaultHdrOutput(env: RangeEnvironment | null = browserEnvironment()): HdrOutput {
  return env?.matches("(video-dynamic-range: high)") ? "on" : "off";
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

interface FrameSource {
  new (source: HTMLVideoElement): { colorSpace?: { transfer?: string | null } | null; close(): void };
}

/**
 * The range of the picture a video element is showing right now, read from
 * one of its frames: the only way to know for a file played directly, which
 * arrives with no description. Null where the browser cannot say.
 */
export function videoFrameRange(video: HTMLVideoElement, Frame: FrameSource | undefined = (globalThis as { VideoFrame?: FrameSource }).VideoFrame): "PQ" | "HLG" | null {
  if (typeof Frame !== "function") return null;
  try {
    const frame = new Frame(video);
    const transfer = frame.colorSpace?.transfer;
    frame.close();
    if (transfer === "pq") return "PQ";
    return transfer === "hlg" ? "HLG" : null;
  } catch {
    return null;
  }
}

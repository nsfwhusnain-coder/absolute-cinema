/**
 * Per-profile look and behaviour choices that follow the profile to every
 * device (Settings → You). Pure and client-safe: the server stores each one
 * as a UserSetting row; parsing accepts both what the API is sent (booleans,
 * numbers, arrays) and what the database holds (strings).
 */
import { ACCENTS, DEFAULT_ACCENT, DEFAULT_MATERIAL, type Material } from "@/lib/appearance";

export type CaptionSize = "small" | "medium" | "large" | "xlarge";
export type CaptionBackground = "box" | "shadow";
export type CaptionColor = "white" | "yellow" | "cyan" | "green";
export type CaptionFont = "sans" | "serif" | "rounded" | "mono";
export type UiScale = "default" | "large" | "larger";
/** A preset accent id, or any custom "#rrggbb". */
export type Accent = string;

export const SEEK_STEPS = [5, 10, 15, 30] as const;
export type SeekStep = (typeof SEEK_STEPS)[number];
/** Episodes in a row with no interaction before "Still watching?"; 0 = never ask. */
export const STILL_WATCHING_CHOICES = [0, 2, 3, 5] as const;
export type StillWatchingAfter = (typeof STILL_WATCHING_CHOICES)[number];

export interface ProfileExtras {
  material: Material;
  accent: Accent;
  autoplayNext: boolean;
  captionSize: CaptionSize;
  captionBackground: CaptionBackground;
  captionColor: CaptionColor;
  captionFont: CaptionFont;
  uiScale: UiScale;
  heroAutoplay: boolean;
  seekStep: SeekStep;
  autoSkipIntro: boolean;
  stillWatchingAfter: StillWatchingAfter;
  /** Home rows the profile has hidden (ids from HOME_ROWS). */
  homeHidden: string[];
}

const oneOf =
  <T extends string | number>(values: readonly T[]) =>
  (value: unknown): T | null => {
    const v = typeof values[0] === "number" && typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return (values as readonly unknown[]).includes(v) ? (v as T) : null;
  };

export function parseOnOff(value: unknown): boolean | null {
  if (value === true || value === "on") return true;
  if (value === false || value === "off") return false;
  return null;
}

export function parseAccent(value: unknown): Accent | null {
  if (typeof value !== "string") return null;
  if (ACCENTS.some((a) => a.id === value)) return value;
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

export function parseRowList(value: unknown): string[] | null {
  const items = Array.isArray(value) ? value : typeof value === "string" ? (value ? value.split(",") : []) : null;
  if (!items) return null;
  const clean = items.filter((v): v is string => typeof v === "string" && /^[a-z0-9:-]{1,40}$/.test(v));
  return clean.length === items.length ? [...new Set(clean)].slice(0, 40) : null;
}

interface ExtraSpec<T> {
  /** UserSetting key. */
  key: string;
  parse(value: unknown): T | null;
  fallback: T;
}

export const EXTRA_SPECS: { [K in keyof ProfileExtras]: ExtraSpec<ProfileExtras[K]> } = {
  material: { key: "appearance_material", parse: oneOf(["clear", "solid"] as const), fallback: DEFAULT_MATERIAL },
  accent: { key: "appearance_accent", parse: parseAccent, fallback: DEFAULT_ACCENT },
  autoplayNext: { key: "autoplay_next", parse: parseOnOff, fallback: true },
  captionSize: { key: "caption_size", parse: oneOf(["small", "medium", "large", "xlarge"] as const), fallback: "medium" },
  captionBackground: { key: "caption_background", parse: oneOf(["box", "shadow"] as const), fallback: "box" },
  captionColor: { key: "caption_color", parse: oneOf(["white", "yellow", "cyan", "green"] as const), fallback: "white" },
  captionFont: { key: "caption_font", parse: oneOf(["sans", "serif", "rounded", "mono"] as const), fallback: "sans" },
  uiScale: { key: "ui_scale", parse: oneOf(["default", "large", "larger"] as const), fallback: "default" },
  heroAutoplay: { key: "hero_autoplay", parse: parseOnOff, fallback: true },
  seekStep: { key: "seek_step", parse: oneOf(SEEK_STEPS), fallback: 10 },
  autoSkipIntro: { key: "auto_skip_intro", parse: parseOnOff, fallback: false },
  stillWatchingAfter: { key: "still_watching_after", parse: oneOf(STILL_WATCHING_CHOICES), fallback: 3 },
  homeHidden: { key: "home_hidden", parse: parseRowList, fallback: [] },
};

export const EXTRA_KEYS = Object.keys(EXTRA_SPECS) as (keyof ProfileExtras)[];

/** Stored rows (key → string) to extras, falling back to defaults for anything missing or stale. */
export function extrasFromRows(values: Map<string, string>): ProfileExtras {
  const out = {} as Record<string, unknown>;
  for (const name of EXTRA_KEYS) {
    const spec = EXTRA_SPECS[name] as ExtraSpec<unknown>;
    out[name] = spec.parse(values.get(spec.key)) ?? spec.fallback;
  }
  return out as unknown as ProfileExtras;
}

/**
 * Validates a PATCH body. Returns the rows to write, or the name of the first
 * invalid field. Fields left out are not touched.
 */
export function extrasPatch(body: Record<string, unknown>): { rows: Array<[string, string]> } | { invalid: string } {
  const rows: Array<[string, string]> = [];
  for (const name of EXTRA_KEYS) {
    if (body[name] === undefined) continue;
    const spec = EXTRA_SPECS[name] as ExtraSpec<unknown>;
    const value = spec.parse(body[name]);
    if (value === null) return { invalid: name };
    rows.push([spec.key, typeof value === "boolean" ? (value ? "on" : "off") : Array.isArray(value) ? value.join(",") : String(value)]);
  }
  return { rows };
}

/** Root font size for each interface size: everything is sized in rem, so the whole UI scales. */
export const UI_SCALE_PERCENT: Record<UiScale, number> = { default: 100, large: 112.5, larger: 125 };

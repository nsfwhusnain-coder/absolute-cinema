/**
 * Appearance, per device: the surface material (Clear glass or Solid) and
 * the accent colour. Stored in localStorage and applied by an inline script
 * before first paint, so there is never a flash of the wrong theme.
 */

export type Material = "clear" | "solid";

export const MATERIAL_KEY = "absolute-cinema:material";
export const ACCENT_KEY = "absolute-cinema:accent";
export const DEFAULT_MATERIAL: Material = "clear";

export const ACCENTS = [
  { id: "crimson", label: "Crimson", hex: "#e5383b" },
  { id: "tangerine", label: "Tangerine", hex: "#f97316" },
  { id: "amber", label: "Amber", hex: "#f59e0b" },
  { id: "lime", label: "Lime", hex: "#84cc16" },
  { id: "emerald", label: "Emerald", hex: "#10b981" },
  { id: "teal", label: "Teal", hex: "#14b8a6" },
  { id: "sky", label: "Sky", hex: "#0ea5e9" },
  { id: "indigo", label: "Indigo", hex: "#6366f1" },
  { id: "violet", label: "Violet", hex: "#8b5cf6" },
  { id: "fuchsia", label: "Fuchsia", hex: "#d946ef" },
  { id: "rose", label: "Rose", hex: "#f43f5e" },
  { id: "gold", label: "Gold", hex: "#d4a72c" },
] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];
export const DEFAULT_ACCENT: AccentId = "crimson";
export const UI_SCALE_KEY = "absolute-cinema:ui-scale";

const HEX = /^#[0-9a-f]{6}$/i;

/** The colour for a preset accent id or a custom "#rrggbb". */
export function accentHex(accent: string): string {
  if (HEX.test(accent)) return accent;
  return (ACCENTS.find((a) => a.id === accent) ?? ACCENTS[0]).hex;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the change still applies for this page */
  }
}

export function currentMaterial(): Material {
  return read(MATERIAL_KEY) === "solid" ? "solid" : DEFAULT_MATERIAL;
}

/** A preset id or a custom "#rrggbb". */
export function currentAccent(): string {
  const stored = read(ACCENT_KEY);
  return stored && (ACCENTS.some((a) => a.id === stored) || HEX.test(stored)) ? stored : DEFAULT_ACCENT;
}

export function applyMaterial(material: Material): void {
  document.documentElement.setAttribute("data-material", material);
  write(MATERIAL_KEY, material);
}

export function applyAccent(accent: string): void {
  document.documentElement.style.setProperty("--primary", accentHex(accent));
  write(ACCENT_KEY, HEX.test(accent) ? accent : (ACCENTS.find((a) => a.id === accent) ?? ACCENTS[0]).id);
}

/** Interface size: the root font size, which every rem-sized element follows. */
export function applyUiScale(percent: number): void {
  document.documentElement.style.fontSize = percent === 100 ? "" : `${percent}%`;
  write(UI_SCALE_KEY, String(percent));
}

/** ES5 inline script run in <head>-time before the first paint. */
export function appearanceBootstrapScript(): string {
  const accents = JSON.stringify(Object.fromEntries(ACCENTS.map((a) => [a.id, a.hex])));
  return `(function(){try{var d=document.documentElement,s=localStorage;
d.setAttribute("data-material",s.getItem(${JSON.stringify(MATERIAL_KEY)})==="solid"?"solid":"clear");
var k=s.getItem(${JSON.stringify(ACCENT_KEY)}),a=${accents}[k]||(/^#[0-9a-f]{6}$/i.test(k||"")?k:null);if(a)d.style.setProperty("--primary",a);
var z=Number(s.getItem(${JSON.stringify(UI_SCALE_KEY)}));if(z>100&&z<=150)d.style.fontSize=z+"%"}catch(e){}})()`;
}

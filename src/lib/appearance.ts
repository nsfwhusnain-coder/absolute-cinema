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
  { id: "amber", label: "Amber", hex: "#f59e0b" },
  { id: "emerald", label: "Emerald", hex: "#10b981" },
  { id: "sky", label: "Sky", hex: "#0ea5e9" },
  { id: "violet", label: "Violet", hex: "#8b5cf6" },
  { id: "rose", label: "Rose", hex: "#f43f5e" },
] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];
export const DEFAULT_ACCENT: AccentId = "crimson";

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

export function currentAccent(): AccentId {
  const stored = read(ACCENT_KEY);
  return ACCENTS.some((a) => a.id === stored) ? (stored as AccentId) : DEFAULT_ACCENT;
}

export function applyMaterial(material: Material): void {
  document.documentElement.setAttribute("data-material", material);
  write(MATERIAL_KEY, material);
}

export function applyAccent(id: AccentId): void {
  const accent = ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
  document.documentElement.style.setProperty("--primary", accent.hex);
  write(ACCENT_KEY, accent.id);
}

/** ES5 inline script run in <head>-time before the first paint. */
export function appearanceBootstrapScript(): string {
  const accents = JSON.stringify(Object.fromEntries(ACCENTS.map((a) => [a.id, a.hex])));
  return `(function(){try{var d=document.documentElement,s=localStorage;
d.setAttribute("data-material",s.getItem(${JSON.stringify(MATERIAL_KEY)})==="solid"?"solid":"clear");
var a=${accents}[s.getItem(${JSON.stringify(ACCENT_KEY)})];if(a)d.style.setProperty("--primary",a)}catch(e){}})()`;
}

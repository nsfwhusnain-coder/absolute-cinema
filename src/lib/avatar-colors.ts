/** Avatar colours offered when creating or editing a profile (client-safe). Any #rrggbb is accepted too. */
export const AVATAR_COLORS = [
  "#e50914",
  "#f97316",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
  "#a16207",
  "#64748b",
  "#1f2937",
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A palette colour or any custom #rrggbb from the colour picker. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

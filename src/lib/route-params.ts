/**
 * Ids in page URLs. Only plain digits count: `Number()` alone accepts "603."
 * and " 603", and turns "abc" into NaN, which redirect checks then compare
 * unequal to itself forever (a redirect loop).
 */
export function parseRouteId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** Season and episode numbers: digits only, 0 allowed (TMDB's Specials). */
export function parseRouteIndex(raw: string | undefined): number | null {
  if (raw == null || !/^\d{1,4}$/.test(raw)) return null;
  return Number(raw);
}

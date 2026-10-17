export type CachedProvider = "realdebrid" | "torbox" | "alldebrid";

/** Bump when RD roster ranking changes so old winners cannot survive the TTL. */
export const REAL_DEBRID_CACHE_POLICY = "rich-v6";
/** Bump when AllDebrid's pick changes, for the same reason. */
export const ALLDEBRID_CACHE_POLICY = "ad-v2";

export function storedQualityForCache(
  provider: CachedProvider,
  quality: string
): string {
  if (provider === "realdebrid") return `${REAL_DEBRID_CACHE_POLICY}:${quality}`;
  if (provider === "alldebrid") return `${ALLDEBRID_CACHE_POLICY}:${quality}`;
  return quality;
}

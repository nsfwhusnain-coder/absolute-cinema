import { qualityBucket, type QualityBucket } from "../metrics";

/** Longest provider name kept as a label. */
const PROVIDER_LABEL_MAX_CHARS = 24;

/**
 * A scraper provider's name as a label: lower case, letters, digits, `-` and
 * `_` only, or "other". The scraper's own names are already this; the cleaning
 * keeps a mistake from making a label of anything else.
 */
export function providerLabel(name: unknown): string {
  if (typeof name !== "string") return "other";
  const label = name.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, PROVIDER_LABEL_MAX_CHARS);
  return label || "other";
}

/** The height a quality label names ("1080p", "4K"), or 0 when it names none. */
function heightOfLabel(label: string | undefined): number {
  const digits = /(\d{3,4})p/i.exec(label ?? "");
  if (digits) return Number(digits[1]);
  return /\b4k\b/i.test(label ?? "") ? 2160 : 0;
}

/**
 * The quality bucket of one scraped stream: the height it was probed at, when
 * it was probed, else the height its quality label names. Unknown is "unknown".
 */
export function streamQualityBucket(stream: { maxHeight?: number; quality?: string }): QualityBucket {
  const probed = stream.maxHeight ?? 0;
  return qualityBucket(probed > 0 ? probed : heightOfLabel(stream.quality));
}

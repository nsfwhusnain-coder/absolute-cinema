/**
 * Picture quality on the debrid sources a client receives.
 *
 * `assessRelease` (release-quality.ts) judges a release from its name, its file
 * size and the title's runtime. The resolvers call `annotateDebridQuality` once
 * per answer, when the answer is final, to copy that judgment onto each debrid
 * source. An upscaled or starved 4K source is lowered to the height its picture
 * shows, so the client ranks and labels it as the 1080p it really is.
 */
import { assessRelease } from "../release-quality";
import type { PlaybackSource } from "../types";

/** Added to the label of a 4K-labelled source that is really an upscale. */
const UPSCALED_LABEL_SUFFIX = " · upscaled";

/**
 * Sets each debrid source's quality tier, score and flags from its release,
 * and lowers a 4K source that is upscaled or starved to the height it shows.
 *
 * The list is annotated in place. The resolvers key their bookkeeping by the
 * array's identity, so a replacement array would lose the answer's outlook.
 * A source that already carries a quality reading keeps it, so an answer that
 * is annotated again does not change its mind about the same release. Embed
 * sources, and debrid sources without a release title, are left as they are.
 * Never throws.
 */
export function annotateDebridQuality(
  sources: PlaybackSource[],
  runtimeMinutes: number | null,
  anime: boolean
): void {
  for (const source of sources) {
    if (source.origin !== "debrid" || !source.releaseTitle || source.qualityTier !== undefined) continue;
    const height = source.maxHeight;
    if (height !== 720 && height !== 1080 && height !== 2160) continue;
    const quality = assessRelease({
      releaseTitle: source.releaseTitle,
      height,
      codec: source.codec ?? "unknown",
      sizeBytes: source.sizeBytes,
      runtimeMinutes,
      anime,
    });
    source.qualityTier = quality.tier;
    source.qualityScore = quality.score;
    source.qualityFlags = quality.flags;
    if (source.sizeBytes && runtimeMinutes && runtimeMinutes > 0) {
      source.fileBitrateBps = Math.round((source.sizeBytes * 8) / (runtimeMinutes * 60));
    }
    // Bitrate is not set here: `bitrateBps` means a manifest declared it, and other code compares it with H.264 floors.
    if (quality.effectiveHeight < height) {
      source.maxHeight = quality.effectiveHeight;
      source.quality = `${quality.effectiveHeight}p`;
      if (quality.flags.includes("upscaled")) source.label += UPSCALED_LABEL_SUFFIX;
    }
  }
}

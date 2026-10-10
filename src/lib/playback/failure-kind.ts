/**
 * Whose fault a failed start was.
 *
 * What the player reports is remembered per title and per provider, not per
 * device: every screen in the house reads the same history. A file one screen
 * cannot decode is still a good file, so a failure that only says what the
 * reporting device or profile could not use must not count against the
 * source. Counted, an iPad without AV1 marked a 4K file down for the
 * television that plays it.
 */

import type { PlayerFeedback } from "./types";

/** The player gave up on the file because of its codec or its audio languages. */
const VIEWER_SIDE_REASONS: readonly RegExp[] = [
  /^media:3$/, // MEDIA_ERR_DECODE
  /^hls:buffer(AddCodec|Append|IncompatibleCodecs)Error$/,
  /^hls:manifestIncompatibleCodecsError$/,
  /Dolby Vision/i,
  /no audio in the wanted language/i,
];

/**
 * MEDIA_ERR_SRC_NOT_SUPPORTED. Through hls.js the stream had already been
 * fetched and parsed, so it means the decoder refused it; on a plain file it
 * is also what a dead link looks like, and stays the source's own failure.
 */
const UNSUPPORTED_SOURCE = /^media:4$/;

/** True when a failure says what the viewer's device or profile could not play, not that the source is bad. */
export function isViewerSideFailure(feedback: Pick<PlayerFeedback, "event" | "reason" | "errorDetail" | "engine">): boolean {
  if (feedback.event !== "handoff_failed" && feedback.event !== "decode_error") return false;
  const reason = (feedback.reason ?? feedback.errorDetail ?? "").trim();
  if (!reason) return false;
  if (UNSUPPORTED_SOURCE.test(reason)) return feedback.engine === "hlsjs";
  return VIEWER_SIDE_REASONS.some((pattern) => pattern.test(reason));
}

import { playbackAnswerSeconds, playbackAnswers } from "./web-metrics";

/**
 * The statuses an answer can carry, as the counter labels them. Anything else
 * is "other", so a new status can add one series at most, not a label per value.
 */
const STATUS_LABELS: ReadonlySet<string> = new Set([
  "available",
  "requestable",
  "external",
  "not_configured",
  "error",
  "empty",
]);

export function playbackStatusLabel(status: unknown): string {
  return typeof status === "string" && STATUS_LABELS.has(status) ? status : "other";
}

/** Counts one answer to "what can play this title", and how long it took. Never throws. */
export function recordPlaybackAnswer(input: { fast: boolean; cacheHit: boolean; status: unknown; totalMs: number }): void {
  try {
    const labels = { mode: input.fast ? "fast" : "full", cache: input.cacheHit ? "hit" : "miss" };
    playbackAnswers.inc({ ...labels, status: playbackStatusLabel(input.status) });
    if (Number.isFinite(input.totalMs) && input.totalMs >= 0) playbackAnswerSeconds.observe(labels, input.totalMs / 1000);
  } catch {
    // A failed count never breaks the answer.
  }
}

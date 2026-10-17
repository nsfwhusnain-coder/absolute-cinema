import { vodOpenSeconds, vodOpens } from "./web-metrics";

/** How a remux open ended, as the counter labels it. */
export type VodOpenOutcome = "ok" | "expired" | "refused" | "remuxer_unavailable" | "error";

/**
 * What an open answered: the HTTP status it ended with (null when the remuxer
 * could not be reached), whether the remuxer opened the file, and whether it
 * refused the file for good (the file itself cannot be started).
 */
export interface VodOpenAnswer {
  status: number | null;
  opened?: boolean;
  unusable?: boolean;
}

export function vodOpenOutcome(answer: VodOpenAnswer): VodOpenOutcome {
  if (answer.status === null) return "remuxer_unavailable";
  if (answer.status === 409) return "expired";
  if (answer.status === 415 || answer.unusable) return "refused";
  if (answer.status >= 200 && answer.status < 300 && answer.opened) return "ok";
  return "error";
}

/** Counts one remux open; the time is given only where the remuxer was asked. Never throws. */
export function recordVodOpen(outcome: VodOpenOutcome, prewarm: boolean, seconds?: number): void {
  try {
    const labels = { prewarm: String(prewarm) };
    vodOpens.inc({ outcome, ...labels });
    if (seconds !== undefined && Number.isFinite(seconds) && seconds >= 0) vodOpenSeconds.observe(labels, seconds);
  } catch {
    // A failed count never breaks the open.
  }
}

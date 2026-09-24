/**
 * Session-level circuit breaker for sources that fail repeatedly.
 *
 * The player clears its per-attempt "failed" set on roster refreshes and when
 * every source has failed, so it can retry servers whose signed URLs rotated.
 * A source that is genuinely broken (for example an MP4 the browser cannot
 * decode) then fails instantly, gets cleared, is picked again, and fails
 * again: a tight loop that was observed running for hours at ~30 ms per turn.
 *
 * Quarantine is the part that is never cleared by those resets: once a source
 * has failed QUARANTINE_FAILURES times inside QUARANTINE_WINDOW_MS, it is out
 * for the rest of the title's session.
 */
export const QUARANTINE_FAILURES = 3;
export const QUARANTINE_WINDOW_MS = 60_000;

export class SourceQuarantine {
  private readonly failures = new Map<string, number[]>();
  private readonly quarantined = new Set<string>();

  /** Records a terminal failure. Returns true when this failure quarantines the source. */
  recordFailure(sourceId: string, now = Date.now()): boolean {
    if (this.quarantined.has(sourceId)) return false;
    const recent = (this.failures.get(sourceId) ?? []).filter((t) => now - t < QUARANTINE_WINDOW_MS);
    recent.push(now);
    this.failures.set(sourceId, recent);
    if (recent.length >= QUARANTINE_FAILURES) {
      this.quarantined.add(sourceId);
      return true;
    }
    return false;
  }

  has(sourceId: string): boolean {
    return this.quarantined.has(sourceId);
  }

  /** Sources still allowed to play, preserving order. */
  filter<T extends { id: string }>(sources: readonly T[]): T[] {
    return this.quarantined.size === 0 ? [...sources] : sources.filter((s) => !this.quarantined.has(s.id));
  }

  /** New title or episode: every source gets a fresh chance. */
  reset(): void {
    this.failures.clear();
    this.quarantined.clear();
  }
}

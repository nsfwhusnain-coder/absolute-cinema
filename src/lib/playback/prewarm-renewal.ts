/**
 * How long a stay on a title's page keeps its start ready. Each renewal holds
 * the remux session for another minute or so; with no end to them, a page left
 * open in a tab nobody was looking at asked every minute for as long as it
 * stayed open (36 times in 35 minutes, once), holding a session and a paused
 * run for a film nobody was about to watch.
 */
export const PREWARM_RENEWALS_MAX = 4;

/** Whether a title's page still renews its prewarm: only while it is on screen, and only so many times. */
export function keepsWarm(renewals: number, hidden: boolean): boolean {
  return !hidden && renewals < PREWARM_RENEWALS_MAX;
}

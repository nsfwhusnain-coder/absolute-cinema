const REMUX_URL = /^\/api\/vod\/([a-f0-9]{24})\//;

/** The remux session a playable URL belongs to; null for anything that is not remuxed. */
export function remuxSessionIdOf(url: string): string | null {
  try {
    const path = url.startsWith("/") ? url : new URL(url).pathname;
    return REMUX_URL.exec(path)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Tells the server the viewer is done with a remux session. Without it the
 * remuxer went on reading the file up to four minutes ahead of where the
 * viewer had been, and held its place among the few that may run at once:
 * the next title opened against that download, and a few titles tried in a
 * row left none free. A beacon, so it is still sent as the page closes.
 */
export function leaveRemuxSession(id: string): void {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
  try {
    navigator.sendBeacon(`/api/vod/${id}/leave`);
  } catch {
    // Best effort: an idle session is stopped a few minutes later either way.
  }
}

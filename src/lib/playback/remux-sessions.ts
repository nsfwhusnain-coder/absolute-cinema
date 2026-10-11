/**
 * What each open remux session is of. The remuxer knows a session by its id
 * and nothing of where its file came from; when it finds the file cannot be
 * started, this is how the app learns which source that was, and of which
 * title.
 */

import type { PlayedTitle } from "./debrid/refused-releases";

export interface RemuxSessionOrigin {
  sourceId: string;
  title: PlayedTitle;
}

const REMEMBERED = 200;
const origins = new Map<string, RemuxSessionOrigin>();

export function rememberRemuxSession(sessionId: string, origin: RemuxSessionOrigin): void {
  origins.delete(sessionId);
  origins.set(sessionId, origin);
  while (origins.size > REMEMBERED) origins.delete(origins.keys().next().value as string);
}

export function remuxSessionOrigin(sessionId: string): RemuxSessionOrigin | null {
  return origins.get(sessionId) ?? null;
}

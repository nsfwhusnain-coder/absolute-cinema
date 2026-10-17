import { createHash } from "node:crypto";

/** Internal address of the remuxer service (mini-services/remuxer). */
export const REMUXER_URL = process.env.REMUXER_URL || "http://127.0.0.1:3040";

/** Set on a refusal that is the file's own doing and will be the same for every viewer: it cannot be started at all. */
export const UNUSABLE_HEADER = "x-vod-unusable";

/** Characters of a viewer's name the remuxer is told: enough to tell viewers apart, never the id itself. */
const WATCHER_HEX_LENGTH = 12;

/**
 * Who is asking, as the remuxer is told. Viewers of one file share its
 * session, and each viewer's seeks may only replace their own runs.
 */
export function watcherOf(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, WATCHER_HEX_LENGTH);
}

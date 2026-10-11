/** Internal address of the remuxer service (mini-services/remuxer). */
export const REMUXER_URL = process.env.REMUXER_URL || "http://127.0.0.1:3040";

/** Set on a refusal that is the file's own doing and will be the same for every viewer: it cannot be started at all. */
export const UNUSABLE_HEADER = "x-vod-unusable";

import { getFreshCachedStream } from "@/lib/playback/debrid/cached-stream";
import { parseDebridPlaybackSourceId } from "@/lib/playback/debrid/debrid-source-id";
import { lookupPlaybackSourceUrl } from "@/lib/playback/source-url-cache";
import { redeemSourceUrlTicket } from "@/lib/playback/source-url-ticket";

export interface RemuxSourceRequest {
  userId: string;
  sourceId: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
  ticket?: string | null;
}

/**
 * The upstream URL for a source the player wants remuxed. Order: the signed
 * ticket issued with the playback response, the in-process URL cache, then
 * the debrid link cache. The URL never reaches the browser.
 */
export async function resolveRemuxSourceUrl(req: RemuxSourceRequest): Promise<string | null> {
  const ticket = (req.ticket ?? "").trim();
  if (ticket) {
    const url = redeemSourceUrlTicket(ticket, { sourceId: req.sourceId, userId: req.userId });
    if (url) return url;
  }
  const cached = lookupPlaybackSourceUrl({
    userId: req.userId,
    mediaType: req.mediaType,
    tmdbId: req.tmdbId,
    season: req.season,
    episode: req.episode,
    sourceId: req.sourceId,
  });
  if (cached) return cached.url;
  const debridKey = parseDebridPlaybackSourceId(req.sourceId);
  const debridHit = debridKey ? await getFreshCachedStream(debridKey) : null;
  return debridHit?.url ?? null;
}

import { capsRuleOutFourK, isPublicInstance, playbackCaps, type Env, type PlaybackCaps } from "@/lib/public-instance";
import { parseDebridPlaybackSourceId } from "./debrid/debrid-source-id";
import { containerFromDirectUrl } from "./debrid/torrentio";
import { sourceMaxHeight } from "./source-quality";
import type { PlaybackResponse, PlaybackSource } from "./types";

/**
 * Within the caps (PLAYBACK_MAX_HEIGHT, PLAYBACK_MAX_MBPS). A ladder of
 * renditions needs one rung that is: the player climbs only as high as the
 * connection carries. A single file must be, whole; a size it does not declare
 * is not held against it.
 */
export function withinCaps(source: PlaybackSource, caps: PlaybackCaps): boolean {
  const rungs = (source.ladder ?? []).filter((height) => height > 0);
  const adaptive = rungs.length > 1;
  if (caps.maxHeight !== null && (adaptive ? Math.min(...rungs) : sourceMaxHeight(source)) > caps.maxHeight) return false;
  if (caps.maxBitrateBps !== null && !adaptive && (source.fileBitrateBps ?? source.bitrateBps ?? 0) > caps.maxBitrateBps) return false;
  return true;
}

/** The debrid services' download hosts. */
const DEBRID_HOST = /(^|\.)(real-debrid\.com|rdeb\.io|alldebrid\.com|alld\.io|debrid\.it|torbox\.app|tb-cdn\.st|premiumize\.me|debrid-link\.(com|fr))$/i;

function debridHost(url: string): boolean {
  try {
    return DEBRID_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A file from a debrid service, known by its origin, its id or its link: any one is enough to keep it from a browser. */
export function isDebridSource(source: Pick<PlaybackSource, "id" | "url" | "origin">): boolean {
  return source.origin === "debrid" || parseDebridPlaybackSourceId(source.id) !== null || debridHost(source.url);
}

/** A debrid file this server can play for a viewer itself: the remuxer reads Matroska only. */
function remuxable(source: PlaybackSource): boolean {
  const container = containerFromDirectUrl(source.url) ?? source.container;
  return container === "mkv" || container === "webm";
}

/**
 * What this server offers its viewers, of the sources found: those within the
 * caps and, on a public instance (src/lib/public-instance.ts), no debrid file
 * the browser would have to read from the debrid service itself.
 */
export function offeredSources(sources: PlaybackSource[], env: Env = process.env): PlaybackSource[] {
  const caps = playbackCaps(env);
  const sealed = isPublicInstance(env);
  if (!sealed && caps.maxHeight === null && caps.maxBitrateBps === null) return sources;
  return sources.filter((source) => withinCaps(source, caps) && (!sealed || !isDebridSource(source) || remuxable(source)));
}

/**
 * What stands in for a debrid link in what a browser is sent: the file's name
 * survives (the player reads the container from it), the link does not. The
 * remuxer is asked for the file by the source's id and ticket, and finds the
 * link on the server (remux-source.ts). `.invalid` never resolves, so nothing
 * can ever be fetched from it.
 */
export function sealedDebridUrl(source: Pick<PlaybackSource, "id" | "url">): string {
  let name = "file";
  try {
    const last = new URL(source.url).pathname.split("/").filter(Boolean).at(-1);
    if (last) name = decodeURIComponent(last);
  } catch {
    /* not a URL: the stand-in name */
  }
  return `https://debrid.invalid/${encodeURIComponent(source.id)}/${encodeURIComponent(name)}`;
}

/**
 * The playback answer as this server's browsers get it. On a public instance
 * no debrid link is left in it; with a cap below 4K it says no 4K is coming.
 * The server's own memory of the roster keeps the real links: only the reply
 * is sealed.
 */
export function servedAnswer<T extends Pick<PlaybackResponse, "sources" | "streamUrl" | "fourKSettled">>(
  answer: T,
  env: Env = process.env
): T {
  const fourK = capsRuleOutFourK(playbackCaps(env)) ? { fourKSettled: true } : {};
  if (!isPublicInstance(env)) return { ...answer, ...fourK };
  const sealedByUrl = new Map<string, string>();
  const sources = (answer.sources ?? []).map((source) => {
    if (!isDebridSource(source)) return source;
    const url = sealedDebridUrl(source);
    sealedByUrl.set(source.url, url);
    return { ...source, url };
  });
  const offered = new Set(sources.map((source) => source.url));
  // The best start's link, sealed like its source; a link to anything not offered is not passed on.
  const streamUrl = answer.streamUrl && (sealedByUrl.get(answer.streamUrl) ?? (offered.has(answer.streamUrl) ? answer.streamUrl : undefined));
  return { ...answer, ...fourK, ...(answer.sources ? { sources } : {}), streamUrl: streamUrl || undefined };
}

import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { getFreshCachedStream } from "@/lib/playback/debrid/cached-stream";
import { parseDebridPlaybackSourceId } from "@/lib/playback/debrid/debrid-source-id";
import { lookupPlaybackSourceUrl } from "@/lib/playback/source-url-cache";
import { redeemSourceUrlTicket } from "@/lib/playback/source-url-ticket";

const HEAD_TIMEOUT_MS = 8_000;
/** How long the file's server may take to start answering. The transfer itself has no limit. */
const DOWNLOAD_RESPONSE_TIMEOUT_MS = 30_000;

function safeFilename(raw: string): string {
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "").trim();
  return cleaned.slice(0, 120) || "absolute-cinema-download.mp4";
}

/**
 * `attachment; filename=...` for any title. Header values must be Latin-1, so
 * a title with a curly apostrophe, a macron or CJK characters gets an ASCII
 * stand-in in `filename` and the real name in RFC 5987 `filename*`.
 */
function contentDisposition(filename: string): string {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function extensionFromUrl(url: string): string {
  const match = url.match(/\.(mp4|mkv|mov|webm|m4v)(?:$|[?#])/i);
  return match?.[1]?.toLowerCase() ?? "mp4";
}

function parseTotalBytes(res: Response): number | null {
  const range = res.headers.get("content-range");
  const ranged = range?.match(/\/(\d+)\s*$/);
  if (ranged?.[1]) {
    const total = Number(ranged[1]);
    if (Number.isFinite(total) && total > 0) return total;
  }
  const length = Number(res.headers.get("content-length") || 0);
  return Number.isFinite(length) && length > 0 ? length : null;
}

function resolveCachedUrl(args: {
  userId: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
  sourceId: string;
  height: number;
}): string | null {
  const identity = {
    userId: args.userId,
    mediaType: args.mediaType,
    tmdbId: args.tmdbId,
    season: args.season,
    episode: args.episode,
  };
  const rung = lookupPlaybackSourceUrl({
    ...identity,
    sourceId: `${args.sourceId}::${args.height}`,
  });
  if (rung?.url) return rung.url;
  return lookupPlaybackSourceUrl({ ...identity, sourceId: args.sourceId })?.url ?? null;
}

async function resolveDownloadUrl(args: {
  userId: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
  sourceId: string;
  height: number;
  ticket: string;
}): Promise<string | null> {
  const cached = resolveCachedUrl(args);
  if (cached) return cached;
  if (args.ticket) {
    const redeemed = redeemSourceUrlTicket(args.ticket, {
      sourceId: args.sourceId,
      userId: args.userId,
    });
    if (redeemed) return redeemed;
  }
  const debridKey = parseDebridPlaybackSourceId(args.sourceId);
  if (!debridKey) return null;
  const hit = await getFreshCachedStream(debridKey);
  return hit?.url ?? null;
}

function fetchTarget(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = process.env.NEXTAUTH_URL || "http://127.0.0.1:3000";
  return new URL(url, base).toString();
}

export async function GET(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const id = Number(url.searchParams.get("id"));
  const sourceId = url.searchParams.get("sourceId") ?? "";
  const height = Number(url.searchParams.get("height") || "0");
  const ticket = (url.searchParams.get("ticket") ?? "").trim();
  const metaOnly = url.searchParams.get("meta") === "1";
  const filename = safeFilename(url.searchParams.get("filename") || "");
  const season = url.searchParams.get("season");
  const episode = url.searchParams.get("episode");
  if ((type !== "movie" && type !== "tv") || !id || !sourceId) {
    return NextResponse.json({ error: "Missing type, id, or sourceId" }, { status: 400 });
  }
  const seasonNum =
    season != null && season !== "" && Number.isFinite(Number(season))
      ? Number(season)
      : undefined;
  const episodeNum =
    episode != null && episode !== "" && Number.isFinite(Number(episode))
      ? Number(episode)
      : undefined;

  const resolved = await resolveDownloadUrl({
    userId,
    mediaType: type,
    tmdbId: id,
    season: seasonNum,
    episode: episodeNum,
    sourceId,
    height,
    ticket,
  });
  if (!resolved) {
    return NextResponse.json(
      { error: "Download source expired — play the title again" },
      { status: 409 }
    );
  }
  if (resolved.includes(".m3u8") || resolved.includes(".mpd")) {
    return NextResponse.json(
      { error: "This source is a live stream, not a downloadable file" },
      { status: 409 }
    );
  }

  const target = fetchTarget(resolved);
  if (metaOnly) {
    const head = await fetch(target, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    }).catch(() => null);
    const sizeBytes = head ? parseTotalBytes(head) : null;
    return NextResponse.json({
      sizeBytes,
      contentType: head?.headers.get("content-type") ?? null,
      filename: filename || `download.${extensionFromUrl(resolved)}`,
      container: extensionFromUrl(resolved),
    });
  }

  // The timeout covers only the wait for the response: a whole film takes far
  // longer than any fixed limit to transfer, and AbortSignal.timeout() would
  // cut the body off mid-stream. The viewer cancelling the download cancels
  // the upstream transfer too.
  const abort = new AbortController();
  const responseTimer = setTimeout(() => abort.abort(new Error("timed out waiting for the file")), DOWNLOAD_RESPONSE_TIMEOUT_MS);
  const onClientGone = () => abort.abort(new Error("download cancelled"));
  req.signal.addEventListener("abort", onClientGone, { once: true });
  const upstream = await fetch(target, {
    signal: abort.signal,
    headers: req.headers.get("range") ? { Range: req.headers.get("range")! } : undefined,
  })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 502 });
    })
    .finally(() => clearTimeout(responseTimer));
  if (!upstream.ok && upstream.status !== 206) {
    req.signal.removeEventListener("abort", onClientGone);
    void upstream.body?.cancel().catch(() => undefined);
    return NextResponse.json(
      { error: `download ${upstream.status}` },
      { status: 502 }
    );
  }

  const headers = new Headers();
  headers.set(
    "Content-Type",
    upstream.headers.get("content-type") || "application/octet-stream"
  );
  headers.set("Content-Disposition", contentDisposition(filename || `absolute-cinema.${extensionFromUrl(resolved)}`));
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  const range = upstream.headers.get("content-range");
  if (range) headers.set("Content-Range", range);
  // Lets the browser resume a download that dropped.
  if (upstream.headers.get("accept-ranges") === "bytes") headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

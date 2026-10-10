/**
 * Local range proxy in front of a remote source file.
 *
 * ffmpeg opens a Matroska file by reading its head, then its Cues at the end,
 * then seeking to the target cluster: several round trips to the debrid CDN
 * (~0.7s each) before a single frame arrives. The head and Cues were already
 * downloaded when the session was indexed, so this proxy serves those byte
 * ranges from memory and only forwards the rest upstream. A seek then costs
 * one upstream round trip instead of about six.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface CachedRange {
  start: number;
  bytes: Uint8Array;
}

export interface ProxySource {
  url: string;
  totalSize: number;
  cached: CachedRange[];
}

const UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * Upstream is asked for this much at a time, and for the next piece only once
 * this one has been handed to ffmpeg.
 *
 * Bun's fetch downloads a response as fast as the network delivers it whether
 * or not anyone is reading it. ffmpeg is paused (SIGSTOP) whenever it runs far
 * ahead of the viewer, and one open-ended request then kept filling memory
 * with the rest of the file: 20 GB in twenty minutes for a 4K release, until
 * the host ran out and went down. A window bounds what can pile up, per run,
 * to its own size. Each one costs a round trip, on a connection kept open.
 */
export const UPSTREAM_WINDOW_BYTES = 16 * 1024 * 1024;

/** A window being discarded after its reader left is given this long to finish arriving. */
const DISCARD_TIMEOUT_MS = 10_000;

/** Parses `bytes=a-` / `bytes=a-b` against a known size; null for unsatisfiable. */
export function parseRange(header: string | undefined, totalSize: number): { start: number; end: number } | null {
  if (!header) return { start: 0, end: totalSize - 1 };
  const match = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;
  return start <= end ? { start, end } : null;
}

/** The cached range covering `offset`, if any. */
export function cachedAt(cached: readonly CachedRange[], offset: number): CachedRange | null {
  return cached.find((r) => offset >= r.start && offset < r.start + r.bytes.length) ?? null;
}

/**
 * Calls `onGone` once when whoever made this request disconnects, and returns a
 * function that stops watching (for a request that finished normally, whose
 * connection may be reused).
 *
 * The response's own "close" cannot be relied on: under Bun (1.3) it is never
 * emitted when the client disconnects mid-response, only the request and its
 * socket report it. Everything here used to wait on that one event, so a
 * killed ffmpeg run was never noticed and its download carried on with nobody
 * reading it, the rest of the file arriving in memory.
 */
export function onClientGone(req: IncomingMessage, res: ServerResponse, onGone: () => void): () => void {
  const socket = req.socket;
  let done = false;
  const stop = () => {
    done = true;
    req.off("aborted", fire);
    res.off("close", fire);
    socket?.off("close", fire);
  };
  function fire(): void {
    if (done) return;
    stop();
    onGone();
  }
  req.once("aborted", fire);
  res.once("close", fire);
  socket?.once("close", fire);
  return stop;
}

/**
 * The reader of one proxied request (ffmpeg). `release` lets go of whatever
 * upstream response is in flight, and `resume` ends a wait for the socket to
 * drain, the moment the reader hangs up.
 */
interface Client {
  gone: boolean;
  release: () => void;
  resume: () => void;
}

const NOTHING = (): void => {};

/** Writes a chunk and waits until the reader has room for more, or has gone (a closed socket never drains). */
function write(res: ServerResponse, chunk: Uint8Array, client: Client): Promise<void> {
  if (res.write(chunk) || client.gone) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = () => {
      res.off("drain", settle);
      client.resume = NOTHING;
      resolve();
    };
    client.resume = settle;
    res.once("drain", settle);
  });
}

/** Serves one ranged GET, mixing cached bytes and upstream bytes in order. */
export async function serveRange(
  req: IncomingMessage,
  res: ServerResponse,
  source: ProxySource,
  windowBytes = UPSTREAM_WINDOW_BYTES
): Promise<void> {
  const range = parseRange(req.headers.range, source.totalSize);
  if (!range) {
    res.writeHead(416, { "Content-Range": `bytes */${source.totalSize}` });
    res.end();
    return;
  }
  res.writeHead(req.headers.range ? 206 : 200, {
    "Accept-Ranges": "bytes",
    "Content-Type": "video/x-matroska",
    "Content-Length": String(range.end - range.start + 1),
    ...(req.headers.range ? { "Content-Range": `bytes ${range.start}-${range.end}/${source.totalSize}` } : {}),
  });
  const client: Client = { gone: false, release: NOTHING, resume: NOTHING };
  const stopWatching = onClientGone(req, res, () => {
    client.gone = true;
    client.resume();
    client.release();
  });
  let offset = range.start;
  try {
    while (offset <= range.end && !client.gone) {
      const hit = cachedAt(source.cached, offset);
      if (hit) {
        const from = offset - hit.start;
        const to = Math.min(hit.bytes.length, range.end - hit.start + 1);
        await write(res, hit.bytes.subarray(from, to), client);
        offset = hit.start + to;
        continue;
      }
      // Stream upstream until the next cached range (or the end of the request).
      const nextCached = source.cached
        .filter((r) => r.start > offset)
        .reduce((min, r) => Math.min(min, r.start), Number.POSITIVE_INFINITY);
      const upstreamEnd = Math.min(range.end, nextCached - 1);
      offset = await streamUpstream(res, source.url, offset, upstreamEnd, client, windowBytes);
    }
    res.end();
  } catch {
    res.destroy();
  } finally {
    stopWatching();
  }
}

const STREAM_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;

/** The last byte to ask upstream for in one request starting at `offset`. */
export function windowEnd(offset: number, end: number, windowBytes: number): number {
  return Math.min(end, offset + windowBytes - 1);
}

/**
 * Copies one upstream response to `res`, reporting each chunk as it is handed
 * over.
 *
 * When the reader hangs up mid-response (every seek kills a run this way), the
 * rest of the window is still read to its end and thrown away. Aborting a
 * request whose response has data waiting leaks that data under Bun (1.3.14
 * kept about 19 MB per abort for the life of the process, measured), and a
 * body read to its end is the one ending measured to free everything.
 * Finishing a window costs at most its own size in download. Only the wait
 * for headers, when nothing has arrived yet, is ended by an abort.
 */
async function copyWindow(
  res: ServerResponse,
  url: string,
  start: number,
  end: number,
  client: Client,
  written: (bytes: number) => void
): Promise<void> {
  const waiting = new AbortController();
  const headerTimer = setTimeout(() => waiting.abort(), UPSTREAM_TIMEOUT_MS);
  client.release = () => waiting.abort();
  const upstream = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: waiting.signal,
  }).finally(() => {
    clearTimeout(headerTimer);
    client.release = NOTHING;
  });
  if (upstream.status !== 206 || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    throw new Error(`upstream HTTP ${upstream.status}`);
  }
  const reader = upstream.body.getReader();
  // The last resort for an upstream that stops sending: give up on the window.
  let giveUp: ReturnType<typeof setTimeout> | null = null;
  client.release = () => {
    giveUp ??= setTimeout(() => void reader.cancel().catch(() => {}), DISCARD_TIMEOUT_MS);
  };
  if (client.gone) client.release();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (client.gone) continue;
      await write(res, value, client);
      written(value.length);
    }
  } finally {
    client.release = NOTHING;
    if (giveUp) clearTimeout(giveUp);
  }
}

/**
 * Streams [start, end] from upstream, one window at a time over one connection
 * (parallel ranged reads were measured slower on debrid CDNs and trigger
 * connection refusals). A dropped connection resumes from the last byte
 * written. Returns the offset after the last byte written.
 */
async function streamUpstream(
  res: ServerResponse,
  url: string,
  start: number,
  end: number,
  client: Client,
  windowBytes: number
): Promise<number> {
  let offset = start;
  let failures = 0;
  const written = (bytes: number) => {
    offset += bytes;
    failures = 0;
  };
  while (offset <= end && !client.gone) {
    const last = windowEnd(offset, end, windowBytes);
    try {
      await copyWindow(res, url, offset, last, client, written);
      if (offset <= last && !client.gone) throw new Error("upstream ended early");
    } catch (err) {
      if (client.gone) break;
      failures++;
      console.log(`[proxy] upstream at ${offset} failed (${failures}/${STREAM_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`);
      if (failures >= STREAM_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (failures - 1)));
    }
  }
  return offset;
}

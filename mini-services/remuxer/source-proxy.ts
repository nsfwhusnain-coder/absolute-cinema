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

function write(res: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => res.once("drain", () => resolve()));
}

/** Serves one ranged GET, mixing cached bytes and upstream bytes in order. */
export async function serveRange(req: IncomingMessage, res: ServerResponse, source: ProxySource): Promise<void> {
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
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let offset = range.start;
  try {
    while (offset <= range.end && !abort.signal.aborted) {
      const hit = cachedAt(source.cached, offset);
      if (hit) {
        const from = offset - hit.start;
        const to = Math.min(hit.bytes.length, range.end - hit.start + 1);
        await write(res, hit.bytes.subarray(from, to));
        offset = hit.start + to;
        continue;
      }
      // Stream upstream until the next cached range (or the end of the request).
      const nextCached = source.cached
        .filter((r) => r.start > offset)
        .reduce((min, r) => Math.min(min, r.start), Number.POSITIVE_INFINITY);
      const upstreamEnd = Math.min(range.end, nextCached - 1);
      offset = await streamUpstream(res, source.url, offset, upstreamEnd, abort);
    }
    res.end();
  } catch {
    res.destroy();
  }
}

const STREAM_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;

/**
 * Streams [start, end] from upstream over one connection (parallel ranged
 * reads were measured slower on debrid CDNs and trigger connection
 * refusals). A dropped connection resumes from the last byte written.
 * Returns the offset after the last byte written.
 */
async function streamUpstream(
  res: ServerResponse,
  url: string,
  start: number,
  end: number,
  abort: AbortController
): Promise<number> {
  let offset = start;
  let failures = 0;
  while (offset <= end && !abort.signal.aborted) {
    try {
      const headerTimer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
      const upstream = await fetch(url, {
        headers: { Range: `bytes=${offset}-${end}` },
        signal: abort.signal,
      }).finally(() => clearTimeout(headerTimer));
      if (upstream.status !== 206 || !upstream.body) {
        await upstream.body?.cancel().catch(() => {});
        throw new Error(`upstream HTTP ${upstream.status}`);
      }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await write(res, value);
        offset += value.length;
        failures = 0;
      }
      if (offset <= end) throw new Error("upstream ended early");
    } catch (err) {
      if (abort.signal.aborted) break;
      failures++;
      console.log(`[proxy] upstream at ${offset} failed (${failures}/${STREAM_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`);
      if (failures >= STREAM_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (failures - 1)));
    }
  }
  return offset;
}

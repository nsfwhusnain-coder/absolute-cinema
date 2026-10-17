/**
 * Local range proxy in front of a remote source file.
 *
 * ffmpeg opens a Matroska file by reading its head, then its Cues at the end,
 * then seeking to the target cluster: several round trips to the debrid CDN
 * (~0.7s each) before a single frame arrives. The head and Cues were already
 * downloaded when the session was indexed, so this proxy serves those byte
 * ranges from memory and only forwards the rest upstream. A seek then costs
 * one upstream round trip instead of about six.
 *
 * Some debrid CDNs cap each connection far below what a file needs, and scale
 * with the number of connections. For those the proxy reads the file over
 * several connections at once (see `streamParallel`), as many as the measured
 * speed of one connection calls for.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { cdnDomainOf, isRefusal, linkRate, linkRefused, linkTurn } from "./link-pacer";

export { cdnDomainOf };

export interface CachedRange {
  start: number;
  bytes: Uint8Array;
}

export interface ProxySource {
  url: string;
  totalSize: number;
  cached: CachedRange[];
  /** A smaller window than the default, while set (a session nobody is watching yet). */
  windowBytes?: number;
  /** The file's average bitrate in bits per second, when its size and length are known: what playback needs from the proxy. */
  targetBps?: number;
  /** Upstream connections in use for this file (1 is one connection, as before). Undefined until the first probe has measured one. */
  lanes?: number;
  /** Smoothed throughput of one upstream connection, in bytes per second. */
  laneBps?: number;
  /** Until then (epoch ms) the connections may fall but not rise: the CDN refused one with 429 or 503. */
  lanesHeldUntil?: number;
}

/** The sizes the connection logic works in. Tests use smaller ones. */
export interface LaneTuning {
  /** The window one connection reads while the connections are still unknown. */
  probeBytes: number;
  /** The size parallel pieces grow to at least, and the amount of reading each throughput sample covers. */
  chunkBytes: number;
  /**
   * The smallest piece of a parallel read; its first pieces grow from about
   * this (see `rampedPieceBytes`). On a CDN giving 2 Mbit/s a connection, a
   * 2 MiB piece takes eight seconds to arrive, and the reader (ffmpeg, about
   * to make the first picture) waits on the first piece whole.
   */
  firstChunkBytes: number;
  /**
   * The most a parallel piece grows to (`chunkBytes` when unset); see
   * `steadyPieceBytes`. A CDN that limits how often a link is asked
   * (link-pacer.ts) is then asked less often for the same bytes, and a fast
   * connection spends less of its time waiting for answers.
   */
  maxPieceBytes?: number;
  /** Read-waiting time, after the settle, after which a probe may already decide on parallel connections. */
  earlyDecisionMs: number;
  /**
   * Read-waiting time at the start of a probe that its speed is not taken
   * from (none when unset). A connection reaches its speed only after a second
   * or so (TCP's slow start, and Real-Debrid ramps each download up): counted
   * from the first byte, a connection that went on at 136 Mbit/s was taken
   * for 2, and the file was read over twelve when one would do.
   */
  probeSettleMs?: number;
}

const UPSTREAM_TIMEOUT_MS = 20_000;

const DEFAULT_WINDOW_BYTES = 128 * 1024 * 1024;

/**
 * Upstream is asked for this much at a time, and for the next piece only once
 * this one has been handed to ffmpeg.
 *
 * Bun's fetch downloads a response as fast as the network delivers it whether
 * or not anyone is reading it. ffmpeg is paused (SIGSTOP) whenever it runs far
 * ahead of the viewer, and one open-ended request then kept filling memory
 * with the rest of the file. A window bounds what can wait in memory, per run,
 * to its own size.
 *
 * Each window is a request, and a debrid CDN takes most of a second to answer
 * one (0.84 s measured on a connection kept open). 128 MB keeps that under a
 * tenth of the time on a link only just fast enough for a 4K release, where
 * it matters; 16 MB cost a third of the throughput there.
 */
export const UPSTREAM_WINDOW_BYTES = Number(process.env.REMUX_WINDOW_BYTES) || DEFAULT_WINDOW_BYTES;

/** Playback needs this much spare speed over the file's bitrate, for dips. */
const HEADROOM = 2.5;
/** A file whose bitrate is unknown is planned for this much (bits per second). */
const MIN_TARGET_BPS = 8_000_000;
const MAX_LANES = 12;
/** A new sample of one connection's speed counts for this much of its smoothed value. */
const LANE_WEIGHT = 0.3;
/**
 * A sample below the smoothed speed counts for this much instead. AllDebrid
 * gives some connections 30-80 Mbit/s and most 2.5: a fast first one used to
 * leave a 4K file on one connection for a minute after the next ones came in
 * slow, while its buffer ran down.
 */
const LANE_WEIGHT_DOWN = 0.6;
/** Seconds of one connection's reading that a parallel piece grows to. */
const PIECE_SECONDS = 8;
/** The share of a link's paced rate that a parallel read plans to ask for, leaving room for its index reads and retries. */
const PACING_SHARE = 0.8;
/** After a 429 or 503 halves a file's connections, they are not raised again for this long. */
const LANE_HOLD_MS = 60_000;
/** The connections are planned again after this many completed chunks. */
const DECIDE_EVERY = 32;
/**
 * A probe that has spent this long waiting on its reads decides at once when
 * the connection is clearly too slow: at 2 Mbit/s the whole 4 MiB probe takes
 * sixteen seconds, which a viewer would spend looking at a spinner.
 */
const EARLY_DECISION_MS = 1_500;
/** A probe whose reads after the settle waited less than this is judged by the whole of it. */
const MIN_SETTLED_MS = 300;
/**
 * How long a CDN's measured speed per connection stands for the next file on
 * it. Files of one debrid service come from one CDN, which caps every
 * connection alike, so a new session starts on the connections the last one
 * found it needed instead of probing again.
 */
const DOMAIN_MEMORY_MS = 15 * 60 * 1000;
const DOMAIN_MEMORY_MAX = 64;

export const LANE_TUNING: LaneTuning = {
  probeBytes: 4 * 1024 * 1024,
  chunkBytes: 2 * 1024 * 1024,
  firstChunkBytes: 256 * 1024,
  maxPieceBytes: 8 * 1024 * 1024,
  earlyDecisionMs: EARLY_DECISION_MS,
  probeSettleMs: 1_000,
};
const domainSpeeds = new Map<string, { laneBps: number; at: number }>();

/** Notes what one connection to this file's CDN delivers, for the next file on it. */
function rememberDomainSpeed(source: ProxySource, laneBps: number, now = Date.now()): void {
  const domain = cdnDomainOf(source.url);
  if (!domain) return;
  domainSpeeds.delete(domain);
  domainSpeeds.set(domain, { laneBps, at: now });
  if (domainSpeeds.size > DOMAIN_MEMORY_MAX) domainSpeeds.delete(domainSpeeds.keys().next().value!);
}

/** What one connection to this file's CDN was last measured to deliver, while that is recent. */
export function recentDomainSpeed(url: string, now = Date.now()): number | null {
  const known = domainSpeeds.get(cdnDomainOf(url));
  return known && now - known.at < DOMAIN_MEMORY_MS ? known.laneBps : null;
}

/** A request the CDN would not serve just now (see link-pacer.ts): waited out rather than counted as a failure. */
class RefusedError extends Error {
  constructor(readonly status: number) {
    super(`upstream refused (HTTP ${status})`);
  }
}

/** Refusals in a row, each after the link's pause, before a read gives up: about half a minute. */
const MAX_REFUSALS = 8;

/** Notes a refusal against the link, and logs it once per pause (by CDN: a link is signed and never logged). */
function refused(url: string, status: number): RefusedError {
  if (linkRefused(url)) console.log(`[proxy] ${cdnDomainOf(url)} refused a request (HTTP ${status}); waiting before the next`);
  return new RefusedError(status);
}

/** Test seam: the domain memory is module state that would otherwise leak between cases. */
export function __resetDomainSpeedsForTests(): void {
  domainSpeeds.clear();
}

/**
 * How many upstream connections a file needs, given what one connection delivers.
 *
 * Playback needs the file's bitrate (or 8 Mbit/s when that is unknown), with
 * headroom for dips. One connection is enough when it is fast enough for that.
 * Otherwise the CDN caps each connection, and adds up across connections, so
 * the number needed is the shortfall divided by what one connection delivers.
 * A count within one of `current` is kept, so measurement noise does not move
 * it every few chunks.
 */
export function lanesFor(input: { targetBps?: number; laneBps: number; current?: number; maxLanes: number }): number {
  const neededBps = (Math.max(input.targetBps ?? 0, MIN_TARGET_BPS) / 8) * HEADROOM;
  if (input.laneBps >= neededBps) return 1;
  const wanted = Math.min(input.maxLanes, Math.max(2, Math.ceil(neededBps / input.laneBps)));
  if (input.current !== undefined && input.current >= 2 && Math.abs(wanted - input.current) <= 1) return input.current;
  return wanted;
}

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
  windowBytes = UPSTREAM_WINDOW_BYTES,
  tuning: LaneTuning = LANE_TUNING
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
      offset = await streamUpstream(res, source, offset, upstreamEnd, client, windowBytes, tuning);
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

/** The most one upstream request may read ahead: the window, or less while the source is prewarmed. */
function windowCap(source: ProxySource, windowBytes: number): number {
  return Math.min(windowBytes, source.windowBytes ?? windowBytes);
}

/** Whether the file is being read over several connections. */
function parallel(source: ProxySource): boolean {
  return (source.lanes ?? 0) >= 2;
}

/** Bytes received, and the time spent waiting for them. */
interface Tally {
  bytes: number;
  ms: number;
}

/** Bytes per second that a tally came to. A tally whose reads were too quick to time reads as a millisecond: fast. */
function bytesPerSecond(tally: Tally): number {
  return (tally.bytes / Math.max(tally.ms, 1)) * 1000;
}

/** What one upstream window reports as it goes. */
interface WindowReport {
  /** Bytes handed on to the reader, in order. */
  written: (bytes: number) => void;
  /** Bytes received after the first read of the response, and how long that read waited for them. */
  read: (bytes: number, waitedMs: number) => void;
  /** True once the file has moved to parallel connections, so the window ends at its next read. */
  superseded: () => boolean;
}

/**
 * Copies one upstream response to `res`, reporting each chunk as it is handed
 * over.
 *
 * When the reader hangs up mid-response (every seek kills a run this way) the
 * body is cancelled, which stops the download and frees what had arrived. The
 * request is never aborted once its response has started: under Bun (1.3.14)
 * an aborted response keeps the data it had waiting for the life of the
 * process, about 19 MB per abort when measured. Only the wait for headers,
 * when nothing has arrived yet, is ended by an abort.
 */
async function copyWindow(
  res: ServerResponse,
  url: string,
  start: number,
  end: number,
  client: Client,
  report: WindowReport
): Promise<void> {
  if (!(await linkTurn(url, () => client.gone))) return;
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
    if (isRefusal(upstream.status)) throw refused(url, upstream.status);
    throw new Error(`upstream HTTP ${upstream.status}`);
  }
  const reader = upstream.body.getReader();
  client.release = () => void reader.cancel().catch(() => {});
  if (client.gone) client.release();
  let first = true;
  try {
    while (!client.gone && !report.superseded()) {
      const started = performance.now();
      const { done, value } = await reader.read();
      if (done || client.gone) break;
      // The first read is not timed: its wait is the time to first byte, and its bytes may have
      // been sent before anyone asked, so they would make the connection look faster than it is.
      if (!first) report.read(value.length, performance.now() - started);
      first = false;
      await write(res, value, client);
      report.written(value.length);
    }
  } finally {
    client.release = NOTHING;
    await reader.cancel().catch(() => {});
  }
}

/**
 * Reads [start, end] from upstream. While the connections are not known, one
 * connection reads a short probe window and that decides them. With one
 * connection, the window is read as before, one window at a time. With several,
 * `streamParallel` reads the rest. A dropped connection resumes from the last
 * byte written. Returns the offset after the last byte written.
 */
async function streamUpstream(
  res: ServerResponse,
  source: ProxySource,
  start: number,
  end: number,
  client: Client,
  windowBytes: number,
  tuning: LaneTuning
): Promise<number> {
  let offset = start;
  let failures = 0;
  let refusals = 0;
  const written = (bytes: number) => {
    offset += bytes;
    failures = 0;
    refusals = 0;
  };
  if (source.lanes === undefined) {
    // Another file from this CDN was measured a moment ago: start where it left off.
    const known = recentDomainSpeed(source.url);
    if (known !== null) {
      source.laneBps = known;
      decide(source, known);
    }
  }
  while (offset <= end && !client.gone) {
    if (parallel(source)) {
      offset = await streamParallel(res, source, offset, end, client, windowBytes, tuning);
      continue;
    }
    const probing = source.lanes === undefined;
    const windowStart = offset;
    const settleMs = tuning.probeSettleMs ?? 0;
    let probeWaitMs = 0;
    // What arrived after the settle, and the waiting it took.
    let settledBytes = 0;
    let settledWaitMs = 0;
    const cap = windowCap(source, windowBytes);
    const last = windowEnd(offset, end, probing ? Math.min(tuning.probeBytes, cap) : cap);
    try {
      await copyWindow(res, source.url, offset, last, client, {
        written,
        read: (bytes, waitedMs) => {
          if (!probing) return measure(source, tuning, bytes, waitedMs);
          // Only reads begun after the settle count.
          const begunAt = probeWaitMs;
          probeWaitMs += waitedMs;
          if (begunAt < settleMs) return;
          settledBytes += bytes;
          settledWaitMs += waitedMs;
          if (source.lanes !== undefined || settledWaitMs < tuning.earlyDecisionMs) return;
          // Long enough to tell: a connection this slow goes parallel now, mid-probe.
          const laneBps = bytesPerSecond({ bytes: settledBytes, ms: settledWaitMs });
          if (lanesFor({ targetBps: source.targetBps, laneBps, maxLanes: MAX_LANES }) < 2) return;
          source.laneBps = laneBps;
          rememberDomainSpeed(source, laneBps);
          decide(source, laneBps);
        },
        superseded: () => parallel(source),
      });
      if (offset <= last && !client.gone && !parallel(source)) throw new Error("upstream ended early");
      if (probing && source.lanes === undefined && !client.gone) {
        // What came after the settle, when there was enough of it; else the whole probe window, its first read
        // included: a window that arrived in one read was too quick to time.
        const laneBps =
          settledWaitMs >= MIN_SETTLED_MS
            ? bytesPerSecond({ bytes: settledBytes, ms: settledWaitMs })
            : bytesPerSecond({ bytes: offset - windowStart, ms: probeWaitMs });
        source.laneBps = laneBps;
        rememberDomainSpeed(source, laneBps);
        decide(source, laneBps);
      }
    } catch (err) {
      if (client.gone) break;
      // The next turn on the link comes after its pause.
      if (err instanceof RefusedError && ++refusals < MAX_REFUSALS) continue;
      failures++;
      console.log(`[proxy] upstream at ${offset} failed (${failures}/${STREAM_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`);
      if (failures >= STREAM_ATTEMPTS || err instanceof RefusedError) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (failures - 1)));
    }
  }
  return offset;
}

/**
 * One piece of a parallel read, fetched on a connection of its own. Its bytes
 * wait here until the writer takes them.
 */
interface Piece {
  /** The first byte not yet received. */
  next: number;
  /** The last byte of the piece. */
  end: number;
  /** Bytes received and not yet handed on, in order. */
  parts: Uint8Array[];
  /** Every byte of the piece has arrived. */
  done: boolean;
  /** Set once the piece has failed for good. */
  error: Error | null;
  /** The piece has been given up: nothing more is to be fetched for it. */
  stopped: boolean;
  /** Ends the request in flight: a wait for headers is aborted, and a body is cancelled. */
  cancel: () => void;
  /** Wakes the writer when there is something new for it. */
  wake: () => void;
}

/** How many pieces may be in flight: one connection each, and no more than the window allows to wait. */
function slotsFor(source: ProxySource, windowBytes: number, tuning: LaneTuning): number {
  return Math.max(1, Math.min(source.lanes ?? 1, Math.floor(windowCap(source, windowBytes) / tuning.chunkBytes)));
}

/**
 * The size parallel pieces grow to: about PIECE_SECONDS of one connection's
 * reading, and large enough that the connections together ask the link no
 * more often than its pacing allows (link-pacer.ts: twelve connections at
 * 2.5 Mbit/s in 2 MiB pieces asked AllDebrid 1.4 times a second, past what it
 * serves). From `chunkBytes` up to `maxPieceBytes`, and never more than the
 * window lets wait in memory with every connection holding a piece.
 */
export function steadyPieceBytes(source: ProxySource, windowBytes: number, tuning: LaneTuning): number {
  const slots = slotsFor(source, windowBytes, tuning);
  const most = Math.min(tuning.maxPieceBytes ?? tuning.chunkBytes, Math.floor(windowCap(source, windowBytes) / slots));
  const laneBps = source.laneBps ?? 0;
  const forPacing = (slots * laneBps) / (PACING_SHARE * linkRate(source.url));
  return Math.max(tuning.chunkBytes, Math.min(most, Math.round(Math.max(laneBps * PIECE_SECONDS, forPacing))));
}

/**
 * The size of the `nth` piece (from 1) of one parallel read. Over the first
 * round of connections the pieces grow by equal steps to the steady size, so
 * they arrive one after another, in the order the reader needs them, and keep
 * doing so: the first in about a second, and none of the later ones holding
 * up the bytes behind it while the rest wait. Pieces that all started at once
 * and grew no further would arrive together and then leave the reader waiting
 * on the next round, a whole piece's time on a slow connection.
 */
export function rampedPieceBytes(source: ProxySource, windowBytes: number, tuning: LaneTuning, nth: number): number {
  const steady = steadyPieceBytes(source, windowBytes, tuning);
  const step = steady / slotsFor(source, windowBytes, tuning);
  return Math.min(steady, Math.max(tuning.firstChunkBytes, Math.round(nth * step)));
}

/**
 * Reads [start, end] over several connections at once, in pieces of one chunk
 * each. The piece being written streams straight to the reader as its bytes
 * arrive; the pieces behind it fill up in memory. No new piece starts while
 * as many are in flight as there are connections, so memory stays at a few
 * chunks per request. A piece that fails is retried from the last byte it had,
 * so no byte is sent twice.
 *
 * Returns the offset after the last byte written. That is short of `end` when
 * the connections drop back to one part-way, and the caller carries on with one.
 */
async function streamParallel(
  res: ServerResponse,
  source: ProxySource,
  start: number,
  end: number,
  client: Client,
  windowBytes: number,
  tuning: LaneTuning
): Promise<number> {
  const pieces: Piece[] = [];
  let next = start;
  let written = start;
  const stopAll = () => pieces.forEach(halt);
  client.release = stopAll;
  let started = 0;
  try {
    for (;;) {
      while (next <= end && parallel(source) && pieces.length < slotsFor(source, windowBytes, tuning)) {
        const pieceBytes = rampedPieceBytes(source, windowBytes, tuning, ++started);
        const piece = startPiece(source, next, Math.min(end, next + pieceBytes - 1), client, tuning);
        pieces.push(piece);
        next = piece.end + 1;
      }
      const head = pieces[0];
      if (!head) break;
      await writePiece(res, head, client);
      if (client.gone) break;
      pieces.shift();
      written = head.end + 1;
    }
  } finally {
    client.release = NOTHING;
    stopAll();
  }
  return written;
}

/** Starts fetching bytes [from, end] on a connection of its own. */
function startPiece(source: ProxySource, from: number, end: number, client: Client, tuning: LaneTuning): Piece {
  const piece: Piece = { next: from, end, parts: [], done: false, error: null, stopped: false, cancel: NOTHING, wake: NOTHING };
  download(piece, source, client, tuning).catch((err: unknown) => {
    piece.error = err instanceof Error ? err : new Error(String(err));
    piece.wake();
  });
  return piece;
}

/** Gives a piece up: it is not retried, and the request in flight for it ends. */
function halt(piece: Piece): void {
  piece.stopped = true;
  piece.cancel();
}

/**
 * Hands a piece's bytes on in order, each one as it arrives, and returns once
 * they are all handed on (or the reader has gone).
 */
async function writePiece(res: ServerResponse, piece: Piece, client: Client): Promise<void> {
  while (!client.gone) {
    const part = piece.parts.shift();
    if (part) {
      await write(res, part, client);
    } else if (piece.error) {
      throw piece.error;
    } else if (piece.done) {
      return;
    } else {
      await new Promise<void>((resolve) => {
        const wake = () => {
          piece.wake = NOTHING;
          client.resume = NOTHING;
          resolve();
        };
        piece.wake = wake;
        client.resume = wake;
      });
    }
  }
}

/**
 * Fetches a piece to the end, retrying from the last byte received after a
 * failure. Three failures in a row with no bytes between them fail the piece,
 * and with it the request. A refusal is not a failure: the piece waits for the
 * link's next turn, after its pause (up to MAX_REFUSALS in a row).
 */
async function download(piece: Piece, source: ProxySource, client: Client, tuning: LaneTuning): Promise<void> {
  let failures = 0;
  let refusals = 0;
  while (!piece.stopped && !client.gone && piece.next <= piece.end) {
    const before = piece.next;
    try {
      await fetchPiece(piece, source, client, tuning);
    } catch (err) {
      if (piece.stopped || client.gone) return;
      if (piece.next > before) refusals = 0;
      if (err instanceof RefusedError && ++refusals < MAX_REFUSALS) continue;
      if (err instanceof RefusedError) throw err;
      failures = piece.next > before ? 1 : failures + 1;
      console.log(`[proxy] upstream at ${piece.next} failed (${failures}/${STREAM_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`);
      if (failures >= STREAM_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (failures - 1)));
    }
  }
  piece.done = piece.next > piece.end;
  piece.wake();
}

/** Reads the rest of a piece from one response, handing each read's bytes to the piece. */
async function fetchPiece(piece: Piece, source: ProxySource, client: Client, tuning: LaneTuning): Promise<void> {
  const lanesWhenAsked = source.lanes;
  const url = source.url;
  if (!(await linkTurn(url, () => piece.stopped || client.gone))) return;
  const waiting = new AbortController();
  const headerTimer = setTimeout(() => waiting.abort(), UPSTREAM_TIMEOUT_MS);
  piece.cancel = () => waiting.abort();
  const upstream = await fetch(url, {
    headers: { Range: `bytes=${piece.next}-${piece.end}` },
    signal: waiting.signal,
  }).finally(() => {
    clearTimeout(headerTimer);
    piece.cancel = NOTHING;
  });
  if (upstream.status !== 206 || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    if (isRefusal(upstream.status)) {
      // A 429 or 503 may be a CDN limiting connections as well as requests.
      if (upstream.status === 429 || upstream.status === 503) backOff(source, lanesWhenAsked);
      throw refused(url, upstream.status);
    }
    throw new Error(`upstream HTTP ${upstream.status}`);
  }
  const reader = upstream.body.getReader();
  piece.cancel = () => void reader.cancel().catch(() => {});
  let first = true;
  try {
    while (!piece.stopped && !client.gone && piece.next <= piece.end) {
      const started = performance.now();
      const { done, value } = await reader.read();
      if (done) break;
      if (!first) measure(source, tuning, value.length, performance.now() - started);
      first = false;
      const part = value.subarray(0, piece.end - piece.next + 1);
      piece.parts.push(part);
      piece.next += part.length;
      piece.wake();
    }
    if (piece.next <= piece.end && !piece.stopped && !client.gone) throw new Error("upstream ended early");
  } finally {
    piece.cancel = NOTHING;
    await reader.cancel().catch(() => {});
  }
}

/**
 * A refusal from upstream means half as many connections from now on, for this
 * file, and none added back for a while. A burst of refusals to requests made
 * before the last cut is one event, not one per request, so it does not take
 * the connections straight down to one.
 */
function backOff(source: ProxySource, lanesWhenAsked: number | undefined): void {
  if (source.lanes !== lanesWhenAsked) return;
  source.lanesHeldUntil = Date.now() + LANE_HOLD_MS;
  setLanes(source, Math.max(1, Math.floor((source.lanes ?? 1) / 2)));
}

interface LaneTally extends Tally {
  /** Completed chunks so far. */
  chunks: number;
}

/** The running tally of each file's reads, across all of its connections. */
const laneTallies = new WeakMap<ProxySource, LaneTally>();

/**
 * Adds a read to the file's tally. Summed over the connections reading at once,
 * the bytes over the waiting time come to one connection's speed. Each
 * `chunkBytes` is one completed chunk: its speed is folded into `laneBps`, and
 * every `DECIDE_EVERY` chunks the connections are planned again.
 */
function measure(source: ProxySource, tuning: LaneTuning, bytes: number, waitedMs: number): void {
  const tally = laneTallies.get(source) ?? { bytes: 0, ms: 0, chunks: 0 };
  laneTallies.set(source, tally);
  tally.bytes += bytes;
  tally.ms += waitedMs;
  if (tally.bytes < tuning.chunkBytes) return;
  const sample = bytesPerSecond(tally);
  tally.bytes = 0;
  tally.ms = 0;
  tally.chunks++;
  const weight = source.laneBps !== undefined && sample < source.laneBps ? LANE_WEIGHT_DOWN : LANE_WEIGHT;
  const laneBps = source.laneBps === undefined ? sample : (1 - weight) * source.laneBps + weight * sample;
  source.laneBps = laneBps;
  rememberDomainSpeed(source, laneBps);
  // Connections are added the moment the file needs more, and taken away only
  // every DECIDE_EVERY chunks, so a dip is answered and noise is not.
  const short = lanesFor({ targetBps: source.targetBps, laneBps, current: source.lanes, maxLanes: MAX_LANES }) > (source.lanes ?? 1);
  if (short || tally.chunks % DECIDE_EVERY === 0) decide(source, laneBps);
}

/** Plans the connections for the file's measured speed (never more while they are held), and logs any change. */
function decide(source: ProxySource, laneBps: number): void {
  const lanes = lanesFor({ targetBps: source.targetBps, laneBps, current: source.lanes, maxLanes: MAX_LANES });
  const held = source.lanes !== undefined && Date.now() < (source.lanesHeldUntil ?? 0);
  setLanes(source, held ? Math.min(lanes, source.lanes!) : lanes);
}

/** Sets the connections for the file, and logs the change (with the measured speed, when there is one). */
function setLanes(source: ProxySource, lanes: number): void {
  if (lanes === source.lanes) return;
  source.lanes = lanes;
  const speed = source.laneBps === undefined ? "" : `${((source.laneBps * 8) / 1_000_000).toFixed(1)} Mbit/s per connection; `;
  console.log(`[proxy] ${speed}using ${lanes} connection${lanes === 1 ? "" : "s"}`);
}

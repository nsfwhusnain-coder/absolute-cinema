/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { cachedAt, lanesFor, parseRange, rampedPieceBytes, serveRange, steadyPieceBytes, windowEnd, __setReadIdleForTests, type LaneTuning, type ProxySource, __resetDomainSpeedsForTests, cdnDomainOf } from "./source-proxy";
import { __setLinkPacingForTests, linkRefused } from "./link-pacer";

/** Byte `i` of the pretend source file, so any slice can be checked without keeping the file. */
const byteAt = (i: number): number => (i * 7 + (i >> 9)) % 251;

function slice(start: number, end: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(end - start + 1);
  for (let i = 0; i < out.length; i++) out[i] = byteAt(start + i);
  return out;
}

const servers: Server[] = [];
// Turns as fast as the tests ask, unless a test is about the pacing.
beforeEach(() => __setLinkPacingForTests({ burst: 10_000, ratePerS: 10_000, refusalPauseMs: 50 }));
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  __resetDomainSpeedsForTests();
  __setLinkPacingForTests(null);
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

interface UpstreamOptions {
  /** Sends at this rate on each connection, instead of as fast as it is read. */
  bytesPerSecond?: number;
  /** On the first request only, stops sending after this many bytes without closing: a connection gone silent. */
  silentAfter?: number;
  /** Answers request number `request` with a Content-Range that starts this many bytes later than asked. */
  shiftStart?: (request: number) => number;
  /** After this many bytes of a response, sends at `thenBytesPerSecond` instead: a connection that speeds up. */
  slowFor?: number;
  thenBytesPerSecond?: number;
  /** Answers request number `request` (counting from 1) with `refuseStatus` (503 unless given) when this returns true. */
  refuse?: (request: number) => boolean;
  refuseStatus?: number;
}

interface Upstream {
  url: string;
  /** Every range asked for, in order. */
  asked: Array<[number, number]>;
  /** Bytes handed to the network so far: what a reader that is not reading has let pile up somewhere. */
  sent(): number;
  /** The most ranged responses being sent at once. */
  maxOpen(): number;
}

const PIECE = 64 * 1024;

/** A range-serving upstream that records what it was asked for and sent, and how many responses were open at once. */
async function upstream(totalSize: number, options: UpstreamOptions = {}): Promise<Upstream> {
  const asked: Array<[number, number]> = [];
  let sent = 0;
  let open = 0;
  let maxOpen = 0;
  const port = await listen(
    createServer((req, res) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      if (!match) return void res.writeHead(400).end();
      const end = Math.min(Number(match[2]), totalSize - 1);
      let next = Number(match[1]);
      asked.push([next, end]);
      if (options.refuse?.(asked.length)) return void res.writeHead(options.refuseStatus ?? 503).end();
      const shift = options.shiftStart?.(asked.length) ?? 0;
      if (shift) next += shift;
      const request = asked.length;
      res.writeHead(206, { "Content-Length": String(end - next + 1), "Content-Range": `bytes ${next}-${end}/${totalSize}` });
      // A response counts as open until its last byte is handed over, or its reader hangs up.
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        open--;
        req.socket.off("close", close);
      };
      open++;
      maxOpen = Math.max(maxOpen, open);
      req.socket.once("close", close);
      const first = next;
      const pump = (): void => {
        while (!closed && next <= end) {
          // A connection gone silent: nothing more is sent, and it is not closed either.
          if (request === 1 && options.silentAfter !== undefined && next - first >= options.silentAfter) return;
          const piece = slice(next, Math.min(end, next + PIECE - 1));
          next += piece.length;
          sent += piece.length;
          const room = res.write(piece);
          if (next > end) {
            close();
            return void res.end();
          }
          const rate = options.slowFor !== undefined && next - first > options.slowFor ? options.thenBytesPerSecond : options.bytesPerSecond;
          if (rate) {
            // A throttled connection waits its turn, and for the socket to take the piece, before the next one.
            const wait = (piece.length / rate) * 1000;
            return void (room ? setTimeout(pump, wait) : res.once("drain", () => setTimeout(pump, wait)));
          }
          if (!room) return void res.once("drain", pump);
        }
      };
      pump();
    })
  );
  return { url: `http://127.0.0.1:${port}/file`, asked, sent: () => sent, maxOpen: () => maxOpen };
}

async function proxy(source: ProxySource, windowBytes: number, tuning?: LaneTuning): Promise<number> {
  return listen(createServer((req, res) => void serveRange(req, res, source, windowBytes, tuning)));
}

const KB = 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A count once it has stopped moving for `quietMs`, or null when it is still
 * moving after `limitMs`: socket buffers take a varying while to fill on a busy machine.
 */
async function settled(count: () => number, quietMs = 300, limitMs = 5_000): Promise<number | null> {
  const started = Date.now();
  let last = count();
  while (Date.now() - started < limitMs) {
    await sleep(quietMs);
    const now = count();
    if (now === last) return now;
    last = now;
  }
  return null;
}

describe("parseRange", () => {
  it("reads open and closed ranges, clamped to the file", () => {
    expect(parseRange(undefined, 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=10-500", 100)).toEqual({ start: 10, end: 99 });
  });

  it("rejects what it cannot satisfy", () => {
    expect(parseRange("bytes=200-", 100)).toBeNull();
    expect(parseRange("bytes=-5", 100)).toBeNull();
    expect(parseRange("items=0-5", 100)).toBeNull();
  });
});

describe("windowEnd", () => {
  it("is one window on from the offset, and never past the end", () => {
    expect(windowEnd(0, 999, 100)).toBe(99);
    expect(windowEnd(100, 999, 100)).toBe(199);
    expect(windowEnd(950, 999, 100)).toBe(999);
  });
});

describe("cachedAt", () => {
  it("finds the cached range that covers an offset", () => {
    const cached = [{ start: 0, bytes: new Uint8Array(10) }, { start: 50, bytes: new Uint8Array(10) }];
    expect(cachedAt(cached, 5)?.start).toBe(0);
    expect(cachedAt(cached, 59)?.start).toBe(50);
    expect(cachedAt(cached, 10)).toBeNull();
    expect(cachedAt(cached, 60)).toBeNull();
  });
});

describe("lanesFor", () => {
  it("needs one connection when one is fast enough for the file", () => {
    // 8 Mbit/s with headroom needs 2.5 MB/s; one connection gives 3 MB/s.
    expect(lanesFor({ targetBps: 8_000_000, laneBps: 3_000_000, maxLanes: 12 })).toBe(1);
  });

  it("adds connections to make up the shortfall", () => {
    // A 2.1 Mbit/s connection is 262,500 B/s: 2.5 MB/s / 0.2625 MB/s = 9.5, so 10.
    expect(lanesFor({ targetBps: 8_000_000, laneBps: 2_100_000 / 8, maxLanes: 12 })).toBe(10);
  });

  it("never plans more connections than the maximum", () => {
    expect(lanesFor({ targetBps: 8_000_000, laneBps: 100_000, maxLanes: 12 })).toBe(12);
  });

  it("uses at least two connections once one is not enough", () => {
    expect(lanesFor({ targetBps: 8_000_000, laneBps: 2_400_000, maxLanes: 12 })).toBe(2);
  });

  it("plans for 8 Mbit/s when the bitrate is unknown", () => {
    expect(lanesFor({ laneBps: 1_000_000, maxLanes: 12 })).toBe(3);
    expect(lanesFor({ laneBps: 2_500_000, maxLanes: 12 })).toBe(1);
  });

  it("keeps the current count while the measurement is within one connection of it", () => {
    expect(lanesFor({ targetBps: 8_000_000, laneBps: 2_100_000 / 8, current: 9, maxLanes: 12 })).toBe(9);
    expect(lanesFor({ targetBps: 8_000_000, laneBps: 2_100_000 / 8, current: 7, maxLanes: 12 })).toBe(10);
  });
});

describe("serveRange", () => {
  it("asks upstream for one window at a time and delivers the bytes in order", async () => {
    const total = 600 * KB;
    const up = await upstream(total);
    const port = await proxy({ url: up.url, totalSize: total, cached: [] }, 64 * KB);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=1000-" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 1000-${total - 1}/${total}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(1000, total - 1));
    expect(up.asked.length).toBe(Math.ceil((total - 1000) / (64 * KB)));
    expect(up.asked.every(([start, end]) => end - start + 1 <= 64 * KB)).toBe(true);
    // Contiguous: each request starts where the last one ended.
    expect(up.asked.every(([start], i) => start === (i === 0 ? 1000 : up.asked[i - 1]![1] + 1))).toBe(true);
  });

  it("serves cached ranges from memory and only the gaps from upstream", async () => {
    const total = 300 * KB;
    const up = await upstream(total);
    const cached = [
      { start: 0, bytes: slice(0, 20 * KB - 1) },
      { start: 200 * KB, bytes: slice(200 * KB, total - 1) },
    ];
    const port = await proxy({ url: up.url, totalSize: total, cached }, 64 * KB);
    const res = await fetch(`http://127.0.0.1:${port}/src`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    expect(up.asked[0]![0]).toBe(20 * KB);
    expect(up.asked[up.asked.length - 1]![1]).toBe(200 * KB - 1);
  });

  it("answers a range it cannot satisfy with 416", async () => {
    const up = await upstream(100);
    const port = await proxy({ url: up.url, totalSize: 100, cached: [] }, 64 * KB);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=500-" } });
    expect(res.status).toBe(416);
    expect(up.asked.length).toBe(0);
  });

  it("stops downloading when the reader stops reading, and for good when it disconnects", async () => {
    // Far more than the sockets can hold: a proxy that kept downloading would
    // take the whole file from upstream with nobody reading it.
    const total = 256 * 1024 * KB;
    const windowBytes = 256 * KB;
    const up = await upstream(total);
    const port = await proxy({ url: up.url, totalSize: total, cached: [] }, windowBytes);
    const socket = connect(port, "127.0.0.1");
    let received = 0;
    socket.on("data", (chunk) => {
      received += chunk.length;
      if (received >= 512 * KB) socket.pause();
    });
    socket.on("error", () => undefined);
    socket.write("GET /src HTTP/1.1\r\nHost: test\r\nRange: bytes=0-\r\n\r\n");

    // ffmpeg paused: what upstream has sent settles at what the sockets hold, a small part of the file.
    const whilePaused = await settled(() => up.sent());
    expect(whilePaused).not.toBeNull();
    expect(whilePaused!).toBeLessThan(total / 4);

    // ffmpeg killed: at most the window in flight is finished, and nothing more is asked for.
    socket.destroy();
    const afterKill = await settled(() => up.sent());
    expect(afterKill).not.toBeNull();
    expect(afterKill!).toBeLessThanOrEqual(whilePaused! + windowBytes);
  }, 15_000);
});

describe("serveRange against a CDN that misbehaves", () => {
  afterEach(() => __setReadIdleForTests(null));

  it("asks again from where a silent connection stopped, and delivers every byte once", async () => {
    __setReadIdleForTests(200);
    const total = 512 * KB;
    const up = await upstream(total, { silentAfter: 128 * KB });
    const port = await proxy({ url: up.url, totalSize: total, cached: [], lanes: 1, laneBps: 100_000_000, targetBps: 8_000_000 }, 128 * 1024 * KB);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    expect(up.asked.length).toBe(2);
    expect(up.asked[1]![0]).toBe(128 * KB);
  });

  it("does not hand on bytes from a range that starts somewhere else", async () => {
    const total = 512 * KB;
    const up = await upstream(total, { shiftStart: (request) => (request === 1 ? 4096 : 0) });
    const port = await proxy({ url: up.url, totalSize: total, cached: [], lanes: 1, laneBps: 100_000_000, targetBps: 8_000_000 }, 128 * 1024 * KB);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    expect(up.asked.length).toBe(2);
  });
});

describe("serveRange after bytes held in memory", () => {
  const total = 1024 * KB;
  const head = { start: 0, bytes: slice(0, 64 * KB - 1) };

  it("asks upstream nothing for a reader that hangs up straight after the cached bytes", async () => {
    const up = await upstream(total);
    const port = await proxy({ url: up.url, totalSize: total, cached: [head] }, 128 * KB);
    // ffmpeg reading a file's head and jumping elsewhere: it takes what it wants of the head and hangs up.
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    let received = 0;
    await new Promise<void>((resolve) => {
      socket.on("data", (chunk) => {
        received += chunk.length;
        if (received >= 32 * KB) {
          socket.destroy();
          resolve();
        }
      });
      socket.write("GET /src HTTP/1.1\r\nHost: test\r\nRange: bytes=0-\r\n\r\n");
    });
    await sleep(400);
    expect(up.asked).toEqual([]);
  });

  it("reads on from upstream for a reader that stays", async () => {
    const up = await upstream(total);
    const port = await proxy({ url: up.url, totalSize: total, cached: [head] }, 128 * KB);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    expect(up.asked[0]![0]).toBe(64 * KB);
  });
});

describe("serveRange over several connections", () => {
  const WINDOW = 128 * 1024 * KB;
  /** Small probe and pieces, so the connections are decided within a few hundred milliseconds. */
  const TUNING: LaneTuning = { probeBytes: 256 * KB, chunkBytes: 128 * KB, firstChunkBytes: 128 * KB, earlyDecisionMs: 60_000 };
  /** A connection that delivers about 1 MB/s, the way a throttled debrid CDN does. */
  const SLOW = { bytesPerSecond: 1_000_000 };
  /** 8 MB/s with headroom: several connections at the SLOW speed. */
  const BUSY_BPS = 25_600_000;

  it("reads a throttled file over several connections and delivers every byte in order", async () => {
    const total = 2 * 1024 * KB;
    const source: ProxySource = { url: "", totalSize: total, cached: [], targetBps: BUSY_BPS };
    const up = await upstream(total, SLOW);
    source.url = up.url;
    const port = await proxy(source, WINDOW, TUNING);
    // Starts partway into a chunk, so the first piece begins at an odd offset.
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=1000-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(1000, total - 1));
    expect(source.lanes).toBeGreaterThan(1);
    expect(up.maxOpen()).toBeGreaterThan(1);
  });

  it("keeps one connection for a file that one connection can serve", async () => {
    const total = 2 * 1024 * KB;
    const source: ProxySource = { url: "", totalSize: total, cached: [], targetBps: 8_000_000 };
    const up = await upstream(total);
    source.url = up.url;
    const port = await proxy(source, WINDOW, TUNING);
    const res = await fetch(`http://127.0.0.1:${port}/src`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    expect(source.lanes).toBe(1);
    // The probe window, then the rest of the file as one window, as before.
    expect(up.asked).toEqual([
      [0, 256 * KB - 1],
      [256 * KB, total - 1],
    ]);
  });

  it("halves the connections when upstream refuses one, and still delivers every byte", async () => {
    const total = 2 * 1024 * KB;
    const source: ProxySource = { url: "", totalSize: total, cached: [], targetBps: BUSY_BPS };
    let before = 0;
    const up = await upstream(total, {
      ...SLOW,
      refuse: (request) => {
        if (request !== 3) return false;
        before = source.lanes ?? 0;
        return true;
      },
    });
    source.url = up.url;
    const port = await proxy(source, WINDOW, TUNING);
    const res = await fetch(`http://127.0.0.1:${port}/src`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    expect(before).toBeGreaterThan(1);
    expect(source.lanes).toBe(Math.max(1, Math.floor(before / 2)));
  });

  it("stops reading upstream when a parallel reader hangs up", async () => {
    const total = 32 * 1024 * KB;
    const source: ProxySource = { url: "", totalSize: total, cached: [], targetBps: BUSY_BPS };
    const up = await upstream(total, SLOW);
    source.url = up.url;
    const port = await proxy(source, WINDOW, TUNING);
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    socket.on("data", () => undefined);
    socket.write("GET /src HTTP/1.1\r\nHost: test\r\nRange: bytes=0-\r\n\r\n");
    await sleep(800);
    expect(source.lanes).toBeGreaterThan(1);
    expect(up.sent()).toBeLessThan(total / 2);

    const atKill = up.sent();
    socket.destroy();
    await sleep(300);
    const settled = up.sent();
    await sleep(300);
    expect(up.sent()).toBe(settled);
    expect(settled - atKill).toBeLessThanOrEqual(1024 * KB);
  });
});

describe("serveRange remembers a CDN's speed and decides early", () => {
  const WINDOW = 128 * 1024 * KB;
  const SLOW = { bytesPerSecond: 1_000_000 };
  const BUSY_BPS = 25_600_000;

  it("names a link's CDN by its domain, and an address by itself", () => {
    expect(cdnDomainOf("https://abc123.debrid.it/dl/x/file.mkv")).toBe("debrid.it");
    expect(cdnDomainOf("https://42.download.real-debrid.com/d/x/file.mkv")).toBe("real-debrid.com");
    expect(cdnDomainOf("http://127.0.0.1:8080/file")).toBe("127.0.0.1");
    expect(cdnDomainOf("not a url")).toBe("");
  });

  it("starts the next file on a CDN measured slow a moment ago on several connections, without probing", async () => {
    const total = 2 * 1024 * KB;
    const tuning: LaneTuning = { probeBytes: 256 * KB, chunkBytes: 128 * KB, firstChunkBytes: 128 * KB, earlyDecisionMs: 60_000 };
    const up = await upstream(total, SLOW);
    const first: ProxySource = { url: up.url, totalSize: total, cached: [], targetBps: BUSY_BPS };
    const firstPort = await proxy(first, WINDOW, tuning);
    await (await fetch(`http://127.0.0.1:${firstPort}/src`, { headers: { Range: "bytes=0-" } })).arrayBuffer();
    const askedBefore = up.asked.length;
    const second: ProxySource = { url: up.url, totalSize: total, cached: [], targetBps: BUSY_BPS };
    const secondPort = await proxy(second, WINDOW, tuning);
    const res = await fetch(`http://127.0.0.1:${secondPort}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    const [start, end] = up.asked[askedBefore]!;
    // A piece, not the probe window: the connections were known before the first request.
    expect(end - start + 1).toBeLessThanOrEqual(tuning.chunkBytes);
    expect(second.lanes).toBeGreaterThan(1);
  });

  it("takes a probe's speed from after its settle, not from a connection still getting up to speed", async () => {
    const total = 8 * 1024 * KB;
    // 0.5 s at 256 KB/s, then 10 MB/s: one connection carries 8 Mbit/s with room to spare.
    const ramp = { bytesPerSecond: 256_000, slowFor: 128 * KB, thenBytesPerSecond: 10_000_000 };
    const settled: LaneTuning = { probeBytes: 4 * 1024 * KB, chunkBytes: 128 * KB, firstChunkBytes: 128 * KB, earlyDecisionMs: 200, probeSettleMs: 500 };
    const up = await upstream(total, ramp);
    const source: ProxySource = { url: up.url, totalSize: total, cached: [], targetBps: 8_000_000 };
    const port = await proxy(source, WINDOW, settled);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    expect(source.lanes).toBe(1);

    // Judged from the first byte, the same connection looked slow enough for several.
    __resetDomainSpeedsForTests();
    const again = await upstream(total, ramp);
    const hasty: ProxySource = { url: again.url, totalSize: total, cached: [], targetBps: 8_000_000 };
    const hastyPort = await proxy(hasty, WINDOW, { ...settled, probeSettleMs: 0 });
    await (await fetch(`http://127.0.0.1:${hastyPort}/src`, { headers: { Range: "bytes=0-" } })).arrayBuffer();
    expect(hasty.lanes).toBeGreaterThan(1);
  });

  it("goes parallel part-way through a slow probe instead of waiting for its end", async () => {
    const total = 4 * 1024 * KB;
    const tuning: LaneTuning = { probeBytes: 2 * 1024 * KB, chunkBytes: 128 * KB, firstChunkBytes: 128 * KB, earlyDecisionMs: 150 };
    const up = await upstream(total, SLOW);
    const source: ProxySource = { url: up.url, totalSize: total, cached: [], targetBps: BUSY_BPS };
    const port = await proxy(source, WINDOW, tuning);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    const [, probeEnd] = up.asked[0]!;
    const [nextStart] = up.asked[1]!;
    // The probe asked for 2 MiB, and the pieces began well inside it.
    expect(probeEnd).toBe(2 * 1024 * KB - 1);
    expect(nextStart).toBeLessThan(probeEnd);
    expect(source.lanes).toBeGreaterThan(1);
  });

  it("shares the first seconds out evenly, then grows the pieces by equal steps, so they arrive in order", async () => {
    const total = 4 * 1024 * KB;
    const tuning: LaneTuning = { probeBytes: 256 * KB, chunkBytes: 256 * KB, firstChunkBytes: 32 * KB, earlyDecisionMs: 60_000 };
    const up = await upstream(total, SLOW);
    // 128 KB/s of file: six seconds of it is 768 KB, 96 KB for each of eight connections.
    // Each connection as fast as the upstream's (1 MB/s), so the reads never call for more of them mid-test.
    const source: ProxySource = { url: up.url, totalSize: total, cached: [], targetBps: 1_024_000, lanes: 8, laneBps: 1_000_000 };
    const port = await proxy(source, WINDOW, tuning);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    // In the order of the file: pieces started together reach the upstream in any order.
    const sizes = [...up.asked].sort((a, b) => a[0] - b[0]).slice(0, 17).map(([start, end]) => end - start + 1);
    expect(sizes.slice(0, 8)).toEqual(new Array(8).fill(96_000));
    // Then the steady 256 KiB in eight steps of 32 KiB.
    expect(sizes.slice(8)).toEqual([32, 64, 96, 128, 160, 192, 224, 256, 256].map((kb) => kb * KB));
  });

  it("waits out a link's 204 refusals and delivers every byte, on as many connections", async () => {
    const total = 1024 * KB;
    const tuning: LaneTuning = { probeBytes: 256 * KB, chunkBytes: 64 * KB, firstChunkBytes: 64 * KB, earlyDecisionMs: 60_000 };
    // More refusals in a row than a plain failure is allowed (three).
    const up = await upstream(total, { ...SLOW, refuseStatus: 204, refuse: (request) => request >= 2 && request <= 6 });
    const source: ProxySource = { url: up.url, totalSize: total, cached: [], targetBps: BUSY_BPS, lanes: 8, laneBps: 125_000 };
    const port = await proxy(source, WINDOW, tuning);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    expect(source.lanes).toBe(8);
  });

  it("waits out a link's refusals on a single connection too", async () => {
    const total = 512 * KB;
    const up = await upstream(total, { refuseStatus: 204, refuse: (request) => request <= 4 });
    const source: ProxySource = { url: up.url, totalSize: total, cached: [], targetBps: 8_000_000, lanes: 1, laneBps: 100_000_000 };
    const port = await proxy(source, WINDOW);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    expect(up.asked.length).toBe(5);
  });

  it("asks a refusing link no faster than its pacing allows", async () => {
    __setLinkPacingForTests({ burst: 4, ratePerS: 40, refusalPauseMs: 150, slowForMs: 60_000 });
    // Another file on the same CDN was refused: its links are paced from the start.
    linkRefused("http://127.0.0.1:1/another-file");
    const total = 1024 * KB;
    const tuning: LaneTuning = { probeBytes: 256 * KB, chunkBytes: 64 * KB, firstChunkBytes: 64 * KB, earlyDecisionMs: 60_000 };
    const askedAt: number[] = [];
    const up = await upstream(total, {
      refuseStatus: 204,
      refuse: (request) => {
        askedAt.push(Date.now());
        return request === 3;
      },
    });
    const source: ProxySource = { url: up.url, totalSize: total, cached: [], targetBps: BUSY_BPS, lanes: 8, laneBps: 125_000 };
    const port = await proxy(source, WINDOW, tuning);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    // The burst of four went out together. After the refusal: nothing for the pause,
    // then the three turns that built up over it at half the rate, then one every 50 ms.
    const refusedAt = askedAt[2]!;
    const after = askedAt.slice(4);
    expect(after[0]! - refusedAt).toBeGreaterThanOrEqual(140);
    expect(after.length).toBeGreaterThan(6);
    expect((after.at(-1)! - after[3]!) / (after.length - 4)).toBeGreaterThanOrEqual(40);
  });

  it("adds connections as soon as a file's reads slow down", async () => {
    // Remembered fast, then slow: once the samples come in, the file needs several connections.
    const total = 4 * 1024 * KB;
    const tuning: LaneTuning = { probeBytes: 256 * KB, chunkBytes: 128 * KB, firstChunkBytes: 128 * KB, earlyDecisionMs: 60_000 };
    const up = await upstream(total, SLOW);
    const source: ProxySource = { url: up.url, totalSize: total, cached: [], targetBps: BUSY_BPS, lanes: 1, laneBps: 50_000_000 };
    const port = await proxy(source, WINDOW, tuning);
    const res = await fetch(`http://127.0.0.1:${port}/src`, { headers: { Range: "bytes=0-" } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(slice(0, total - 1));
    // Thirty-two chunks (the whole file) used to pass before the connections were looked at again.
    expect(source.lanes).toBeGreaterThan(1);
    expect(up.maxOpen()).toBeGreaterThan(1);
  });

  it("grows parallel pieces to about eight seconds of one connection, within the window", () => {
    const tuning: LaneTuning = { probeBytes: 4096 * KB, chunkBytes: 2048 * KB, firstChunkBytes: 256 * KB, maxPieceBytes: 8192 * KB, earlyDecisionMs: 1_500 };
    const window = 128 * 1024 * KB;
    // 2.5 Mbit/s a connection: 2.5 MB pieces.
    expect(steadyPieceBytes({ url: "", totalSize: 0, cached: [], lanes: 12, laneBps: 312_500 }, window, tuning)).toBe(2_500_000);
    // A fast connection: the largest piece.
    expect(steadyPieceBytes({ url: "", totalSize: 0, cached: [], lanes: 4, laneBps: 10_000_000 }, window, tuning)).toBe(8192 * KB);
    // A prewarm's 24 MiB window across twelve connections: no more than 2 MiB each.
    expect(steadyPieceBytes({ url: "", totalSize: 0, cached: [], lanes: 12, laneBps: 10_000_000, windowBytes: 24 * 1024 * KB }, window, tuning)).toBe(2048 * KB);
    // Without a largest piece, pieces stay one chunk.
    expect(steadyPieceBytes({ url: "", totalSize: 0, cached: [], lanes: 4, laneBps: 10_000_000 }, window, { ...tuning, maxPieceBytes: undefined })).toBe(2048 * KB);
  });

  it("makes pieces long enough that twelve slow connections ask a link no faster than it is paced", () => {
    __setLinkPacingForTests(null);
    const tuning: LaneTuning = { probeBytes: 4096 * KB, chunkBytes: 2048 * KB, firstChunkBytes: 256 * KB, maxPieceBytes: 8192 * KB, earlyDecisionMs: 1_500 };
    const source: ProxySource = { url: "https://x.debrid.it/dl/a/file.mkv", totalSize: 0, cached: [], lanes: 12, laneBps: 312_500 };
    // 12 connections x 312.5 KB/s, at 80% of 1.2 requests a second: 3.9 MB a piece, about 0.96 requests a second.
    const steady = steadyPieceBytes(source, 128 * 1024 * KB, tuning);
    expect(steady).toBe(3_906_250);
    expect(12 / (steady / 312_500)).toBeLessThanOrEqual(1.2 * 0.8 + 1e-9);
    // The second round grows to it in twelve equal steps, from what the link's turns allow for:
    // twice the (unknown, so 8 Mbit/s) file's rate at 1.2 requests a second, 1.67 MB.
    expect(rampedPieceBytes(source, 128 * 1024 * KB, tuning, 13)).toBe(1_853_299);
    expect(rampedPieceBytes(source, 128 * 1024 * KB, tuning, 18)).toBe(2_786_458);
    expect(rampedPieceBytes(source, 128 * 1024 * KB, tuning, 24)).toBe(steady);
    expect(rampedPieceBytes(source, 128 * 1024 * KB, tuning, 40)).toBe(steady);
    // The first round: six seconds of a 16 Mbit/s file across the twelve, 1 MB each.
    expect(rampedPieceBytes({ ...source, targetBps: 16_000_000 }, 128 * 1024 * KB, tuning, 1)).toBe(1_000_000);
    expect(rampedPieceBytes({ ...source, targetBps: 16_000_000 }, 128 * 1024 * KB, tuning, 12)).toBe(1_000_000);
  });
});

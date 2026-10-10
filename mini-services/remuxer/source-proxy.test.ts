/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { cachedAt, parseRange, serveRange, windowEnd, type ProxySource } from "./source-proxy";

/** Byte `i` of the pretend source file, so any slice can be checked without keeping the file. */
const byteAt = (i: number): number => (i * 7 + (i >> 9)) % 251;

function slice(start: number, end: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(end - start + 1);
  for (let i = 0; i < out.length; i++) out[i] = byteAt(start + i);
  return out;
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

interface Upstream {
  url: string;
  /** Every range asked for, in order. */
  asked: Array<[number, number]>;
  /** Bytes handed to the network so far: what a reader that is not reading has let pile up somewhere. */
  sent(): number;
}

const PIECE = 64 * 1024;

/** A range-serving upstream that sends as fast as it is read, and records what it was asked for and sent. */
async function upstream(totalSize: number): Promise<Upstream> {
  const asked: Array<[number, number]> = [];
  let sent = 0;
  const port = await listen(
    createServer((req, res) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      if (!match) return void res.writeHead(400).end();
      const end = Math.min(Number(match[2]), totalSize - 1);
      let next = Number(match[1]);
      asked.push([next, end]);
      res.writeHead(206, { "Content-Length": String(end - next + 1), "Content-Range": `bytes ${next}-${end}/${totalSize}` });
      const pump = (): void => {
        while (next <= end) {
          const piece = slice(next, Math.min(end, next + PIECE - 1));
          next += piece.length;
          sent += piece.length;
          if (!res.write(piece)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    })
  );
  return { url: `http://127.0.0.1:${port}/file`, asked, sent: () => sent };
}

async function proxy(source: ProxySource, windowBytes: number): Promise<number> {
  return listen(createServer((req, res) => void serveRange(req, res, source, windowBytes)));
}

const KB = 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await sleep(400);
    const whilePaused = up.sent();
    await sleep(300);
    expect(up.sent()).toBe(whilePaused);
    expect(whilePaused).toBeLessThan(total / 4);

    // ffmpeg killed: at most the window in flight is finished, and nothing more is asked for.
    socket.destroy();
    await sleep(300);
    const afterKill = up.sent();
    await sleep(300);
    expect(up.sent()).toBe(afterKill);
    expect(afterKill).toBeLessThanOrEqual(whilePaused + windowBytes);
  });
});

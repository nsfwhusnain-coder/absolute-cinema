/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import type { PlaybackSource } from "../types";
import { metrics } from "../../metrics";
import { __resetCdnRatesForTests, cdnRate, measureCdnRate, recordCdnRate, settleCdnMeasurement, withCdnRates } from "./cdn-rate";

const MB = 1024 * 1024;

/** A response whose body yields `chunkBytes` every `everyMs`, for as long as it is read. */
function streaming(chunkBytes: number, everyMs: number, chunks = Infinity): typeof fetch {
  return (async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent++ >= chunks) return controller.close();
        await new Promise((resolve) => setTimeout(resolve, everyMs));
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    });
    return new Response(body, { status: 206 });
  }) as unknown as typeof fetch;
}

describe("measureCdnRate", () => {
  it("is the rate a link settles at, in bytes per second", async () => {
    // 1 MB every 100 ms is 10 MB/s.
    const rate = await measureCdnRate("https://cdn.example/file.mkv", streaming(MB, 100));
    expect(rate).toBeGreaterThan(7 * MB);
    expect(rate).toBeLessThan(13 * MB);
  }, 15_000);

  it("is null for a link that will not be read, or ends before the rate settles", async () => {
    const refused = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    expect(await measureCdnRate("https://cdn.example/file.mkv", refused)).toBeNull();
    expect(await measureCdnRate("https://cdn.example/file.mkv", streaming(MB, 10, 3))).toBeNull();
    const down = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    expect(await measureCdnRate("https://cdn.example/file.mkv", down)).toBeNull();
  });
});

describe("cdnRate", () => {
  it("is the best a service has shown lately, and nothing once that is old", () => {
    const now = 1_000_000_000;
    expect(cdnRate("torbox", now)).toBeNull();
    recordCdnRate("torbox", 5 * MB, now);
    recordCdnRate("torbox", 2 * MB, now + 60_000);
    expect(cdnRate("torbox", now + 120_000)).toBe(5 * MB);
    // The better reading has aged out; the later one still stands.
    expect(cdnRate("torbox", now + 30 * 60_000 + 30_000)).toBe(2 * MB);
    expect(cdnRate("torbox", now + 2 * 60 * 60_000)).toBeNull();
  });
});

describe("withCdnRates", () => {
  const source = (id: string, origin?: PlaybackSource["origin"]): PlaybackSource => ({ id, url: "/x", provider: "P", quality: "2160p", label: "L", type: "mp4", ...(origin ? { origin } : {}) });

  it("gives each debrid source its own service's rate, and takes away one that is no longer known", () => {
    const now = 2_000_000_000;
    recordCdnRate("alldebrid", 600_000, now);
    const [slow, unmeasured, web] = withCdnRates(
      [source("alldebrid-tt0000051-movie-0-0-2160p", "debrid"), { ...source("debrid-tt0000051-movie-0-0-safari-2160", "debrid"), cdnBytesPerSec: 9 }, source("web-1")],
      now + 1000
    );
    expect(slow?.cdnBytesPerSec).toBe(600_000);
    expect(unmeasured?.cdnBytesPerSec).toBeUndefined();
    expect(web?.cdnBytesPerSec).toBeUndefined();
  });
});

/** The value of one series in the live metrics text, or 0 while it has not been seen. */
function sample(series: string): number {
  const row = metrics().render().split("\n").find((line) => line.startsWith(`${series} `));
  return row === undefined ? 0 : Number(row.slice(series.length + 1));
}

describe("settleCdnMeasurement", () => {
  it("counts each measurement by its outcome, and keeps the rate gauge at the service's best, in bits per second", () => {
    __resetCdnRatesForTests();
    const now = 3_000_000_000;
    const ok = 'ac_web_cdn_measurements_total{service="torbox",outcome="ok"}';
    const failed = 'ac_web_cdn_measurements_total{service="torbox",outcome="failed"}';
    const gauge = 'ac_web_cdn_rate_bits{service="torbox"}';
    const okBefore = sample(ok);
    const failedBefore = sample(failed);

    settleCdnMeasurement("torbox", null, now);
    expect(sample(failed) - failedBefore).toBe(1);
    expect(sample(ok) - okBefore).toBe(0);

    settleCdnMeasurement("torbox", 5 * MB, now);
    expect(sample(ok) - okBefore).toBe(1);
    expect(sample(gauge)).toBe(5 * MB * 8);

    // A slower reading later does not pull the gauge down: the best of the last half hour stands.
    settleCdnMeasurement("torbox", 2 * MB, now + 60_000);
    expect(sample(ok) - okBefore).toBe(2);
    expect(sample(gauge)).toBe(5 * MB * 8);
    expect(sample(failed) - failedBefore).toBe(1);
  });
});

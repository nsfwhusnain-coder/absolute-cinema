/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  clampCount,
  clampNumber,
  parseDelivery,
  parseEngine,
  parseHeartbeat,
  parseSessionEnd,
  shortText,
  startFailureReason,
} from "./player-report";

const heartbeat = (overrides: Record<string, unknown> = {}) => ({
  sourceId: "vixsrc-luna-abc1234",
  provider: "Vixsrc",
  engine: "hlsjs",
  delivery: "web",
  positionS: 120,
  durationS: 5400,
  playing: true,
  paused: false,
  buffering: false,
  bufferAheadS: 14,
  decodedWidth: 1920,
  decodedHeight: 1080,
  levelBitrateBps: 6_000_000,
  bandwidthBps: 9_000_000,
  bytesLoaded: 22_000_000,
  loadMs: 4_000,
  droppedFrames: 2,
  decodedFrames: 1800,
  stalls: 0,
  stalledMs: 0,
  watchedMs: 30_000,
  audioLanguage: "en",
  subtitleLanguage: null,
  ...overrides,
});

describe("clampNumber and clampCount", () => {
  it("keeps finite numbers inside the range and pulls the rest to its edges", () => {
    expect(clampNumber(5, 10)).toBe(5);
    expect(clampNumber(50, 10)).toBe(10);
    expect(clampNumber(-3, 10)).toBe(0);
    expect(clampNumber(-3, 10, -5)).toBe(-3);
  });

  it("refuses what is not a finite number, including numeric strings and null", () => {
    expect(clampNumber(Number.NaN, 10)).toBeNull();
    expect(clampNumber(Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(clampNumber("5", 10)).toBeNull();
    expect(clampNumber(null, 10)).toBeNull();
    expect(clampNumber(undefined, 10)).toBeNull();
  });

  it("rounds counts to whole numbers", () => {
    expect(clampCount(2.6, 10)).toBe(3);
    expect(clampCount(1e9, 1e7)).toBe(1e7);
  });
});

describe("shortText", () => {
  it("trims, and cuts to the limit", () => {
    expect(shortText("  en  ", 16)).toBe("en");
    expect(shortText("abcdef", 3)).toBe("abc");
  });

  it("is null for empty text and for anything that is not text", () => {
    expect(shortText("   ", 16)).toBeNull();
    expect(shortText(12, 16)).toBeNull();
    expect(shortText(undefined, 16)).toBeNull();
  });
});

describe("parseDelivery and parseEngine", () => {
  it("accept only the known values", () => {
    expect(parseDelivery("remux")).toBe("remux");
    expect(parseDelivery("native")).toBe("native");
    expect(parseDelivery("web")).toBe("web");
    expect(parseDelivery("direct")).toBeNull();
    expect(parseEngine("native_hls")).toBe("native_hls");
    expect(parseEngine("<script>")).toBeNull();
  });
});

describe("parseHeartbeat", () => {
  it("reads a well-formed heartbeat as it was sent", () => {
    const report = parseHeartbeat(heartbeat());
    expect(report).not.toBeNull();
    expect(report!.sourceId).toBe("vixsrc-luna-abc1234");
    expect(report!.delivery).toBe("web");
    expect(report!.engine).toBe("hlsjs");
    expect(report!.bufferAheadS).toBe(14);
    expect(report!.watchedMs).toBe(30_000);
    expect(report!.subtitleLanguage).toBeNull();
    expect(report!.audioLanguage).toBe("en");
  });

  it("refuses a heartbeat that names no file", () => {
    expect(parseHeartbeat(heartbeat({ sourceId: "" }))).toBeNull();
    expect(parseHeartbeat(heartbeat({ provider: undefined }))).toBeNull();
  });

  it("clamps out-of-range numbers and drops the non-numbers", () => {
    const report = parseHeartbeat(
      heartbeat({
        bufferAheadS: 99_999,
        levelBitrateBps: 5e12,
        bandwidthBps: -4,
        droppedFrames: 1e12,
        bytesLoaded: "lots",
        watchedMs: 1e15,
      })
    );
    expect(report!.bufferAheadS).toBe(3600);
    expect(report!.levelBitrateBps).toBe(1e9);
    expect(report!.bandwidthBps).toBe(0);
    expect(report!.droppedFrames).toBe(1e7);
    expect(report!.bytesLoaded).toBeNull();
    expect(report!.watchedMs).toBe(86_400_000);
  });

  it("cuts long strings and keeps languages short", () => {
    const report = parseHeartbeat(heartbeat({ sourceId: "s".repeat(500), audioLanguage: "x".repeat(40) }));
    expect(report!.sourceId).toHaveLength(200);
    expect(report!.audioLanguage).toHaveLength(16);
  });

  it("drops every field it does not know, and never carries a link", () => {
    const report = parseHeartbeat(heartbeat({ url: "https://cdn.example/file.mkv", ip: "10.0.0.1", extra: 1 }));
    const keys = Object.keys(report!);
    expect(keys).not.toContain("url");
    expect(keys).not.toContain("ip");
    expect(keys).not.toContain("extra");
    expect(JSON.stringify(report)).not.toContain("cdn.example");
  });

  it("takes an unknown engine or delivery as unknown, not as an error", () => {
    const report = parseHeartbeat(heartbeat({ engine: "flash", delivery: "satellite" }));
    expect(report!.engine).toBeNull();
    expect(report!.delivery).toBeNull();
  });

  it("reads the playing and buffering flags only when they are true", () => {
    const report = parseHeartbeat(heartbeat({ playing: "yes", paused: 1, buffering: true }));
    expect(report!.playing).toBe(false);
    expect(report!.paused).toBe(false);
    expect(report!.buffering).toBe(true);
  });
});

describe("parseSessionEnd", () => {
  const end = (overrides: Record<string, unknown> = {}) => ({
    sourceId: "realdebrid-x-1",
    provider: "Debrid",
    engine: "native_file",
    delivery: "native",
    endReason: "left",
    watchedMs: 600_000,
    stalledMs: 2_000,
    stalls: 1,
    seeks: 3,
    startupMs: 4_100,
    maxHeight: 2160,
    avgBitrateBps: null,
    bytesLoaded: null,
    sourcesTried: 2,
    ...overrides,
  });

  it("reads a summary, with what the browser could not say as null", () => {
    const report = parseSessionEnd(end());
    expect(report!.endReason).toBe("left");
    expect(report!.startupMs).toBe(4_100);
    expect(report!.maxHeight).toBe(2160);
    expect(report!.avgBitrateBps).toBeNull();
    expect(report!.sourcesTried).toBe(2);
  });

  it("refuses an end reason it does not know, and a summary with no file", () => {
    expect(parseSessionEnd(end({ endReason: "exploded" }))).toBeNull();
    expect(parseSessionEnd(end({ endReason: undefined }))).toBeNull();
    expect(parseSessionEnd(end({ sourceId: "" }))).toBeNull();
  });

  it("clamps the counts and the times", () => {
    const report = parseSessionEnd(end({ maxHeight: 99_999, sourcesTried: 1e9, watchedMs: -5, avgBitrateBps: 1e12 }));
    expect(report!.maxHeight).toBe(4320);
    expect(report!.sourcesTried).toBe(1000);
    expect(report!.watchedMs).toBe(0);
    expect(report!.avgBitrateBps).toBe(1e9);
  });
});

describe("startFailureReason", () => {
  it("names a timeout", () => {
    expect(startFailureReason("timeout")).toBe("timeout");
  });

  it("splits a remux refusal by its status, and any other remux failure from those", () => {
    expect(startFailureReason("remux:502")).toBe("remux_502");
    expect(startFailureReason("remux open failed (502)")).toBe("remux_502");
    expect(startFailureReason("remux:415")).toBe("remux_415");
    expect(startFailureReason("remux open failed (415)")).toBe("remux_415");
    expect(startFailureReason("remux:500")).toBe("remux_other");
    expect(startFailureReason("remux open failed (503)")).toBe("remux_other");
  });

  it("separates a network fault in an HLS stream from a media fault", () => {
    expect(startFailureReason("hls:fragLoadError")).toBe("hls_network");
    expect(startFailureReason("hls:fragLoadTimeOut")).toBe("hls_network");
    expect(startFailureReason("hls:manifestLoadError")).toBe("hls_network");
    expect(startFailureReason("hls:bufferAppendError")).toBe("hls_media");
    expect(startFailureReason("hls:bufferAddCodecError")).toBe("hls_media");
  });

  it("classes an element error as media", () => {
    expect(startFailureReason("media:3")).toBe("media_error");
    expect(startFailureReason("media:4")).toBe("media_error");
  });

  it("names a file passed over for the wrong language", () => {
    expect(startFailureReason("no audio in the wanted language")).toBe("wrong_language");
  });

  it("puts everything it does not recognise in other, and nothing missing into a class of its own", () => {
    expect(startFailureReason("load failed")).toBe("other");
    expect(startFailureReason("Not found")).toBe("other");
    expect(startFailureReason(undefined)).toBe("other");
    expect(startFailureReason(null)).toBe("other");
    expect(startFailureReason("   ")).toBe("other");
  });
});

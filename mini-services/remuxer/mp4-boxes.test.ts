import { describe, expect, it } from "bun:test";
import { boxes, firstVideoDecodeTime, firstVideoPts, readVideoTrackInfo, stripEditLists } from "./mp4-boxes";

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  const size = 8 + body.length;
  return [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...Array.from(new TextEncoder().encode(type)), ...body];
}
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

function trak(trackId: number, handler: string, timescale: number, withEdts: boolean): number[] {
  const tkhd = box("tkhd", [0, 0, 0, 0], u32(0), u32(0), u32(trackId), new Array(64).fill(0));
  const mdhd = box("mdhd", [0, 0, 0, 0], u32(0), u32(0), u32(timescale), u32(0), [0, 0, 0, 0]);
  const hdlr = box("hdlr", [0, 0, 0, 0], u32(0), Array.from(new TextEncoder().encode(handler)), new Array(12).fill(0), [0]);
  const edts = withEdts ? box("edts", box("elst", [0, 0, 0, 0], u32(1), u32(721220), u32(0xffffffff), [0, 1, 0, 0])) : [];
  return box("trak", tkhd, edts, box("mdia", mdhd, hdlr));
}

function init(offsetEdit: boolean): Uint8Array {
  return new Uint8Array([
    ...box("ftyp", Array.from(new TextEncoder().encode("isom")), u32(0)),
    ...box("moov", box("mvhd", new Array(100).fill(0)), trak(1, "vide", 16000, offsetEdit), trak(2, "soun", 48000, false)),
  ]);
}

function fragment(videoDecode: number, cto: number): Uint8Array {
  // trun flags: data-offset (0x1) + sample-composition-time-offset (0x800), one sample.
  const trun = box("trun", [0, 0, 0x08, 0x01], u32(1), u32(0), u32(cto));
  const videoTraf = box("traf", box("tfhd", [0, 0, 0, 0], u32(1)), box("tfdt", [1, 0, 0, 0], u32(0), u32(videoDecode)), trun);
  const audioTraf = box("traf", box("tfhd", [0, 0, 0, 0], u32(2)), box("tfdt", [0, 0, 0, 0], u32(999)));
  return new Uint8Array([...box("moof", box("mfhd", [0, 0, 0, 0], u32(1)), audioTraf, videoTraf), ...box("mdat", [1, 2, 3])]);
}

describe("stripEditLists", () => {
  it("removes edts and fixes container sizes so different runs share one init", () => {
    const a = stripEditLists(init(true));
    const b = stripEditLists(init(false));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const moov = [...boxes(a)].find((x) => x.type === "moov")!;
    expect(moov.start + moov.size).toBe(a.length);
  });
});

describe("video track timing", () => {
  const info = readVideoTrackInfo(init(true))!;

  it("finds the video track id and timescale", () => {
    expect(info).toEqual({ trackId: 1, timescale: 16000 });
  });

  it("reads decode and presentation time of the first video sample", () => {
    const seg = fragment(16000 * 725, 2672);
    expect(firstVideoDecodeTime(seg, info)).toBe(725);
    expect(firstVideoPts(seg, info)).toBeCloseTo(725.167, 3);
  });
});

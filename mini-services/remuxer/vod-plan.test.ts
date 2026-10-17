import { describe, expect, it } from "bun:test";
import {
  Fmp4StreamSplitter,
  averageBitrateBps,
  buildVodPlaylist,
  computeSegmentBounds,
  computeSlicePlan,
  fragmentsForSegment,
  fragmentsInWindow,
  segmentForTime,
  sliceWindow,
  type FragmentRecord,
} from "./vod-plan";

const keyframesEvery = (step: number, until: number) =>
  Array.from({ length: Math.floor(until / step) + 1 }, (_, i) => +(i * step).toFixed(3));

describe("averageBitrateBps", () => {
  it("is the file's size in bits over its length, rounded", () => {
    // 62,910,411,606 bytes over two hours.
    expect(averageBitrateBps(62_910_411_606, 7200)).toBe(69_900_457);
    expect(averageBitrateBps(1_000_000, 8)).toBe(1_000_000);
  });

  it("is null when the size or the length is not known", () => {
    expect(averageBitrateBps(0, 7200)).toBeNull();
    expect(averageBitrateBps(1_000_000, 0)).toBeNull();
    expect(averageBitrateBps(-1, 7200)).toBeNull();
    expect(averageBitrateBps(Number.NaN, 7200)).toBeNull();
    expect(averageBitrateBps(1_000_000, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("computeSegmentBounds", () => {
  it("starts segments on the first keyframe at least the target length after the last", () => {
    expect(computeSegmentBounds(keyframesEvery(4, 40), 41, 6)).toEqual([0, 8, 16, 24, 32, 41]);
  });

  it("merges a very short tail into the previous segment", () => {
    // Keyframe at 36 would leave a 1s final segment; it folds into [30, 37).
    expect(computeSegmentBounds([0, 6, 12, 18, 24, 30, 36], 37, 6)).toEqual([0, 6, 12, 18, 24, 30, 37]);
  });

  it("handles irregular keyframes and ignores ones past the end", () => {
    expect(computeSegmentBounds([0, 3.4, 6.8, 10.3, 13.7, 50], 20, 6)).toEqual([0, 6.8, 13.7, 20]);
  });
});

describe("segmentForTime", () => {
  const bounds = [0, 6, 12, 18, 20];
  it("finds the containing segment and clamps out-of-range times", () => {
    expect(segmentForTime(bounds, -3)).toBe(0);
    expect(segmentForTime(bounds, 5.99)).toBe(0);
    expect(segmentForTime(bounds, 6)).toBe(1);
    expect(segmentForTime(bounds, 19)).toBe(3);
    expect(segmentForTime(bounds, 99)).toBe(3);
  });
});

describe("buildVodPlaylist", () => {
  it("lists every segment with its exact duration and ends the list", () => {
    const text = buildVodPlaylist([0, 6.5, 12, 14]);
    expect(text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(text).toContain("#EXT-X-TARGETDURATION:7");
    expect(text).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(text).toContain("#EXTINF:6.500000,\n0.m4s");
    expect(text).toContain("#EXTINF:2.000000,\n2.m4s");
    expect(text.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });
});

describe("fragmentsForSegment", () => {
  const bounds = [0, 6, 12, 15];
  const frag = (time: number): FragmentRecord => ({ time, path: `${time}.m4s`, bytes: 1 });

  it("returns a segment once the run has produced past its end", () => {
    const fragments = [0, 3, 6, 9].map(frag);
    expect(fragmentsForSegment(bounds, 0, fragments, false)?.map((f) => f.time)).toEqual([0, 3]);
    expect(fragmentsForSegment(bounds, 1, fragments, false)).toBeNull();
    expect(fragmentsForSegment(bounds, 1, [...fragments, frag(12)], false)?.map((f) => f.time)).toEqual([6, 9]);
  });

  it("accepts a run that started one keyframe early", () => {
    expect(fragmentsForSegment(bounds, 1, [3, 6, 9, 12].map(frag), false)?.map((f) => f.time)).toEqual([6, 9]);
  });

  it("rejects a run that started after the segment began", () => {
    expect(fragmentsForSegment(bounds, 1, [9, 12].map(frag), false)).toBeNull();
  });

  it("completes the final segment when the run finishes", () => {
    const fragments = [12, 14].map(frag);
    expect(fragmentsForSegment(bounds, 2, fragments, false)).toBeNull();
    expect(fragmentsForSegment(bounds, 2, fragments, true)?.map((f) => f.time)).toEqual([12, 14]);
  });
});

describe("slices", () => {
  // A ten-second keyframe interval, a three-second one, and a short tail.
  const bounds = [0, 10, 13, 13.6];
  const plan = computeSlicePlan(bounds, 2);
  const frag = (time: number): FragmentRecord => ({ time, path: `${time}.m4s`, bytes: 1 });
  const everyHalfSecond = (from: number, to: number) =>
    Array.from({ length: Math.round((to - from) / 0.5) }, (_, i) => frag(from + i * 0.5));

  it("cuts each segment into equal slices of about the target, and never across a segment", () => {
    expect(plan.bounds).toEqual([0, 2, 4, 6, 8, 10, 11.5, 13, 13.6]);
    expect(plan.segmentOf).toEqual([0, 0, 0, 0, 0, 1, 1, 2]);
  });

  it("lists slices under their own names and does not call them independent", () => {
    const text = buildVodPlaylist(plan.bounds, "s", false);
    expect(text).toContain("#EXTINF:2.000000,\ns0.m4s");
    expect(text).toContain("#EXTINF:1.500000,\ns6.m4s");
    expect(text).not.toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    expect(buildVodPlaylist(bounds)).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
  });

  it("gives a slice the fragments that start inside it, once the run is past it", () => {
    const window = sliceWindow(bounds, plan, 1);
    expect(fragmentsInWindow(window, everyHalfSecond(0, 4), false)).toBeNull();
    expect(fragmentsInWindow(window, everyHalfSecond(0, 4.5), false)?.map((f) => f.time)).toEqual([2, 2.5, 3, 3.5]);
  });

  it("serves a slice only from a run that began at its segment's keyframe or before", () => {
    // A run started at the second segment holds nothing the first one's slices can use.
    expect(fragmentsInWindow(sliceWindow(bounds, plan, 4), everyHalfSecond(10, 13), false)).toBeNull();
    // A slice in the middle of a segment needs the run to have begun at that segment's start.
    expect(fragmentsInWindow(sliceWindow(bounds, plan, 6), everyHalfSecond(10, 13.6), false)?.map((f) => f.time)).toEqual([11.5, 12, 12.5]);
    expect(fragmentsInWindow(sliceWindow(bounds, plan, 6), everyHalfSecond(11.5, 13.6), false)).toBeNull();
  });

  it("returns an empty slice rather than waiting when no fragment starts in it", () => {
    // One fragment covers 2 to 4.2 (a still picture): nothing starts in the second slice.
    const fragments = [0, 0.5, 1, 1.5, 4.2, 4.7].map(frag);
    expect(fragmentsInWindow(sliceWindow(bounds, plan, 1), fragments, false)).toEqual([]);
  });

  it("ends the last slice when the run does", () => {
    const window = sliceWindow(bounds, plan, 7);
    const fragments = [13, 13.5].map(frag);
    expect(fragmentsInWindow(window, fragments, false)).toBeNull();
    expect(fragmentsInWindow(window, fragments, true)?.map((f) => f.time)).toEqual([13, 13.5]);
  });
});

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}

describe("Fmp4StreamSplitter", () => {
  it("emits the init once, then each moof+mdat pair, across arbitrary chunking", () => {
    const stream = [
      box("ftyp", new Uint8Array(4)),
      box("moov", new Uint8Array(20)),
      box("moof", new Uint8Array([1])),
      box("mdat", new Uint8Array(1000).fill(7)),
      box("moof", new Uint8Array([2])),
      box("mdat", new Uint8Array(5).fill(9)),
    ];
    const all = new Uint8Array(stream.reduce((s, b) => s + b.length, 0));
    let o = 0;
    for (const b of stream) {
      all.set(b, o);
      o += b.length;
    }
    const splitter = new Fmp4StreamSplitter();
    const out: Array<{ kind: "init" | "fragment"; bytes: Uint8Array }> = [];
    for (let i = 0; i < all.length; i += 7) out.push(...splitter.push(all.subarray(i, i + 7)));
    expect(out.map((p) => p.kind)).toEqual(["init", "fragment", "fragment"]);
    expect(out[0]!.bytes.length).toBe(stream[0]!.length + stream[1]!.length);
    expect(out[1]!.bytes.length).toBe(stream[2]!.length + stream[3]!.length);
    expect(out[2]!.bytes[out[2]!.bytes.length - 1]).toBe(9);
  });
});

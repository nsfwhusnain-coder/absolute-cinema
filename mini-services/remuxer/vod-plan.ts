/**
 * Pure planning logic for keyframe-exact video-on-demand remuxing.
 *
 * A title's segment boundaries are chosen once, from its keyframe index, so
 * the playlist is complete (full duration, seekable anywhere) before a single
 * byte has been remuxed. ffmpeg then emits one fragment per keyframe; each
 * fragment is filed under the segment its keyframe belongs to. Any ffmpeg run,
 * started from any segment, produces the same fragments, so segments are
 * identical regardless of where playback started or how often the viewer
 * seeks.
 */

/** Nominal segment length. Segments end on the first keyframe at or after it. */
export const TARGET_SEGMENT_S = 3;
/** Keyframe times within this distance are treated as the same keyframe. */
export const KEYFRAME_MATCH_TOLERANCE_S = 0.06;

/**
 * Segment start times: 0, then the first keyframe at least TARGET_SEGMENT_S
 * after the previous boundary. The final entry is the title's duration, so
 * `bounds.length - 1` is the segment count.
 */
export function computeSegmentBounds(
  keyframes: readonly number[],
  durationS: number,
  targetS = TARGET_SEGMENT_S
): number[] {
  const bounds = [0];
  for (const time of keyframes) {
    if (time >= durationS) break;
    if (time >= bounds[bounds.length - 1]! + targetS) bounds.push(time);
  }
  // A tail shorter than a third of a segment merges into the previous one.
  if (bounds.length > 1 && durationS - bounds[bounds.length - 1]! < targetS / 3) bounds.pop();
  bounds.push(durationS);
  return bounds;
}

/** Index of the segment containing time `t` (clamped to the valid range). */
export function segmentForTime(bounds: readonly number[], t: number): number {
  const last = bounds.length - 2;
  if (t <= 0) return 0;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bounds[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Nominal length of the slices a segment is cut into for players that can start between keyframes. */
export const TARGET_SLICE_S = 2;
/** URI prefix of a slice, beside the segments' bare numbers. */
export const SLICE_PREFIX = "s";

/**
 * A finer cut of the same timeline. A segment runs from keyframe to keyframe,
 * and releases with a keyframe every ten seconds make that 45 MB of 4K a
 * player has to receive whole before it shows a frame. A player built on
 * Media Source Extensions appends whatever arrives, so for it each segment is
 * divided into slices of about TARGET_SLICE_S. Only a segment's first slice
 * opens on a keyframe: the rest continue it, and play in sequence but cannot
 * be jumped into (a jump goes to the segment's start, see `seekPoint`).
 */
export interface SlicePlan {
  /** Slice start times; the final entry is the title's duration. */
  bounds: number[];
  /** Index of the segment each slice belongs to. */
  segmentOf: number[];
}

export function computeSlicePlan(bounds: readonly number[], targetS = TARGET_SLICE_S): SlicePlan {
  const starts: number[] = [];
  const segmentOf: number[] = [];
  for (let segment = 0; segment < bounds.length - 1; segment++) {
    const start = bounds[segment]!;
    const length = bounds[segment + 1]! - start;
    const count = Math.max(1, Math.round(length / targetS));
    for (let i = 0; i < count; i++) {
      starts.push(start + (length * i) / count);
      segmentOf.push(segment);
    }
  }
  return { bounds: [...starts, bounds[bounds.length - 1]!], segmentOf };
}

/**
 * Complete VOD playlist; URIs are `<prefix><index>.m4s` beside `init.mp4`.
 * `independent` says every entry opens on a keyframe (segments do, slices do not).
 */
export function buildVodPlaylist(bounds: readonly number[], prefix = "", independent = true): string {
  const durations = bounds.slice(1).map((end, i) => end - bounds[i]!);
  const target = Math.max(1, Math.ceil(Math.max(...durations)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
    ...(independent ? ["#EXT-X-INDEPENDENT-SEGMENTS"] : []),
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  durations.forEach((duration, i) => {
    lines.push(`#EXTINF:${duration.toFixed(6)},`, `${prefix}${i}.m4s`);
  });
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

/** One keyframe-aligned fragment written by a run. */
export interface FragmentRecord {
  /** Decode time of the fragment's first video sample, seconds. */
  time: number;
  path: string;
  bytes: number;
}

/** A stretch of the timeline served as one request: a segment, or a slice of one. */
export interface PlanWindow {
  /** Fragments that start in [start, end) belong to it. */
  start: number;
  end: number;
  /** The keyframe it depends on: a run that began after this cannot serve it. */
  anchor: number;
  /** Nothing follows it, so it ends when the run does. */
  last: boolean;
}

export function segmentWindow(bounds: readonly number[], index: number): PlanWindow {
  return { start: bounds[index]!, end: bounds[index + 1]!, anchor: bounds[index]!, last: index === bounds.length - 2 };
}

export function sliceWindow(bounds: readonly number[], plan: SlicePlan, index: number): PlanWindow {
  return {
    start: plan.bounds[index]!,
    end: plan.bounds[index + 1]!,
    anchor: bounds[plan.segmentOf[index]!]!,
    last: index === plan.bounds.length - 2,
  };
}

/** Whether a run's output can serve a window anchored at `anchor`: it began at that keyframe or before it. */
export function runCovers(fragments: readonly FragmentRecord[], anchor: number): boolean {
  return fragments.length > 0 && fragments[0]!.time <= anchor + KEYFRAME_MATCH_TOLERANCE_S;
}

/**
 * Fragments (in order) that make up a window, taken from one run's contiguous
 * output. Returns null until the run has produced past the window's end (or
 * finished the title). A slice shorter than one fragment can be empty.
 */
export function fragmentsInWindow(
  window: PlanWindow,
  fragments: readonly FragmentRecord[],
  runFinished: boolean
): FragmentRecord[] | null {
  if (!runCovers(fragments, window.anchor)) return null;
  const first = fragments.findIndex((f) => f.time >= window.start - KEYFRAME_MATCH_TOLERANCE_S);
  if (first < 0) return null;
  const selected: FragmentRecord[] = [];
  for (let i = first; i < fragments.length; i++) {
    const fragment = fragments[i]!;
    if (!window.last && fragment.time >= window.end - KEYFRAME_MATCH_TOLERANCE_S) return selected;
    selected.push(fragment);
  }
  // Ran out of fragments before reaching the next boundary.
  return runFinished && selected.length ? selected : null;
}

/** Fragments of segment `index`; null until complete (see `fragmentsInWindow`). */
export function fragmentsForSegment(
  bounds: readonly number[],
  index: number,
  fragments: readonly FragmentRecord[],
  runFinished: boolean
): FragmentRecord[] | null {
  const selected = fragmentsInWindow(segmentWindow(bounds, index), fragments, runFinished);
  return selected?.length ? selected : null;
}

/**
 * Incremental splitter for a fragmented-MP4 byte stream: yields the init
 * segment (ftyp+moov) once, then each moof+mdat pair as one fragment.
 * Chunks are queued and each box is copied exactly once, so a 15 MB 4K
 * fragment arriving in 64 KB pieces costs O(n), not O(n^2).
 */
export class Fmp4StreamSplitter {
  private chunks: Uint8Array[] = [];
  private queued = 0;
  private headOffset = 0;
  private init: Uint8Array[] = [];
  private initDone = false;
  private pendingMoof: Uint8Array | null = null;

  push(chunk: Uint8Array): Array<{ kind: "init" | "fragment"; bytes: Uint8Array }> {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.queued += chunk.length;
    }
    const out: Array<{ kind: "init" | "fragment"; bytes: Uint8Array }> = [];
    for (;;) {
      const header = this.peek(16);
      if (!header || header.length < 8) break;
      let size = readU32(header, 0);
      const type = String.fromCharCode(header[4]!, header[5]!, header[6]!, header[7]!);
      if (size === 1) {
        if (header.length < 16) break;
        size = readU32(header, 8) * 2 ** 32 + readU32(header, 12);
      }
      if (size < 8) throw new Error(`invalid box size ${size}`);
      if (this.queued < size) break;
      const box = this.take(size);
      if (!this.initDone) {
        if (type === "moof") {
          this.initDone = true;
          out.push({ kind: "init", bytes: concat(this.init) });
          this.pendingMoof = box;
        } else {
          this.init.push(box);
        }
      } else if (type === "moof") {
        this.pendingMoof = box;
      } else if (type === "mdat" && this.pendingMoof) {
        out.push({ kind: "fragment", bytes: concat([this.pendingMoof, box]) });
        this.pendingMoof = null;
      }
    }
    return out;
  }

  /** Up to `n` bytes from the front without consuming them. */
  private peek(n: number): Uint8Array | null {
    if (this.queued === 0) return null;
    const want = Math.min(n, this.queued);
    const out = new Uint8Array(want);
    let written = 0;
    let offset = this.headOffset;
    for (const chunk of this.chunks) {
      const part = chunk.subarray(offset, offset + (want - written));
      out.set(part, written);
      written += part.length;
      offset = 0;
      if (written === want) break;
    }
    return out;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const chunk = this.chunks[0]!;
      const available = chunk.length - this.headOffset;
      const count = Math.min(available, n - written);
      out.set(chunk.subarray(this.headOffset, this.headOffset + count), written);
      written += count;
      this.headOffset += count;
      if (this.headOffset === chunk.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    this.queued -= n;
    return out;
  }
}

function readU32(buf: Uint8Array, offset: number): number {
  return ((buf[offset]! << 24) >>> 0) + (buf[offset + 1]! << 16) + (buf[offset + 2]! << 8) + buf[offset + 3]!;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

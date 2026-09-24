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

/** Complete VOD playlist; segment URIs are `<index>.m4s` beside `init.mp4`. */
export function buildVodPlaylist(bounds: readonly number[]): string {
  const durations = bounds.slice(1).map((end, i) => end - bounds[i]!);
  const target = Math.max(1, Math.ceil(Math.max(...durations)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  durations.forEach((duration, i) => {
    lines.push(`#EXTINF:${duration.toFixed(6)},`, `${i}.m4s`);
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

/**
 * Fragments (in order) that make up segment `index`, taken from one run's
 * contiguous output. Returns null until the run has produced past the
 * segment's end (or finished the title).
 */
export function fragmentsForSegment(
  bounds: readonly number[],
  index: number,
  fragments: readonly FragmentRecord[],
  runFinished: boolean
): FragmentRecord[] | null {
  const start = bounds[index]!;
  const end = bounds[index + 1]!;
  const isLast = index === bounds.length - 2;
  const first = fragments.findIndex((f) => f.time >= start - KEYFRAME_MATCH_TOLERANCE_S);
  if (first < 0) return null;
  // The run must have started at or before this segment's first keyframe;
  // otherwise its opening keyframes are missing from this run's output.
  if (fragments[first]!.time > start + KEYFRAME_MATCH_TOLERANCE_S && first === 0) return null;
  const selected: FragmentRecord[] = [];
  for (let i = first; i < fragments.length; i++) {
    const fragment = fragments[i]!;
    if (!isLast && fragment.time >= end - KEYFRAME_MATCH_TOLERANCE_S) return selected.length ? selected : null;
    selected.push(fragment);
  }
  // Ran out of fragments before reaching the next boundary.
  return runFinished && selected.length ? selected : null;
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

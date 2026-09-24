/**
 * Minimal ISO-BMFF helpers for fragmented MP4 produced by ffmpeg's HLS muxer.
 *
 * - `stripEditLists` removes `edts` boxes from an init segment. With
 *   `-copyts` every fragment already carries its absolute decode time, and
 *   ffmpeg records the run's start offset as an empty edit that differs from
 *   run to run. Without it, init segments from any run are byte-identical and
 *   one of them can serve the whole title.
 * - `readVideoTrackInfo` finds the video track id and timescale.
 * - `firstVideoPts` reads the presentation time of the first video sample of
 *   a media fragment (tfdt + the first sample's composition offset).
 */

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "edts", "mvex", "dinf"]);

export interface Box {
  type: string;
  start: number;
  headerSize: number;
  size: number;
}

function readU32(buf: Uint8Array, offset: number): number {
  return ((buf[offset]! << 24) >>> 0) + (buf[offset + 1]! << 16) + (buf[offset + 2]! << 8) + buf[offset + 3]!;
}

function readU64(buf: Uint8Array, offset: number): number {
  return readU32(buf, offset) * 2 ** 32 + readU32(buf, offset + 4);
}

function readI32(buf: Uint8Array, offset: number): number {
  const value = readU32(buf, offset);
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function boxType(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(buf[offset]!, buf[offset + 1]!, buf[offset + 2]!, buf[offset + 3]!);
}

/** Boxes directly inside [start, end). */
export function* boxes(buf: Uint8Array, start = 0, end = buf.length): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = readU32(buf, offset);
    const type = boxType(buf, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = readU64(buf, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return;
    yield { type, start: offset, headerSize, size };
    offset += size;
  }
}

function findChild(buf: Uint8Array, parent: Box, type: string): Box | null {
  for (const child of boxes(buf, parent.start + parent.headerSize, parent.start + parent.size)) {
    if (child.type === type) return child;
  }
  return null;
}

function writeU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

/** Serialises [start,end) with every `edts` removed from container boxes, fixing sizes. */
function rebuild(buf: Uint8Array, start: number, end: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (const box of boxes(buf, start, end)) {
    if (box.type === "edts") continue;
    if (!CONTAINERS.has(box.type) || box.headerSize !== 8) {
      parts.push(buf.subarray(box.start, box.start + box.size));
      continue;
    }
    const inner = rebuild(buf, box.start + box.headerSize, box.start + box.size);
    const innerSize = inner.reduce((sum, p) => sum + p.length, 0);
    const header = new Uint8Array(8);
    writeU32(header, 0, 8 + innerSize);
    header.set(buf.subarray(box.start + 4, box.start + 8), 4);
    parts.push(header, ...inner);
  }
  return parts;
}

export function stripEditLists(init: Uint8Array): Uint8Array {
  const parts = rebuild(init, 0, init.length);
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface VideoTrackInfo {
  trackId: number;
  timescale: number;
}

export function readVideoTrackInfo(init: Uint8Array): VideoTrackInfo | null {
  const moov = [...boxes(init)].find((b) => b.type === "moov");
  if (!moov) return null;
  for (const trak of boxes(init, moov.start + moov.headerSize, moov.start + moov.size)) {
    if (trak.type !== "trak") continue;
    const mdia = findChild(init, trak, "mdia");
    const tkhd = findChild(init, trak, "tkhd");
    if (!mdia || !tkhd) continue;
    const hdlr = findChild(init, mdia, "hdlr");
    const mdhd = findChild(init, mdia, "mdhd");
    if (!hdlr || !mdhd) continue;
    // hdlr: header, version/flags(4), pre_defined(4), handler_type(4)
    if (boxType(init, hdlr.start + hdlr.headerSize + 8) !== "vide") continue;
    const tkhdVersion = init[tkhd.start + tkhd.headerSize]!;
    const trackId = readU32(init, tkhd.start + tkhd.headerSize + 4 + (tkhdVersion === 1 ? 16 : 8));
    const mdhdVersion = init[mdhd.start + mdhd.headerSize]!;
    const timescale = readU32(init, mdhd.start + mdhd.headerSize + 4 + (mdhdVersion === 1 ? 16 : 8));
    return { trackId, timescale };
  }
  return null;
}

const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
const TRUN_SAMPLE_DURATION = 0x100;
const TRUN_SAMPLE_SIZE = 0x200;
const TRUN_SAMPLE_FLAGS = 0x400;
const TRUN_SAMPLE_CTO = 0x800;

/** Presentation time (seconds) of the first video sample in a media fragment. */
export function firstVideoPts(segment: Uint8Array, video: VideoTrackInfo): number | null {
  for (const moof of boxes(segment)) {
    if (moof.type !== "moof") continue;
    for (const traf of boxes(segment, moof.start + moof.headerSize, moof.start + moof.size)) {
      if (traf.type !== "traf") continue;
      const tfhd = findChild(segment, traf, "tfhd");
      if (!tfhd || readU32(segment, tfhd.start + tfhd.headerSize + 4) !== video.trackId) continue;
      const tfdt = findChild(segment, traf, "tfdt");
      if (!tfdt) return null;
      const version = segment[tfdt.start + tfdt.headerSize]!;
      const decodeTime =
        version === 1
          ? readU64(segment, tfdt.start + tfdt.headerSize + 4)
          : readU32(segment, tfdt.start + tfdt.headerSize + 4);
      let cto = 0;
      const trun = findChild(segment, traf, "trun");
      if (trun) {
        const base = trun.start + trun.headerSize;
        const trunVersion = segment[base]!;
        const flags = (segment[base + 1]! << 16) | (segment[base + 2]! << 8) | segment[base + 3]!;
        let offset = base + 8; // version/flags + sample_count
        if (flags & TRUN_DATA_OFFSET) offset += 4;
        if (flags & TRUN_FIRST_SAMPLE_FLAGS) offset += 4;
        if (flags & TRUN_SAMPLE_DURATION) offset += 4;
        if (flags & TRUN_SAMPLE_SIZE) offset += 4;
        if (flags & TRUN_SAMPLE_FLAGS) offset += 4;
        if (flags & TRUN_SAMPLE_CTO) {
          cto = trunVersion === 1 ? readI32(segment, offset) : readU32(segment, offset);
        }
      }
      return (decodeTime + cto) / video.timescale;
    }
  }
  return null;
}

/** Decode time (seconds) of the first video sample in a media fragment (tfdt only). */
export function firstVideoDecodeTime(segment: Uint8Array, video: VideoTrackInfo): number | null {
  for (const moof of boxes(segment)) {
    if (moof.type !== "moof") continue;
    for (const traf of boxes(segment, moof.start + moof.headerSize, moof.start + moof.size)) {
      if (traf.type !== "traf") continue;
      const tfhd = findChild(segment, traf, "tfhd");
      if (!tfhd || readU32(segment, tfhd.start + tfhd.headerSize + 4) !== video.trackId) continue;
      const tfdt = findChild(segment, traf, "tfdt");
      if (!tfdt) return null;
      const version = segment[tfdt.start + tfdt.headerSize]!;
      const decodeTime =
        version === 1
          ? readU64(segment, tfdt.start + tfdt.headerSize + 4)
          : readU32(segment, tfdt.start + tfdt.headerSize + 4);
      return decodeTime / video.timescale;
    }
  }
  return null;
}

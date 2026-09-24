/**
 * Matroska keyframe index reader.
 *
 * A remote MKV can only be served as a seekable video-on-demand stream if the
 * segment boundaries are known before any segment exists. Matroska files
 * carry that information in their Cues element: one CuePoint per video
 * keyframe (mkvmerge's default) with its timestamp. Reading it costs a few
 * range requests of a few hundred KB, versus downloading the whole file to
 * find keyframes by demuxing.
 *
 * Layout used: EBML header → Segment → { SeekHead, Info, Tracks, ..., Cues }.
 * SeekHead positions are relative to the Segment's data start.
 */

export const EBML_ID = 0x1a45dfa3;
export const SEGMENT_ID = 0x18538067;
export const SEEK_HEAD_ID = 0x114d9b74;
export const SEEK_ID = 0x4dbb;
export const SEEK_ELEMENT_ID = 0x53ab;
export const SEEK_POSITION_ID = 0x53ac;
export const INFO_ID = 0x1549a966;
export const TIMESTAMP_SCALE_ID = 0x2ad7b1;
export const DURATION_ID = 0x4489;
export const TRACKS_ID = 0x1654ae6b;
export const TRACK_ENTRY_ID = 0xae;
export const TRACK_NUMBER_ID = 0xd7;
export const TRACK_TYPE_ID = 0x83;
export const CUES_ID = 0x1c53bb6b;
export const CUE_POINT_ID = 0xbb;
export const CUE_TIME_ID = 0xb3;
export const CUE_TRACK_POSITIONS_ID = 0xb7;
export const CUE_TRACK_ID = 0xf7;
export const CLUSTER_ID = 0x1f43b675;
export const CODEC_ID_ID = 0x86;
export const LANGUAGE_ID = 0x22b59c;
export const LANGUAGE_BCP47_ID = 0x22b59d;
export const NAME_ID = 0x536e;
export const FLAG_DEFAULT_ID = 0x88;
export const FLAG_FORCED_ID = 0x55aa;
export const AUDIO_ID = 0xe1;
export const CHANNELS_ID = 0x9f;
export const VIDEO_ID = 0xe0;
export const COLOUR_ID = 0x55b0;
export const TRANSFER_CHARACTERISTICS_ID = 0x55ba;

/** ITU-T H.273 transfer characteristics that mean HDR. */
const TRANSFER_PQ = 16;
const TRANSFER_HLG = 18;

export type DynamicRange = "SDR" | "PQ" | "HLG";

export function dynamicRangeFromTransfer(transfer: number | null): DynamicRange {
  if (transfer === TRANSFER_PQ) return "PQ";
  if (transfer === TRANSFER_HLG) return "HLG";
  return "SDR";
}

const VIDEO_TRACK_TYPE = 1;
const AUDIO_TRACK_TYPE = 2;
const DEFAULT_TIMESTAMP_SCALE_NS = 1_000_000;
const NS_PER_SECOND = 1e9;
/** Unknown-size marker for an 8-byte-or-less vint whose value bits are all 1. */
const UNKNOWN_SIZE = -1;

export interface EbmlElement {
  id: number;
  /** Offset of the element's first header byte in the buffer. */
  start: number;
  /** Offset of the first payload byte. */
  dataStart: number;
  /** Payload size, or -1 when the element declares an unknown size. */
  size: number;
}

/** Reads an EBML element ID (1-4 bytes, marker bit kept). */
export function readElementId(buf: Uint8Array, offset: number): { value: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset]!;
  let length = 0;
  for (let mask = 0x80; mask >= 0x10; mask >>= 1) {
    length++;
    if (first & mask) break;
    if (mask === 0x10) return null;
  }
  if (offset + length > buf.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + buf[offset + i]!;
  return { value, length };
}

/** Reads an EBML size vint (1-8 bytes, marker bit stripped). */
export function readVint(buf: Uint8Array, offset: number): { value: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset]!;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || offset + length > buf.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i++) {
    const byte = buf[offset + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value: allOnes ? UNKNOWN_SIZE : value, length };
}

export function readElementHeader(buf: Uint8Array, offset: number): EbmlElement | null {
  const id = readElementId(buf, offset);
  if (!id) return null;
  const size = readVint(buf, offset + id.length);
  if (!size) return null;
  return { id: id.value, start: offset, dataStart: offset + id.length + size.length, size: size.value };
}

/** Direct children of a fully-buffered master element's payload. */
export function* children(buf: Uint8Array, start: number, end: number): Generator<EbmlElement> {
  let offset = start;
  while (offset < end) {
    const el = readElementHeader(buf, offset);
    if (!el || el.size === UNKNOWN_SIZE) return;
    yield el;
    offset = el.dataStart + el.size;
  }
}

export function readUint(buf: Uint8Array, el: EbmlElement): number {
  let value = 0;
  for (let i = 0; i < el.size; i++) value = value * 256 + buf[el.dataStart + i]!;
  return value;
}

export function readFloat(buf: Uint8Array, el: EbmlElement): number {
  const view = new DataView(buf.buffer, buf.byteOffset + el.dataStart, el.size);
  if (el.size === 4) return view.getFloat32(0);
  if (el.size === 8) return view.getFloat64(0);
  return 0;
}

export interface MkvAudioTrack {
  /** Zero-based position among audio tracks: ffmpeg's `0:a:N`. */
  audioIndex: number;
  codecId: string;
  language: string | null;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
  channels: number | null;
}

export function readString(buf: Uint8Array, el: EbmlElement): string {
  let end = el.dataStart + el.size;
  while (end > el.dataStart && buf[end - 1] === 0) end--;
  return new TextDecoder().decode(buf.subarray(el.dataStart, end));
}

export interface SegmentLayout {
  /** Absolute byte offset of the Segment payload (base for SeekHead positions). */
  segmentDataStart: number;
  timestampScaleNs: number;
  durationS: number | null;
  videoTrack: number | null;
  /** Codec ID of the video track, e.g. V_MPEGH/ISO/HEVC. */
  videoCodecId: string | null;
  dynamicRange: DynamicRange;
  audioTracks: MkvAudioTrack[];
  /** Absolute byte offset of the Cues element, when SeekHead lists it. */
  cuesOffset: number | null;
}

/**
 * Parses the head of a Matroska file (the first ~64 KB is enough for
 * mkvmerge/ffmpeg output) to find timing info, the video track and where the
 * Cues live.
 */
export function parseSegmentLayout(head: Uint8Array): SegmentLayout | null {
  const ebml = readElementHeader(head, 0);
  if (!ebml || ebml.id !== EBML_ID) return null;
  const segment = readElementHeader(head, ebml.dataStart + ebml.size);
  if (!segment || segment.id !== SEGMENT_ID) return null;

  const layout: SegmentLayout = {
    segmentDataStart: segment.dataStart,
    timestampScaleNs: DEFAULT_TIMESTAMP_SCALE_NS,
    durationS: null,
    videoTrack: null,
    videoCodecId: null,
    dynamicRange: "SDR",
    audioTracks: [],
    cuesOffset: null,
  };
  let rawDuration: number | null = null;

  let offset = segment.dataStart;
  while (offset < head.length) {
    const el = readElementHeader(head, offset);
    if (!el || el.size === UNKNOWN_SIZE || el.id === CLUSTER_ID) break;
    const end = el.dataStart + el.size;
    if (end > head.length) break;
    if (el.id === SEEK_HEAD_ID) {
      for (const seek of children(head, el.dataStart, end)) {
        if (seek.id !== SEEK_ID) continue;
        let seekId = 0;
        let position = -1;
        for (const field of children(head, seek.dataStart, seek.dataStart + seek.size)) {
          if (field.id === SEEK_ELEMENT_ID) seekId = readUint(head, field);
          if (field.id === SEEK_POSITION_ID) position = readUint(head, field);
        }
        if (seekId === CUES_ID && position >= 0) layout.cuesOffset = segment.dataStart + position;
      }
    } else if (el.id === INFO_ID) {
      for (const field of children(head, el.dataStart, end)) {
        if (field.id === TIMESTAMP_SCALE_ID) layout.timestampScaleNs = readUint(head, field);
        if (field.id === DURATION_ID) rawDuration = readFloat(head, field);
      }
    } else if (el.id === TRACKS_ID) {
      for (const entry of children(head, el.dataStart, end)) {
        if (entry.id !== TRACK_ENTRY_ID) continue;
        let number = 0;
        let type = 0;
        let codecId = "";
        let language: string | null = null;
        let bcp47: string | null = null;
        let name: string | null = null;
        let isDefault = true;
        let isForced = false;
        let channels: number | null = null;
        let transfer: number | null = null;
        for (const field of children(head, entry.dataStart, entry.dataStart + entry.size)) {
          if (field.id === TRACK_NUMBER_ID) number = readUint(head, field);
          else if (field.id === TRACK_TYPE_ID) type = readUint(head, field);
          else if (field.id === CODEC_ID_ID) codecId = readString(head, field);
          else if (field.id === LANGUAGE_ID) language = readString(head, field);
          else if (field.id === LANGUAGE_BCP47_ID) bcp47 = readString(head, field);
          else if (field.id === NAME_ID) name = readString(head, field);
          else if (field.id === FLAG_DEFAULT_ID) isDefault = readUint(head, field) === 1;
          else if (field.id === FLAG_FORCED_ID) isForced = readUint(head, field) === 1;
          else if (field.id === VIDEO_ID) {
            for (const video of children(head, field.dataStart, field.dataStart + field.size)) {
              if (video.id !== COLOUR_ID) continue;
              for (const colour of children(head, video.dataStart, video.dataStart + video.size)) {
                if (colour.id === TRANSFER_CHARACTERISTICS_ID) transfer = readUint(head, colour);
              }
            }
          } else if (field.id === AUDIO_ID) {
            for (const audio of children(head, field.dataStart, field.dataStart + field.size)) {
              if (audio.id === CHANNELS_ID) channels = readUint(head, audio);
            }
          }
        }
        if (type === VIDEO_TRACK_TYPE && layout.videoTrack === null) {
          layout.videoTrack = number;
          layout.videoCodecId = codecId || null;
          layout.dynamicRange = dynamicRangeFromTransfer(transfer);
        }
        if (type === AUDIO_TRACK_TYPE) {
          layout.audioTracks.push({
            audioIndex: layout.audioTracks.length,
            codecId,
            // Matroska's default language is English when the element is absent.
            language: bcp47 ?? language ?? "eng",
            name,
            isDefault,
            isForced,
            channels,
          });
        }
      }
    }
    offset = end;
  }
  if (rawDuration !== null) {
    layout.durationS = (rawDuration * layout.timestampScaleNs) / NS_PER_SECOND;
  }
  return layout;
}

/** Keyframe times (seconds, ascending, de-duplicated) for one track from a Cues payload. */
export function parseCueTimes(
  cues: Uint8Array,
  videoTrack: number,
  timestampScaleNs: number
): number[] {
  const root = readElementHeader(cues, 0);
  if (!root || root.id !== CUES_ID) return [];
  const end = Math.min(cues.length, root.size === UNKNOWN_SIZE ? cues.length : root.dataStart + root.size);
  const times: number[] = [];
  for (const point of children(cues, root.dataStart, end)) {
    if (point.id !== CUE_POINT_ID) continue;
    let time = -1;
    let forVideo = false;
    for (const field of children(cues, point.dataStart, point.dataStart + point.size)) {
      if (field.id === CUE_TIME_ID) time = readUint(cues, field);
      if (field.id === CUE_TRACK_POSITIONS_ID) {
        for (const pos of children(cues, field.dataStart, field.dataStart + field.size)) {
          if (pos.id === CUE_TRACK_ID && readUint(cues, pos) === videoTrack) forVideo = true;
        }
      }
    }
    if (time >= 0 && forVideo) times.push((time * timestampScaleNs) / NS_PER_SECOND);
  }
  times.sort((a, b) => a - b);
  return times.filter((t, i) => i === 0 || t - times[i - 1]! > 1e-6);
}

export type RangeFetcher = (start: number, endInclusive: number) => Promise<Uint8Array>;

const HEAD_BYTES = 256 * 1024;
const CUES_GUESS_BYTES = 1024 * 1024;
/** A 3-hour 4K film's Cues are ~200-400 KB; refuse anything absurd. */
const MAX_CUES_BYTES = 16 * 1024 * 1024;

export interface KeyframeIndex {
  durationS: number;
  keyframes: number[];
  videoCodecId: string | null;
  dynamicRange: DynamicRange;
  audioTracks: MkvAudioTrack[];
  /** Byte ranges already downloaded while indexing (head and Cues), reusable by a local cache. */
  fetched: Array<{ start: number; bytes: Uint8Array }>;
}

/**
 * Reads the keyframe index of a remote MKV through range requests.
 * Returns null when the file is not Matroska or carries no usable Cues.
 */
export async function readMkvKeyframes(fetchRange: RangeFetcher): Promise<KeyframeIndex | null> {
  const fetched: Array<{ start: number; bytes: Uint8Array }> = [];
  const head = await fetchRange(0, HEAD_BYTES - 1);
  fetched.push({ start: 0, bytes: head });
  const layout = parseSegmentLayout(head);
  if (!layout || layout.videoTrack === null || layout.cuesOffset === null || !layout.durationS) {
    return null;
  }
  // One speculative request usually holds the whole Cues element; a second
  // is made only when it is larger than the guess.
  let cues = await fetchRange(layout.cuesOffset, layout.cuesOffset + CUES_GUESS_BYTES - 1);
  const cuesEl = readElementHeader(cues, 0);
  if (!cuesEl || cuesEl.id !== CUES_ID || cuesEl.size === UNKNOWN_SIZE || cuesEl.size > MAX_CUES_BYTES) {
    return null;
  }
  const cuesEnd = cuesEl.dataStart + cuesEl.size;
  if (cues.length < cuesEnd) {
    cues = await fetchRange(layout.cuesOffset, layout.cuesOffset + cuesEnd - 1);
  }
  fetched.push({ start: layout.cuesOffset, bytes: cues });
  const keyframes = parseCueTimes(cues, layout.videoTrack, layout.timestampScaleNs);
  if (keyframes.length < 2) return null;
  return {
    durationS: layout.durationS,
    keyframes,
    videoCodecId: layout.videoCodecId,
    dynamicRange: layout.dynamicRange,
    audioTracks: layout.audioTracks,
    fetched,
  };
}

/**
 * A fetcher over HTTP Range requests. The file size learned from the first
 * response's Content-Range clamps later requests: some CDNs answer a range
 * that runs past end-of-file with a response Bun's fetch rejects.
 */
export function httpRangeFetcher(url: string, timeoutMs: number): RangeFetcher & { size(): number | null } {
  let totalSize: number | null = null;
  const fetcher = async (start: number, endInclusive: number) => {
    const end = totalSize !== null ? Math.min(endInclusive, totalSize - 1) : endInclusive;
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 206) {
      // A 200 means Range was ignored and the whole file is on its way.
      await res.body?.cancel().catch(() => {});
      throw new Error(`range not supported (HTTP ${res.status})`);
    }
    const total = Number(res.headers.get("content-range")?.split("/")[1]);
    if (Number.isFinite(total) && total > 0) totalSize = total;
    return new Uint8Array(await res.arrayBuffer());
  };
  return Object.assign(fetcher, { size: () => totalSize });
}

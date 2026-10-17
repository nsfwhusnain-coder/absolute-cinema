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

import { isRefusal, linkRefused, linkTurn } from "./link-pacer";
import { parseDolbyVisionRecord, type DolbyVisionInfo } from "./dolby-vision";

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
export const CODEC_PRIVATE_ID = 0x63a2;
export const BLOCK_ADDITION_MAPPING_ID = 0x41e4;
export const BLOCK_ADD_ID_TYPE_ID = 0x41e7;
export const BLOCK_ADD_ID_EXTRA_DATA_ID = 0x41ed;

/** ITU-T H.273 transfer characteristics that mean HDR. */
const TRANSFER_PQ = 16;
const TRANSFER_HLG = 18;

export type DynamicRange = "SDR" | "PQ" | "HLG";

export function dynamicRangeFromTransfer(transfer: number | null): DynamicRange {
  if (transfer === TRANSFER_PQ) return "PQ";
  if (transfer === TRANSFER_HLG) return "HLG";
  return "SDR";
}

/** BlockAddIDType values that carry a Dolby Vision configuration record: "dvcC" and "dvvC". */
const DOLBY_VISION_MAPPING_TYPES = new Set([0x64766343, 0x64767643]);

const VIDEO_TRACK_TYPE = 1;
const AUDIO_TRACK_TYPE = 2;
const SUBTITLE_TRACK_TYPE = 0x11;
/** AVC profile_idc values browsers cannot decode: High 10, High 4:2:2, High 4:4:4. */
const UNDECODABLE_AVC_PROFILES = new Set([110, 122, 244]);
/**
 * Video codecs no browser decodes, whatever container carries them: VC-1 (and
 * anything else kept under the generic Video-for-Windows id), MPEG-2, MPEG-4
 * part 2 (DivX, Xvid) and RealVideo. A copy into fragmented MP4 gives a
 * stream the player cannot show, so the file is turned away on opening.
 */
const UNDECODABLE_VIDEO_CODECS = /^V_(MS\/VFW\/FOURCC|MPEG2|MPEG4\/ISO\/(ASP|SP|AP)|MPEG4\/MS|REAL\/)/;

/** Whether a browser cannot decode the video track, from its codec id and (for AVC) profile. */
export function isVideoUndecodable(codecId: string, avcProfile: number | null): boolean {
  if (codecId === "V_MPEG4/ISO/AVC") return avcProfile !== null && UNDECODABLE_AVC_PROFILES.has(avcProfile);
  return UNDECODABLE_VIDEO_CODECS.test(codecId);
}
/** Text subtitle codecs ffmpeg converts to WebVTT (image formats like PGS are skipped). */
const TEXT_SUBTITLE_CODECS = /^S_TEXT\/(UTF8|ASS|SSA|WEBVTT)$|^S_(ASS|SSA)$/;
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

export interface MkvSubtitleTrack {
  /** Zero-based position among ALL subtitle tracks: ffmpeg's `0:s:N`. */
  subtitleIndex: number;
  codecId: string;
  language: string | null;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
  /** Text-based, so it can become WebVTT. */
  text: boolean;
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
  /** Set when the video track carries a Dolby Vision configuration. */
  dolbyVision: DolbyVisionInfo | null;
  audioTracks: MkvAudioTrack[];
  subtitleTracks: MkvSubtitleTrack[];
  /** The video is 10-bit/4:2:2/4:4:4 H.264, which no browser decodes. */
  videoUndecodable: boolean;
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
    dolbyVision: null,
    audioTracks: [],
    subtitleTracks: [],
    videoUndecodable: false,
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
        let avcProfile: number | null = null;
        let dolbyVision: DolbyVisionInfo | null = null;
        for (const field of children(head, entry.dataStart, entry.dataStart + entry.size)) {
          if (field.id === TRACK_NUMBER_ID) number = readUint(head, field);
          else if (field.id === TRACK_TYPE_ID) type = readUint(head, field);
          else if (field.id === CODEC_ID_ID) codecId = readString(head, field);
          else if (field.id === LANGUAGE_ID) language = readString(head, field);
          else if (field.id === LANGUAGE_BCP47_ID) bcp47 = readString(head, field);
          else if (field.id === NAME_ID) name = readString(head, field);
          else if (field.id === FLAG_DEFAULT_ID) isDefault = readUint(head, field) === 1;
          else if (field.id === FLAG_FORCED_ID) isForced = readUint(head, field) === 1;
          else if (field.id === CODEC_PRIVATE_ID && field.size > 1) avcProfile = head[field.dataStart + 1] ?? null;
          else if (field.id === BLOCK_ADDITION_MAPPING_ID) dolbyVision = readDolbyVisionMapping(head, field) ?? dolbyVision;
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
          layout.dolbyVision = dolbyVision;
          layout.videoUndecodable = isVideoUndecodable(codecId, avcProfile);
        }
        if (type === SUBTITLE_TRACK_TYPE) {
          layout.subtitleTracks.push({
            subtitleIndex: layout.subtitleTracks.length,
            codecId,
            language: bcp47 ?? language ?? "eng",
            name,
            isDefault,
            isForced,
            text: TEXT_SUBTITLE_CODECS.test(codecId),
          });
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

/** The Dolby Vision configuration inside a BlockAdditionMapping, or null when it maps something else. */
function readDolbyVisionMapping(head: Uint8Array, mapping: EbmlElement): DolbyVisionInfo | null {
  let type = 0;
  let record: Uint8Array | null = null;
  for (const field of children(head, mapping.dataStart, mapping.dataStart + mapping.size)) {
    if (field.id === BLOCK_ADD_ID_TYPE_ID) type = readUint(head, field);
    if (field.id === BLOCK_ADD_ID_EXTRA_DATA_ID) record = head.subarray(field.dataStart, field.dataStart + field.size);
  }
  return record && DOLBY_VISION_MAPPING_TYPES.has(type) ? parseDolbyVisionRecord(record) : null;
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

/** A fetcher that also reports the file's size as soon as the first response says it. */
export type SizedRangeFetcher = RangeFetcher & { whenSized?: Promise<number> };

/**
 * Read from the start of the file when it is indexed, and kept: the header
 * the index is parsed from, and the first packets after it. ffmpeg reads
 * those packets every time it opens the file, to learn what each stream is
 * (see FFMPEG_PROBE_BYTES in vod.ts); from memory, that costs a jump nothing.
 */
export const HEAD_BYTES = 2 * 1024 * 1024;
/**
 * Once the file's size is known the head is read in this many parts at once.
 * In one request it took eight seconds from a CDN giving a connection
 * 2.5 Mbit/s (AllDebrid, most of the time), before anything else could start.
 */
const HEAD_PARTS = 4;
const CUES_GUESS_BYTES = 1024 * 1024;
/** How much of the file's end is read alongside its head, on the guess that it holds the Cues. */
const TAIL_GUESS_BYTES = 384 * 1024;
/** How long the index waits for the tail once it has the Cues by another route. */
const TAIL_GRACE_MS = 1_500;
/** A 3-hour 4K film's Cues are ~200-400 KB; refuse anything absurd. */
const MAX_CUES_BYTES = 16 * 1024 * 1024;

export interface KeyframeIndex {
  durationS: number;
  keyframes: number[];
  videoCodecId: string | null;
  dynamicRange: DynamicRange;
  dolbyVision: DolbyVisionInfo | null;
  audioTracks: MkvAudioTrack[];
  subtitleTracks: MkvSubtitleTrack[];
  videoUndecodable: boolean;
  /** Byte ranges already downloaded while indexing (head and Cues), reusable by a local cache. */
  fetched: Array<{ start: number; bytes: Uint8Array }>;
}

interface Tail {
  start: number;
  bytes: Promise<Uint8Array | null>;
}

/**
 * Starts reading the end of the file the moment its size is known.
 *
 * The Cues close nearly every file, but where exactly is written in the head.
 * A debrid CDN takes about two seconds to deliver any range, however small,
 * so waiting for the head before asking for the Cues cost every first play
 * that long. The size arrives with the head's response headers, well before
 * its body, and the two downloads then overlap.
 */
function readTail(fetchRange: SizedRangeFetcher): Promise<Tail | null> | null {
  if (!fetchRange.whenSized) return null;
  return fetchRange.whenSized.then(
    (total) => {
      const start = Math.max(0, total - TAIL_GUESS_BYTES);
      return { start, bytes: fetchRange(start, total - 1).catch(() => null) };
    },
    () => null
  );
}

/** Resolves with nothing after `ms`: the longest the index waits on a read it can do without. */
function settled(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/** The tail read as a cached range, when it arrived. */
async function tailBytes(pending: Promise<Tail | null> | null): Promise<{ start: number; bytes: Uint8Array } | null> {
  const tail = await pending;
  const bytes = tail ? await tail.bytes : null;
  return tail && bytes?.length ? { start: tail.start, bytes } : null;
}

/** The bytes from `cuesOffset` to the end of the file, when the tail read covers them. */
async function cuesFromTail(pending: Promise<Tail | null> | null, cuesOffset: number): Promise<Uint8Array | null> {
  const tail = await pending;
  if (!tail || cuesOffset < tail.start) return null;
  const bytes = await tail.bytes;
  return bytes && cuesOffset - tail.start < bytes.length ? bytes.subarray(cuesOffset - tail.start) : null;
}

/** The parts as one array, in order. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface HeadRead {
  /** The head's first part, as soon as it arrives: what the index needs is nearly always in it. */
  first: Promise<Uint8Array>;
  /** The whole head. */
  whole: Promise<Uint8Array>;
}

/**
 * Reads the first HEAD_BYTES of the file. With a fetcher that reports the
 * size, the first part is asked for at once and the rest the moment the size
 * is known (at once too, when the caller knew it), only as far as the file
 * goes. A later part that fails ends the head there: what it held is read
 * through the proxy if ffmpeg wants it.
 */
function readHead(fetchRange: SizedRangeFetcher): HeadRead {
  if (!fetchRange.whenSized) {
    const whole = fetchRange(0, HEAD_BYTES - 1);
    return { first: whole, whole };
  }
  const partBytes = HEAD_BYTES / HEAD_PARTS;
  const first = fetchRange(0, partBytes - 1);
  const rest = fetchRange.whenSized.then(
    (total) => {
      const reads: Array<Promise<Uint8Array | null>> = [];
      for (let start = partBytes; start < Math.min(total, HEAD_BYTES); start += partBytes) {
        reads.push(fetchRange(start, start + partBytes - 1).catch(() => null));
      }
      return Promise.all(reads);
    },
    () => []
  );
  const whole = (async () => {
    const parts = [await first];
    if (parts[0]!.length < partBytes) return parts[0]!;
    for (const part of await rest) {
      if (!part?.length) break;
      parts.push(part);
      if (part.length < partBytes) break;
    }
    return concat(parts);
  })();
  // Its failure is the first part's, reported by whoever waits on that.
  whole.catch(() => undefined);
  return { first, whole };
}

/** A layout with everything the index needs: the video track, the duration, and where the Cues are. */
function complete(layout: SegmentLayout | null): layout is SegmentLayout & { videoTrack: number; cuesOffset: number; durationS: number } {
  return layout !== null && layout.videoTrack !== null && layout.cuesOffset !== null && Boolean(layout.durationS);
}

/**
 * Reads the keyframe index of a remote MKV through range requests.
 * Returns null when the file is not Matroska or carries no usable Cues.
 */
export async function readMkvKeyframes(fetchRange: SizedRangeFetcher): Promise<KeyframeIndex | null> {
  const fetched: Array<{ start: number; bytes: Uint8Array }> = [];
  const tail = readTail(fetchRange);
  const head = readHead(fetchRange);
  // The layout is read from the head's first part the moment it arrives, so
  // the Cues are asked for while the rest of the head is still coming; the
  // whole head is parsed only when its first part was not enough.
  let layout = parseSegmentLayout(await head.first);
  if (!complete(layout)) layout = parseSegmentLayout(await head.whole);
  if (!complete(layout)) return null;
  // One speculative request usually holds the whole Cues element; a second
  // is made only when it is larger than the guess.
  let cues = (await cuesFromTail(tail, layout.cuesOffset)) ?? (await fetchRange(layout.cuesOffset, layout.cuesOffset + CUES_GUESS_BYTES - 1));
  // ffmpeg reads whatever closes the file (its tags, usually) every time it
  // opens it. Kept, the tail spares each start and each jump a request.
  const end = await Promise.race([tailBytes(tail), settled(TAIL_GRACE_MS)]);
  if (end) fetched.push(end);
  const cuesEl = readElementHeader(cues, 0);
  if (!cuesEl || cuesEl.id !== CUES_ID || cuesEl.size === UNKNOWN_SIZE || cuesEl.size > MAX_CUES_BYTES) {
    return null;
  }
  const cuesEnd = cuesEl.dataStart + cuesEl.size;
  if (cues.length < cuesEnd) {
    cues = await fetchRange(layout.cuesOffset, layout.cuesOffset + cuesEnd - 1);
  }
  fetched.unshift({ start: 0, bytes: await head.whole });
  fetched.push({ start: layout.cuesOffset, bytes: cues });
  const keyframes = parseCueTimes(cues, layout.videoTrack, layout.timestampScaleNs);
  if (keyframes.length < 2) return null;
  return {
    durationS: layout.durationS,
    keyframes,
    videoCodecId: layout.videoCodecId,
    dynamicRange: layout.dynamicRange,
    dolbyVision: layout.dolbyVision,
    audioTracks: layout.audioTracks,
    subtitleTracks: layout.subtitleTracks,
    videoUndecodable: layout.videoUndecodable,
    fetched,
  };
}

/**
 * A fetcher over HTTP Range requests. The file size learned from the first
 * response's Content-Range clamps later requests: some CDNs answer a range
 * that runs past end-of-file with a response Bun's fetch rejects.
 */
const RANGE_RETRY_MS = 400;

/** Asks for one range this many times when the link refuses it, each on the link's next turn (after its pause). */
const REFUSED_ATTEMPTS = 4;

/**
 * A range request the server answered but did not honour; `transient` when
 * asking again may work, `refused` when the link was asked too often.
 */
class RangeRequestError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly refused = false
  ) {
    super(message);
  }
}

export function httpRangeFetcher(url: string, timeoutMs: number, sizeHint?: number): SizedRangeFetcher & { size(): number | null } {
  let totalSize: number | null = null;
  let sized: (total: number) => void = () => {};
  // A size the caller already knew (the debrid service's, for its file) lets the
  // tail and the rest of the head be asked for alongside the first request
  // instead of a round trip after it: about a second on AllDebrid. Only reads
  // are planned from it; the size the file is served at is the response's own.
  const whenSized =
    sizeHint !== undefined && Number.isSafeInteger(sizeHint) && sizeHint > 0
      ? Promise.resolve(sizeHint)
      : new Promise<number>((resolve) => (sized = resolve));
  const request = async (start: number, end: number) => {
    await linkTurn(url);
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 206) return res;
    await res.body?.cancel().catch(() => {});
    if (isRefusal(res.status)) {
      linkRefused(url);
      throw new RangeRequestError(`range refused (HTTP ${res.status})`, true, true);
    }
    // A 200 means Range was ignored and the whole file is on its way.
    throw new RangeRequestError(`range not supported (HTTP ${res.status})`, res.status >= 500);
  };
  const fetcher = async (start: number, endInclusive: number) => {
    const end = totalSize !== null ? Math.min(endInclusive, totalSize - 1) : endInclusive;
    // A debrid CDN answers the odd request with a 503 and the next one
    // normally. One failed read used to fail the whole title. A link asked too
    // often (AllDebrid's 204) is asked again on its next turn, a few times.
    let res: Response | null = null;
    for (let attempt = 1; !res; attempt++) {
      try {
        res = await request(start, end);
      } catch (err) {
        const timedOut = err instanceof DOMException && err.name === "TimeoutError";
        const refused = err instanceof RangeRequestError && err.refused;
        if (timedOut || (err instanceof RangeRequestError && !err.transient)) throw err;
        if (attempt >= (refused ? REFUSED_ATTEMPTS : 2)) throw err;
        if (!refused) await new Promise((resolve) => setTimeout(resolve, RANGE_RETRY_MS));
      }
    }
    const total = Number(res.headers.get("content-range")?.split("/")[1]);
    if (Number.isFinite(total) && total > 0) {
      totalSize = total;
      sized(total);
    }
    return new Uint8Array(await res.arrayBuffer());
  };
  return Object.assign(fetcher, { size: () => totalSize, whenSized });
}

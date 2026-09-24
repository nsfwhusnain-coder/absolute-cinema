import { describe, expect, it } from "bun:test";
import {
  CLUSTER_ID,
  CODEC_ID_ID,
  CUES_ID,
  CUE_POINT_ID,
  CUE_TIME_ID,
  CUE_TRACK_ID,
  CUE_TRACK_POSITIONS_ID,
  DURATION_ID,
  EBML_ID,
  INFO_ID,
  LANGUAGE_ID,
  NAME_ID,
  SEEK_ELEMENT_ID,
  SEEK_HEAD_ID,
  SEEK_ID,
  SEEK_POSITION_ID,
  SEGMENT_ID,
  TIMESTAMP_SCALE_ID,
  TRACKS_ID,
  TRACK_ENTRY_ID,
  TRACK_NUMBER_ID,
  TRACK_TYPE_ID,
  parseCueTimes,
  parseSegmentLayout,
  readMkvKeyframes,
  readVint,
} from "./mkv-cues";

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

/** 8-byte size vint so element sizes never change as content grows. */
function sizeBytes(size: number): number[] {
  const out = [0x01];
  for (let i = 6; i >= 0; i--) out.push(Math.floor(size / 2 ** (8 * i)) % 256);
  return out;
}

function el(id: number, payload: number[] | Uint8Array): number[] {
  const body = Array.from(payload);
  return [...idBytes(id), ...sizeBytes(body.length), ...body];
}

const uint = (value: number, bytes = 4) =>
  Array.from({ length: bytes }, (_, i) => Math.floor(value / 2 ** (8 * (bytes - 1 - i))) % 256);
const str = (s: string) => Array.from(new TextEncoder().encode(s));
const float64 = (value: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return Array.from(b);
};

/** A minimal MKV: header, SeekHead → Cues, Info, Tracks (video + 2 audio), a Cluster, Cues. */
function buildMkv(cueTimesMs: number[]): Uint8Array {
  const info = el(INFO_ID, [...el(TIMESTAMP_SCALE_ID, uint(1_000_000)), ...el(DURATION_ID, float64(60_000))]);
  const tracks = el(TRACKS_ID, [
    ...el(TRACK_ENTRY_ID, [...el(TRACK_NUMBER_ID, [1]), ...el(TRACK_TYPE_ID, [1]), ...el(CODEC_ID_ID, str("V_MPEGH/ISO/HEVC"))]),
    ...el(TRACK_ENTRY_ID, [...el(TRACK_NUMBER_ID, [2]), ...el(TRACK_TYPE_ID, [2]), ...el(CODEC_ID_ID, str("A_EAC3")), ...el(LANGUAGE_ID, str("spa"))]),
    ...el(TRACK_ENTRY_ID, [
      ...el(TRACK_NUMBER_ID, [3]),
      ...el(TRACK_TYPE_ID, [2]),
      ...el(CODEC_ID_ID, str("A_AAC")),
      ...el(NAME_ID, str("Commentary")),
    ]),
  ]);
  const cluster = el(CLUSTER_ID, new Array(100).fill(0));
  const cues = el(
    CUES_ID,
    cueTimesMs.flatMap((t) =>
      el(CUE_POINT_ID, [...el(CUE_TIME_ID, uint(t)), ...el(CUE_TRACK_POSITIONS_ID, el(CUE_TRACK_ID, [1]))])
    )
  );
  const seekHeadLength = el(SEEK_HEAD_ID, el(SEEK_ID, [...el(SEEK_ELEMENT_ID, idBytes(CUES_ID)), ...el(SEEK_POSITION_ID, uint(0))])).length;
  const cuesPosition = seekHeadLength + info.length + tracks.length + cluster.length;
  const seekHead = el(SEEK_HEAD_ID, el(SEEK_ID, [...el(SEEK_ELEMENT_ID, idBytes(CUES_ID)), ...el(SEEK_POSITION_ID, uint(cuesPosition))]));
  const segment = el(SEGMENT_ID, [...seekHead, ...info, ...tracks, ...cluster, ...cues]);
  return new Uint8Array([...el(EBML_ID, [0x42, 0x86, 0x81, 0x01]), ...segment]);
}

describe("readVint", () => {
  it("strips the length marker and flags unknown sizes", () => {
    expect(readVint(new Uint8Array([0x81]), 0)).toEqual({ value: 1, length: 1 });
    expect(readVint(new Uint8Array([0x40, 0x02]), 0)).toEqual({ value: 2, length: 2 });
    expect(readVint(new Uint8Array([0xff]), 0)).toEqual({ value: -1, length: 1 });
  });
});

describe("Matroska index", () => {
  const file = buildMkv([0, 3420, 6840, 10302]);

  it("reads timing, the video track, audio tracks and the Cues offset from the head", () => {
    const layout = parseSegmentLayout(file)!;
    expect(layout.durationS).toBe(60);
    expect(layout.videoTrack).toBe(1);
    expect(layout.videoCodecId).toBe("V_MPEGH/ISO/HEVC");
    expect(layout.audioTracks.map((t) => [t.audioIndex, t.codecId, t.language, t.name])).toEqual([
      [0, "A_EAC3", "spa", null],
      [1, "A_AAC", "eng", "Commentary"],
    ]);
    expect(layout.cuesOffset).not.toBeNull();
  });

  it("extracts keyframe times for the video track", () => {
    const layout = parseSegmentLayout(file)!;
    expect(parseCueTimes(file.subarray(layout.cuesOffset!), 1, layout.timestampScaleNs)).toEqual([0, 3.42, 6.84, 10.302]);
    expect(parseCueTimes(file.subarray(layout.cuesOffset!), 2, layout.timestampScaleNs)).toEqual([]);
  });

  it("reads the whole index through range requests", async () => {
    const requests: string[] = [];
    const index = await readMkvKeyframes(async (start, end) => {
      requests.push(`${start}-${end}`);
      return file.subarray(start, Math.min(end + 1, file.length));
    });
    expect(index?.keyframes).toEqual([0, 3.42, 6.84, 10.302]);
    expect(index?.durationS).toBe(60);
    expect(requests.length).toBe(2);
  });

  it("returns null for data that is not Matroska", async () => {
    expect(await readMkvKeyframes(async () => new Uint8Array(64))).toBeNull();
  });
});

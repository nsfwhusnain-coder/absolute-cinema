import { describe, expect, it } from "bun:test";
import {
  BLOCK_ADDITION_MAPPING_ID,
  BLOCK_ADD_ID_EXTRA_DATA_ID,
  BLOCK_ADD_ID_TYPE_ID,
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
function buildMkv(cueTimesMs: number[], videoExtras: number[] = []): Uint8Array {
  const info = el(INFO_ID, [...el(TIMESTAMP_SCALE_ID, uint(1_000_000)), ...el(DURATION_ID, float64(60_000))]);
  const tracks = el(TRACKS_ID, [
    ...el(TRACK_ENTRY_ID, [...el(TRACK_NUMBER_ID, [1]), ...el(TRACK_TYPE_ID, [1]), ...el(CODEC_ID_ID, str("V_MPEGH/ISO/HEVC")), ...videoExtras]),
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

  it("reads the end of the file alongside the head once the size is known, and takes the Cues from it", async () => {
    const requests: string[] = [];
    const fetcher = Object.assign(
      async (start: number, end: number) => {
        requests.push(`${start}-${end}`);
        return file.subarray(start, Math.min(end + 1, file.length));
      },
      { whenSized: Promise.resolve(file.length) }
    );
    const index = await readMkvKeyframes(fetcher);
    expect(index?.keyframes).toEqual([0, 3.42, 6.84, 10.302]);
    // The head and the tail: no third request for the Cues.
    expect(requests.length).toBe(2);
    expect(requests).toContain(`0-${file.length - 1}`);
    // The tail itself is kept: ffmpeg reads the end of the file on every start.
    expect(index!.fetched.some((range) => range.start + range.bytes.length === file.length)).toBe(true);
  });

  it("asks for the Cues by offset when the tail read fails", async () => {
    let calls = 0;
    const fetcher = Object.assign(
      async (start: number, end: number) => {
        calls++;
        if (end === file.length - 1) throw new Error("tail refused");
        return file.subarray(start, Math.min(end + 1, file.length));
      },
      { whenSized: Promise.resolve(file.length) }
    );
    expect((await readMkvKeyframes(fetcher))?.keyframes).toEqual([0, 3.42, 6.84, 10.302]);
    expect(calls).toBe(3);
  });

  it("reads a Dolby Vision configuration from the video track's block addition mapping", () => {
    // Profile 5, level 6, no compatible base layer, as a "dvcC" mapping.
    const record = [1, 0, 0x0a, 0x35, 0x00, ...new Array<number>(19).fill(0)];
    const mapping = el(BLOCK_ADDITION_MAPPING_ID, [...el(BLOCK_ADD_ID_TYPE_ID, str("dvcC")), ...el(BLOCK_ADD_ID_EXTRA_DATA_ID, record)]);
    expect(parseSegmentLayout(buildMkv([0, 1000], mapping))!.dolbyVision).toEqual({ profile: 5, level: 6, baseLayer: "none" });
    expect(parseSegmentLayout(file)!.dolbyVision).toBeNull();
  });

  it("ignores block addition mappings that are not Dolby Vision", () => {
    const mapping = el(BLOCK_ADDITION_MAPPING_ID, [...el(BLOCK_ADD_ID_TYPE_ID, str("hvcE")), ...el(BLOCK_ADD_ID_EXTRA_DATA_ID, new Array<number>(24).fill(1))]);
    expect(parseSegmentLayout(buildMkv([0, 1000], mapping))!.dolbyVision).toBeNull();
  });

  it("returns null for data that is not Matroska", async () => {
    expect(await readMkvKeyframes(async () => new Uint8Array(64))).toBeNull();
  });
});

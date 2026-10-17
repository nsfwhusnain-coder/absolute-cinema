import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { __setLinkPacingForTests } from "./link-pacer";
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
  HEAD_BYTES,
  httpRangeFetcher,
  parseCueTimes,
  parseSegmentLayout,
  isVideoUndecodable,
  parameterSetsMissing,
  CODEC_PRIVATE_ID,
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
function buildMkv(cueTimesMs: number[], videoExtras: number[] = [], clusterBytes = 100): Uint8Array {
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
  const cluster = el(CLUSTER_ID, new Uint8Array(clusterBytes));
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

  it("reads a large file's head in parts at once, once the size is known", async () => {
    const big = buildMkv([0, 3420, 6840, 10302], [], 3 * 1024 * 1024);
    const requests: string[] = [];
    const fetcher = Object.assign(
      async (start: number, end: number) => {
        requests.push(`${start}-${end}`);
        return big.subarray(start, Math.min(end + 1, big.length));
      },
      { whenSized: Promise.resolve(big.length) }
    );
    const index = await readMkvKeyframes(fetcher);
    expect(index?.keyframes).toEqual([0, 3.42, 6.84, 10.302]);
    const part = HEAD_BYTES / 4;
    for (let i = 0; i < 4; i++) expect(requests).toContain(`${i * part}-${(i + 1) * part - 1}`);
    // The four parts and the tail, which holds the Cues.
    expect(requests.length).toBe(5);
    // The head is kept whole, as one range, for ffmpeg's every start.
    expect(index!.fetched[0]!.start).toBe(0);
    expect(index!.fetched[0]!.bytes).toEqual(big.subarray(0, HEAD_BYTES));
  });

  it("asks for the Cues as soon as the head's first part is in, not after the whole head", async () => {
    const big = buildMkv([0, 3420, 6840, 10302], [], 3 * 1024 * 1024);
    const part = HEAD_BYTES / 4;
    const events: string[] = [];
    const fetcher = Object.assign(
      async (start: number, end: number) => {
        if (end === big.length - 1) throw new Error("tail refused");
        const slow = start >= part && start < HEAD_BYTES;
        if (start >= HEAD_BYTES) events.push("cues asked");
        if (slow) await new Promise((resolve) => setTimeout(resolve, 150));
        if (slow) events.push("head part in");
        return big.subarray(start, Math.min(end + 1, big.length));
      },
      { whenSized: Promise.resolve(big.length) }
    );
    const index = await readMkvKeyframes(fetcher);
    expect(index?.keyframes).toEqual([0, 3.42, 6.84, 10.302]);
    expect(events[0]).toBe("cues asked");
    // The whole head is still kept.
    expect(index!.fetched[0]!.bytes.length).toBe(HEAD_BYTES);
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

describe("isVideoUndecodable", () => {
  it("turns away the codecs no browser decodes", () => {
    for (const id of ["V_MS/VFW/FOURCC", "V_MPEG2", "V_MPEG4/ISO/ASP", "V_MPEG4/ISO/SP", "V_MPEG4/MS/V3", "V_REAL/RV40"]) {
      expect(isVideoUndecodable(id, null)).toBe(true);
    }
  });

  it("keeps the codecs browsers play", () => {
    for (const id of ["V_MPEGH/ISO/HEVC", "V_AV1", "V_VP9", "V_MPEG4/ISO/AVC"]) {
      expect(isVideoUndecodable(id, null)).toBe(false);
    }
  });

  it("turns away the AVC profiles browsers cannot decode, and only those", () => {
    expect(isVideoUndecodable("V_MPEG4/ISO/AVC", 110)).toBe(true);
    expect(isVideoUndecodable("V_MPEG4/ISO/AVC", 100)).toBe(false);
  });
});

describe("httpRangeFetcher", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    __setLinkPacingForTests(null);
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`;
  }

  it("asks a link that refused a range again once its pause is over", async () => {
    __setLinkPacingForTests({ refusalPauseMs: 120, ratePerS: 1_000 });
    const askedAt: number[] = [];
    const url = await serve((_req, res) => {
      askedAt.push(Date.now());
      if (askedAt.length <= 2) return void res.writeHead(204).end();
      res.writeHead(206, { "Content-Range": "bytes 0-9/100", "Content-Length": "10" }).end(Buffer.alloc(10, 7));
    });
    const fetcher = httpRangeFetcher(url, 5_000);
    expect(await fetcher(0, 9)).toEqual(new Uint8Array(10).fill(7));
    expect(askedAt.length).toBe(3);
    expect(askedAt[1]! - askedAt[0]!).toBeGreaterThanOrEqual(110);
    expect(fetcher.size()).toBe(100);
  });

  it("gives up on a link that goes on refusing", async () => {
    __setLinkPacingForTests({ refusalPauseMs: 20, ratePerS: 1_000 });
    let asked = 0;
    const url = await serve((_req, res) => {
      asked++;
      res.writeHead(204).end();
    });
    await expect(httpRangeFetcher(url, 5_000)(0, 9)).rejects.toThrow("refused");
    expect(asked).toBe(4);
  });

  it("plans its reads from a size it was given, and reports the size the file is served at", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(206, { "Content-Range": "bytes 0-9/5000", "Content-Length": "10" }).end(Buffer.alloc(10, 1));
    });
    const fetcher = httpRangeFetcher(url, 5_000, 4_096);
    // Known before anything was asked for.
    expect(await fetcher.whenSized).toBe(4_096);
    expect(fetcher.size()).toBeNull();
    await fetcher(0, 9);
    expect(fetcher.size()).toBe(5_000);
  });

  it("does not ask again when the range was ignored", async () => {
    let asked = 0;
    const url = await serve((_req, res) => {
      asked++;
      res.writeHead(200, { "Content-Length": "10" }).end(Buffer.alloc(10));
    });
    await expect(httpRangeFetcher(url, 5_000)(0, 9)).rejects.toThrow("not supported");
    expect(asked).toBe(1);
  });
});

describe("parameterSetsMissing", () => {
  /** An hvcC: 22 bytes of configuration, then the arrays of NAL units (type, count, length-prefixed units). */
  function hvcC(arrays: Array<[type: number, units: number[][]]>): Uint8Array {
    const out = [1, ...new Array(21).fill(0), arrays.length];
    for (const [type, units] of arrays) {
      out.push(0x80 | type, units.length >> 8, units.length & 0xff);
      for (const unit of units) out.push(unit.length >> 8, unit.length & 0xff, ...unit);
    }
    return new Uint8Array(out);
  }
  const NAL = [0x40, 0x01, 0x0c, 0x01];

  it("finds HEVC parameter sets in a complete header", () => {
    expect(parameterSetsMissing("V_MPEGH/ISO/HEVC", hvcC([[32, [NAL]], [33, [NAL]], [34, [NAL]]]))).toBe(false);
  });

  it("knows an HEVC header that left them out: empty, without a PPS, or absent", () => {
    // The 23-byte hvcC of The Diplomat's AllDebrid 4K file: no arrays.
    expect(parameterSetsMissing("V_MPEGH/ISO/HEVC", hvcC([]))).toBe(true);
    expect(parameterSetsMissing("V_MPEGH/ISO/HEVC", hvcC([[32, [NAL]], [33, [NAL]]]))).toBe(true);
    expect(parameterSetsMissing("V_MPEGH/ISO/HEVC", hvcC([[32, [NAL]], [33, [NAL]], [34, []]]))).toBe(true);
    expect(parameterSetsMissing("V_MPEGH/ISO/HEVC", null)).toBe(true);
  });

  it("reads H.264 headers the same way", () => {
    const sps = [0x67, 0x64, 0x00, 0x28];
    const pps = [0x68, 0xee, 0x3c, 0x80];
    const avcC = (spsList: number[][], ppsList: number[][]) =>
      new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0 | spsList.length, ...spsList.flatMap((u) => [0, u.length, ...u]), ppsList.length, ...ppsList.flatMap((u) => [0, u.length, ...u])]);
    expect(parameterSetsMissing("V_MPEG4/ISO/AVC", avcC([sps], [pps]))).toBe(false);
    expect(parameterSetsMissing("V_MPEG4/ISO/AVC", avcC([], [pps]))).toBe(true);
    expect(parameterSetsMissing("V_MPEG4/ISO/AVC", avcC([sps], []))).toBe(true);
  });

  it("never asks it of other codecs", () => {
    expect(parameterSetsMissing("V_AV1", null)).toBe(false);
  });

  it("is read from the video track's header", () => {
    const complete = parseSegmentLayout(buildMkv([0, 1000], el(CODEC_PRIVATE_ID, hvcC([[32, [NAL]], [33, [NAL]], [34, [NAL]]]))));
    expect(complete?.videoParameterSetsMissing).toBe(false);
    const empty = parseSegmentLayout(buildMkv([0, 1000], el(CODEC_PRIVATE_ID, hvcC([]))));
    expect(empty?.videoParameterSetsMissing).toBe(true);
  });
});

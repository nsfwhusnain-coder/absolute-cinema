import { afterEach, describe, expect, it } from "bun:test";
import {
  AV1_PROBE_TYPES,
  HEVC_PROBE_TYPES,
  hevcSupport,
  probeDecodeSync,
  reportDecodeFailure,
  resetDecodeCapabilityCache,
  supportsAv1,
  supportsHevc,
  warmDecodeCapabilities,
} from "./decode-capability";

/** Extract the codec string from a full content-type. */
function codecOf(type: string): string {
  return type.match(/codecs="([^"]+)"/)?.[1] ?? "";
}

/** HEVC codec string → numeric level (the Lxxx field). */
function hevcLevel(codec: string): number {
  return Number(codec.match(/\.L(\d+)/)?.[1] ?? 0);
}

describe("HEVC probe matrix", () => {
  it("covers the 4K levels, which the previous single-string probe did not", () => {
    // The old probe was hvc1.1.6.L93.B0 — Main 8-bit, level 3.1 (~720p).
    // 4K HEVC needs level 5.0 (L150) or 5.1 (L153).
    const levels = HEVC_PROBE_TYPES.map((t) => hevcLevel(codecOf(t)));
    expect(levels.some((l) => l >= 150)).toBe(true);
  });

  it("covers Main10, which is what 4K HDR releases actually use", () => {
    // Profile is the first field: hvc1.<profile>.…  2 = Main10.
    const profiles = HEVC_PROBE_TYPES.map((t) => codecOf(t).split(".")[1]);
    expect(profiles).toContain("2");
  });

  it("still includes the original narrow string so nothing regresses", () => {
    expect(HEVC_PROBE_TYPES).toContain('video/mp4; codecs="hvc1.1.6.L93.B0"');
  });

  it("probes both hvc1 and hev1 box variants", () => {
    const codecs = HEVC_PROBE_TYPES.map(codecOf);
    expect(codecs.some((c) => c.startsWith("hvc1"))).toBe(true);
    expect(codecs.some((c) => c.startsWith("hev1"))).toBe(true);
  });
});

describe("AV1 probe matrix", () => {
  it("covers 10-bit, which the previous 8-bit-only probe did not", () => {
    // av01.<profile>.<level><tier>.<depth> — depth 10 is the 4K HDR case.
    const codecs = AV1_PROBE_TYPES.map(codecOf);
    expect(codecs.some((c) => c.endsWith(".10"))).toBe(true);
  });

  it("still includes the original narrow string", () => {
    expect(AV1_PROBE_TYPES).toContain('video/mp4; codecs="av01.0.05M.08"');
  });
});

describe("probeDecodeSync", () => {
  it("reports unsupported rather than throwing when there is no DOM", () => {
    // Server-side render: no window, no MediaSource, no document.
    const before = globalThis.window;
    // @ts-expect-error deliberately removing the global for this assertion
    delete globalThis.window;
    try {
      expect(probeDecodeSync(HEVC_PROBE_TYPES)).toEqual({ supported: false });
    } finally {
      if (before !== undefined) globalThis.window = before;
    }
  });

  it("treats an empty matrix as unsupported", () => {
    expect(probeDecodeSync([]).supported).toBe(false);
  });
});

describe("warmDecodeCapabilities", () => {
  const scope = globalThis as { window?: unknown; document?: unknown };
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  /** A browser whose type strings accept everything and whose decoder answers `decodes(contentType, height)`. */
  function browser(decodes: ((contentType: string, height: number) => boolean) | null): void {
    scope.window = {};
    scope.document = {
      documentElement: { getAttribute: () => null },
      createElement: () => ({ canPlayType: () => "probably" }),
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        userAgent: "test",
        ...(decodes
          ? {
              mediaCapabilities: {
                decodingInfo: async (config: { video: { contentType: string; height: number } }) => ({
                  supported: decodes(config.video.contentType, config.video.height),
                  powerEfficient: true,
                }),
              },
            }
          : {}),
      },
    });
    resetDecodeCapabilityCache();
  }

  afterEach(() => {
    delete scope.window;
    delete scope.document;
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
    resetDecodeCapabilityCache();
  });

  it("gives a codec up only when the decoder said no and a file of it then failed", async () => {
    browser((type) => !type.includes("hvc1"));
    await warmDecodeCapabilities();
    // The decoder's word alone changes nothing.
    expect(supportsHevc()).toBe(true);
    reportDecodeFailure("hevc");
    expect(supportsHevc()).toBe(false);
    expect(supportsAv1()).toBe(true);
  });

  it("does not give up a codec the decoder plays because one file failed", async () => {
    browser(() => true);
    await warmDecodeCapabilities();
    reportDecodeFailure("hevc");
    reportDecodeFailure("av1");
    reportDecodeFailure("h264");
    expect(supportsHevc()).toBe(true);
    expect(supportsAv1()).toBe(true);
  });

  it("keeps a codec the decoder plays at 1080p only", async () => {
    browser((_type, height) => height <= 1080);
    await warmDecodeCapabilities();
    expect(supportsHevc()).toBe(true);
    expect(hevcSupport().uhd).toBe(false);
  });

  it("leaves the type strings' answer alone when the decoder cannot be asked", async () => {
    browser(null);
    await warmDecodeCapabilities();
    expect(supportsHevc()).toBe(true);
  });
});

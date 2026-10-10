/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { decidePlayback } from "./decide-playback";
import { resetDecodeCapabilityCache } from "./decode-capability";
import { isSourcePlayableHere } from "./source-quality";
import type { PlaybackSource } from "./types";

function src(overrides: Partial<PlaybackSource> & { id: string }): PlaybackSource {
  return {
    url: `https://example.test/${overrides.id}`,
    provider: overrides.provider ?? "test",
    label: overrides.label ?? overrides.id,
    quality: overrides.quality ?? "1080p",
    type: overrides.type ?? "mp4",
    codec: "h264",
    ...overrides,
  };
}

const hindi1080 = src({
  id: "cinema-hi",
  provider: "CinemaOS",
  label: "Cinema HI",
  audioLanguage: "hi",
  maxHeight: 1080,
  container: "mp4",
});
const arabic1080 = src({
  id: "cinema-ar",
  provider: "CinemaOS",
  label: "Cinema AR",
  audioLanguage: "ar",
  maxHeight: 1080,
  container: "mp4",
});
const luna = src({
  id: "luna",
  provider: "Vixsrc",
  label: "Luna",
  audioLanguage: "und",
  type: "hls",
  maxHeight: 1080,
});
const kronos = src({
  id: "kronos",
  provider: "Debrid",
  origin: "debrid",
  label: "1080p • Debrid",
  audioLanguage: "en",
  titleMatch: "exact",
  container: "mp4",
  compat: "native",
  maxHeight: 1080,
});
const hades = src({
  id: "hades",
  provider: "Debrid",
  origin: "debrid",
  label: "4K • Debrid · Safari",
  audioLanguage: "en",
  titleMatch: "exact",
  container: "mkv",
  compat: "native",
  maxHeight: 2160,
});
const poseidon = src({
  id: "poseidon",
  provider: "Debrid",
  origin: "debrid",
  label: "4K • Debrid",
  audioLanguage: "en",
  titleMatch: "exact",
  container: "mp4",
  compat: "native",
  maxHeight: 2160,
});
const pack4k = src({
  id: "pack",
  provider: "Debrid",
  origin: "debrid",
  label: "Complete Collection 2160p",
  audioLanguage: "en",
  titleMatch: "pack",
  container: "mp4",
  maxHeight: 2160,
});

describe("decidePlayback contract", () => {
  it("starts remux 4K when Ultra is selected and no direct 4K exists", () => {
    const decision = decidePlayback([hindi1080, hades, luna], {
      preferredHeight: 2160,
      fourKStartup: "maximum",
    });
    expect(decision.immediate?.id).toBe("hades");
    expect(decision.deferredFourK).toBeNull();
  });

  it("starts 4K over 1080p when both are available (highest quality priority)", () => {
    const decision = decidePlayback([poseidon, kronos], {
      preferredHeight: "auto",
      fourKStartup: "maximum",
    });
    expect(decision.immediate?.id).toBe("poseidon");
    expect(decision.deferredFourK).toBeNull();
  });

  it("starts Kronos over Hindi and Arabic when 4K is absent", () => {
    const decision = decidePlayback([hindi1080, arabic1080, kronos], {
      preferredHeight: "auto",
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("kronos");
  });

  it("never auto-defaults a pack when an exact title exists", () => {
    const decision = decidePlayback([pack4k, kronos], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("kronos");
  });

  it("Ultra starts Luna instead of a pack 4K posing as Kronos", () => {
    const decision = decidePlayback([pack4k, luna], {
      preferredHeight: 2160,
      fourKStartup: "maximum",
    });
    expect(decision.immediate?.id).toBe("luna");
  });

  it("Ultra starts unlabeled Solstice 4K over English Kronos 1080", () => {
    const solstice = src({
      id: "solstice",
      provider: "Vidking",
      label: "Solstice",
      audioLanguage: "und",
      type: "hls",
      maxHeight: 2160,
    });
    const decision = decidePlayback([kronos, solstice, luna], {
      preferredHeight: 2160,
      fourKStartup: "maximum",
    });
    expect(decision.immediate?.id).toBe("solstice");
    expect(decision.deferredFourK).toBeNull();
  });

  it("starts native 4K immediately and does not defer remux", () => {
    const decision = decidePlayback([poseidon, kronos, hades], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("poseidon");
    expect(decision.deferredFourK).toBeNull();
  });

  it("maximum still refuses Hindi 4K when English HD exists", () => {
    const hindi4k = src({
      id: "cinema-hi-4k",
      provider: "CinemaOS",
      label: "Cinema HI",
      audioLanguage: "hi",
      maxHeight: 2160,
      container: "mp4",
    });
    const decision = decidePlayback([hindi4k, luna], {
      preferredHeight: 2160,
      fourKStartup: "maximum",
    });
    expect(decision.immediate?.id).toBe("luna");
  });

  it("stamped English Kronos beats unlabeled Luna", () => {
    const decision = decidePlayback([luna, kronos], {
      preferredHeight: "auto",
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("kronos");
  });

  it("starts remux 4K when Ultra has Hades but no Quasar/Poseidon", () => {
    const decision = decidePlayback([luna, hades], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("hades");
    expect(decision.deferredFourK).toBeNull();
  });

  it("starts the rich native 1080p, not a skinny labelled 1080p", () => {
    const leanLuna = src({
      id: "lean-luna",
      provider: "Vixsrc",
      label: "Luna",
      audioLanguage: "en",
      type: "hls",
      maxHeight: 1080,
      bitrateBps: 2_200_000,
    });
    const richKronos = src({
      ...kronos,
      bitrateBps: 12_000_000,
    });
    const decision = decidePlayback([leanLuna, richKronos], {
      preferredHeight: "auto",
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("kronos");
  });

  it("does not auto-start remux 4K when the packer is full", () => {
    const decision = decidePlayback([luna, hades], {
      preferredHeight: 2160,
      remuxAvailable: false,
    });
    expect(decision.immediate?.id).toBe("luna");
    expect(decision.deferredFourK).toBeNull();
  });

  it("starts a debrid file that needs remuxing over a web stream of the same height", () => {
    const debridMkv = src({
      id: "debrid-mkv",
      provider: "Debrid",
      origin: "debrid",
      label: "1080p • Debrid",
      audioLanguage: "en",
      titleMatch: "exact",
      container: "mkv",
      compat: "native",
      maxHeight: 1080,
    });
    const decision = decidePlayback([luna, debridMkv], { remuxAvailable: true });
    expect(decision.immediate?.id).toBe("debrid-mkv");
  });

  it("drops failed ids before ranking", () => {
    const decision = decidePlayback([kronos, luna], {
      fourKStartup: "fast",
      failedIds: ["kronos"],
    });
    expect(decision.immediate?.id).toBe("luna");
  });
});

describe("HEVC in a plain MP4", () => {
  const scope = globalThis as { window?: unknown; document?: unknown };

  /** A browser that decodes HEVC, and takes the `hev1` tag in a file or does not. */
  function browser(playsHev1Files: boolean): void {
    scope.window = {};
    scope.document = {
      documentElement: { getAttribute: () => null },
      createElement: () => ({
        canPlayType: (type: string) => (type.includes("hvc1") || (playsHev1Files && type.includes("hev1")) ? "probably" : ""),
      }),
    };
    resetDecodeCapabilityCache();
  }

  afterEach(() => {
    delete scope.window;
    delete scope.document;
    resetDecodeCapabilityCache();
  });

  const hevc = (id: string, container: "mp4" | "mkv") =>
    src({
      id,
      provider: "Debrid",
      origin: "debrid",
      codec: "hevc",
      container,
      compat: "safari",
      audioLanguage: "en",
      titleMatch: "exact",
      maxHeight: 1080,
    });

  it("is not offered at all once the file is known to be hev1 and the browser refuses those", () => {
    const known = { ...hevc("phoenix", "mp4"), codecTag: "hev1" as const };
    browser(false);
    expect(isSourcePlayableHere(known)).toBe(false);
    // Remuxed, the same stream would be renamed on the way, so only plain files are held back.
    expect(isSourcePlayableHere({ ...hevc("mkv", "mkv"), codecTag: "hev1" as const })).toBe(true);
    browser(true);
    expect(isSourcePlayableHere(known)).toBe(true);
  });

  it("comes after a remuxed file where the browser refuses hev1 files", () => {
    browser(false);
    const decision = decidePlayback([hevc("a-mp4", "mp4"), hevc("b-mkv", "mkv")], { remuxAvailable: true });
    expect(decision.immediate?.id).toBe("b-mkv");
  });

  it("still starts first where hev1 files play", () => {
    browser(true);
    const decision = decidePlayback([hevc("a-mp4", "mp4"), hevc("b-mkv", "mkv")], { remuxAvailable: true });
    expect(decision.immediate?.id).toBe("a-mp4");
  });
});

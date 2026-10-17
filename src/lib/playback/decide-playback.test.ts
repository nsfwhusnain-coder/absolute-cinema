/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { decidePlayback } from "./decide-playback";
import { resetDecodeCapabilityCache } from "./decode-capability";
import { isSourcePlayableHere, QUALITY_SCORE_STEP } from "./source-quality";
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

  it("Ultra holds unlabeled web Solstice 4K behind English Kronos 1080", () => {
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
    expect(decision.immediate?.id).toBe("kronos");
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

describe("a debrid file on a CDN too slow to carry it", () => {
  const MBIT = 1_000_000 / 8;
  const debrid = (id: string, maxHeight: number, cdnMbit: number): PlaybackSource =>
    src({ id, provider: "Debrid", origin: "debrid", compat: "native", container: "mp4", audioLanguage: "en", maxHeight, cdnBytesPerSec: cdnMbit * MBIT });

  it("is not started while a file that will play is there, at its height or under it", () => {
    const slow4k = debrid("alldebrid-4k", 2160, 2.5);
    expect(decidePlayback([slow4k, debrid("debrid-4k", 2160, 228)]).immediate?.id).toBe("debrid-4k");
    expect(decidePlayback([slow4k, debrid("debrid-1080", 1080, 228)]).immediate?.id).toBe("debrid-1080");
  });

  it("is started when it is all there is, and once its CDN can carry it again", () => {
    expect(decidePlayback([debrid("alldebrid-4k", 2160, 2.5)]).immediate?.id).toBe("alldebrid-4k");
    expect(decidePlayback([debrid("alldebrid-4k", 2160, 60), debrid("debrid-1080", 1080, 228)]).immediate?.id).toBe("alldebrid-4k");
  });
});

describe("the same height on two services", () => {
  const MBIT = 1_000_000 / 8;
  const debrid = (id: string, maxHeight: number, cdnMbit?: number): PlaybackSource =>
    src({ id, provider: "Debrid", origin: "debrid", compat: "native", container: "mp4", audioLanguage: "en", maxHeight, ...(cdnMbit ? { cdnBytesPerSec: cdnMbit * MBIT } : {}) });
  const start = (...sources: PlaybackSource[]) => decidePlayback(sources).immediate?.id;

  it("starts on the clearly faster CDN, whichever name sorts first", () => {
    expect(start(debrid("alldebrid-4k", 2160, 30), debrid("debrid-4k", 2160, 303))).toBe("debrid-4k");
    expect(start(debrid("alldebrid-4k", 2160, 303), debrid("debrid-4k", 2160, 30))).toBe("alldebrid-4k");
  });

  it("does not take a faster CDN over a higher picture", () => {
    expect(start(debrid("alldebrid-4k", 2160, 30), debrid("debrid-1080", 1080, 303))).toBe("alldebrid-4k");
  });

  it("starts on the primary service when the CDNs are much the same, or were never measured", () => {
    const sibling = (cdnMbit?: number) => ({ ...debrid("alldebrid-4k", 2160, cdnMbit), provider: "AllDebrid" });
    expect(start(sibling(280), debrid("debrid-4k", 2160, 303))).toBe("debrid-4k");
    expect(start(sibling(), debrid("debrid-4k", 2160, 303))).toBe("debrid-4k");
    expect(start(sibling(), debrid("debrid-4k", 2160))).toBe("debrid-4k");
  });

  it("starts on the primary service even when the sibling's file is the larger", () => {
    const sibling = { ...debrid("alldebrid-4k", 2160, 280), provider: "AllDebrid", bitrateBps: 60_000_000 };
    expect(start(sibling, { ...debrid("debrid-4k", 2160, 303), bitrateBps: 20_000_000 })).toBe("debrid-4k");
  });

  it("leaves the sibling first for a viewer who chose it", () => {
    const sibling = { ...debrid("alldebrid-4k", 2160, 280), provider: "AllDebrid", bitrateBps: 60_000_000 };
    const primary = { ...debrid("debrid-4k", 2160, 303), bitrateBps: 20_000_000 };
    expect(decidePlayback([sibling, primary], { preferredProvider: "alldebrid" }).immediate?.id).toBe("alldebrid-4k");
  });
});

describe("a file of several languages that is remuxed", () => {
  const dualAudio = (id: string, maxHeight: number): PlaybackSource =>
    src({ id, provider: "Debrid", origin: "debrid", compat: "native", container: "mkv", audioLanguage: "xx", multiAudio: true, maxHeight });
  const webEnglish = src({ id: "web-en", provider: "Vidrock", label: "Rock", type: "hls", audioLanguage: "en" });

  it("starts ahead of a web stream labelled English, since the remux picks its language", () => {
    expect(decidePlayback([webEnglish, dualAudio("debrid-1080", 1080)]).immediate?.id).toBe("debrid-1080");
    expect(decidePlayback([webEnglish, dualAudio("debrid-4k", 2160), dualAudio("debrid-1080", 1080)]).immediate?.id).toBe("debrid-4k");
  });

  it("is still passed over when it would be played as it is, on its maker's first track", () => {
    const direct = src({ id: "debrid-mp4", provider: "Debrid", origin: "debrid", compat: "native", container: "mp4", audioLanguage: "xx", multiAudio: true, maxHeight: 1080 });
    expect(decidePlayback([webEnglish, direct]).immediate?.id).toBe("web-en");
  });
});

describe("a web stream behind a debrid file of 1080p or better", () => {
  const webUhd = src({
    id: "web-uhd",
    provider: "Vidrock",
    label: "Rock 4K",
    audioLanguage: "en",
    type: "hls",
    maxHeight: 2160,
  });
  const debrid720 = src({
    id: "debrid-720",
    provider: "Debrid",
    origin: "debrid",
    label: "720p • Debrid",
    audioLanguage: "en",
    titleMatch: "exact",
    container: "mp4",
    compat: "native",
    maxHeight: 720,
  });

  it("does not start a web 2160 stream over a debrid 1080p file, for a 4K viewer or on auto", () => {
    expect(decidePlayback([webUhd, kronos], { preferredHeight: 2160, fourKStartup: "maximum" }).immediate?.id).toBe("kronos");
    expect(decidePlayback([webUhd, kronos], { preferredHeight: "auto", fourKStartup: "fast" }).immediate?.id).toBe("kronos");
  });

  it("does not hold back a web 2160 stream when no debrid file reaches 1080p", () => {
    expect(decidePlayback([webUhd, debrid720], { preferredHeight: 2160, fourKStartup: "maximum" }).immediate?.id).toBe("web-uhd");
  });

  it("still lets a web 1080p stream beat a debrid 720p file", () => {
    expect(decidePlayback([luna, debrid720]).immediate?.id).toBe("luna");
  });
});

describe("picture quality before delivery", () => {
  /** A debrid file with English audio and the release score and tier the server stamps on it. */
  const scored = (id: string, container: "mp4" | "mkv", maxHeight: number, score: number, tier: 1 | 2 | 3 = 3): PlaybackSource =>
    src({
      id,
      provider: "Debrid",
      origin: "debrid",
      compat: "native",
      container,
      audioLanguage: "en",
      titleMatch: "exact",
      maxHeight,
      qualityTier: tier,
      qualityScore: score,
    });

  it("starts the sharper remux over a direct file with far less picture, in either order", () => {
    const remux = scored("remux-1080", "mkv", 1080, 430);
    const direct = scored("direct-1080", "mp4", 1080, 90);
    expect(decidePlayback([direct, remux]).immediate?.id).toBe("remux-1080");
    expect(decidePlayback([remux, direct]).immediate?.id).toBe("remux-1080");
  });

  it("starts the direct file when the scores are within one step, for the quicker start", () => {
    const remux = scored("remux-1080", "mkv", 1080, 300);
    const direct = scored("direct-1080", "mp4", 1080, 280);
    expect(decidePlayback([remux, direct]).immediate?.id).toBe("direct-1080");
  });

  it("counts a gap of exactly one QUALITY_SCORE_STEP as a real difference", () => {
    const direct = scored("direct-1080", "mp4", 1080, 90);
    expect(decidePlayback([direct, scored("remux-1080", "mkv", 1080, 90 + QUALITY_SCORE_STEP)]).immediate?.id).toBe("remux-1080");
    expect(decidePlayback([direct, scored("remux-1080", "mkv", 1080, 90 + QUALITY_SCORE_STEP - 1)]).immediate?.id).toBe("direct-1080");
  });

  it("ranks a flagged file behind a normal one at the same height, whatever the scores", () => {
    const flagged = scored("flagged-direct", "mp4", 1080, 500, 1);
    const normal = scored("normal-remux", "mkv", 1080, 100);
    expect(decidePlayback([flagged, normal]).immediate?.id).toBe("normal-remux");
    expect(decidePlayback([normal, flagged]).immediate?.id).toBe("normal-remux");
  });

  it("picks a normal remux 4K over a flagged direct 4K", () => {
    const flagged = scored("flagged-4k", "mp4", 2160, 500, 1);
    const normal = scored("normal-4k", "mkv", 2160, 100);
    const maximum = { preferredHeight: 2160, fourKStartup: "maximum" } as const;
    expect(decidePlayback([flagged, normal], maximum).immediate?.id).toBe("normal-4k");
    expect(decidePlayback([normal, flagged], maximum).immediate?.id).toBe("normal-4k");
  });

  it("keeps a direct file before a remux when neither carries picture quality", () => {
    const remux = src({ id: "remux-plain", provider: "Debrid", origin: "debrid", compat: "native", container: "mkv", audioLanguage: "en", titleMatch: "exact", maxHeight: 1080 });
    const direct = src({ id: "direct-plain", provider: "Debrid", origin: "debrid", compat: "native", container: "mp4", audioLanguage: "en", titleMatch: "exact", maxHeight: 1080 });
    expect(decidePlayback([remux, direct]).immediate?.id).toBe("direct-plain");
  });

  it("still leaves out a remux, however sharp, when the packer is full", () => {
    const direct = scored("direct-1080", "mp4", 1080, 90);
    expect(decidePlayback([scored("remux-4k", "mkv", 2160, 430), direct], { remuxAvailable: false }).immediate?.id).toBe("direct-1080");
    expect(decidePlayback([scored("remux-1080", "mkv", 1080, 430), direct], { remuxAvailable: false }).immediate?.id).toBe("direct-1080");
  });
});

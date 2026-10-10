import { isTvUserAgent } from "@/lib/tv-detect";

export const UHD_WIDTH = 3840;
export const UHD_HEIGHT = 2160;
export const UHD_BITRATE = 20_000_000;
export const UHD_FRAMERATE = 24;

/**
 * HEVC strings spanning the tiers actually shipped: Main 8-bit at 720p/1080p
 * levels, Main10 at 4K levels, and the `hev1`/`hvc1` box variants, which some
 * browsers accept asymmetrically.
 */
export const HEVC_PROBE_TYPES: readonly string[] = [
  'video/mp4; codecs="hvc1.2.4.L153.B0"', // Main10 L5.1 — 4K HDR
  'video/mp4; codecs="hvc1.2.4.L150.B0"', // Main10 L5.0 — 4K
  'video/mp4; codecs="hev1.2.4.L150.B0"',
  'video/mp4; codecs="hvc1.1.6.L123.B0"', // Main L4.1 — 1080p
  'video/mp4; codecs="hvc1.1.6.L93.B0"', // Main L3.1 — the old, narrow probe
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1"',
  'video/mp4; codecs="hev1"',
];

/** AV1 across 8-bit and 10-bit at 4K-capable levels. */
export const AV1_PROBE_TYPES: readonly string[] = [
  'video/mp4; codecs="av01.0.13M.10"', // Main, level 5.1, 10-bit — 4K HDR
  'video/mp4; codecs="av01.0.12M.10"',
  'video/mp4; codecs="av01.0.13M.08"',
  'video/mp4; codecs="av01.0.05M.08"', // the old, narrow probe
  'video/mp4; codecs="av01"',
];

/** HEVC under the `hev1` sample entry, as it appears in a plain MP4 file. */
export const HEV1_FILE_PROBE_TYPES: readonly string[] = [
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.2.4.L120.B0"',
];

/** Dolby Vision profile 5 (the one with no HDR10 layer to fall back on), in both sample-entry spellings. */
export const DOLBY_VISION_PROBE_TYPES: readonly string[] = [
  'video/mp4; codecs="dvh1.05.06"',
  'video/mp4; codecs="dvhe.05.06"',
];

export interface DecodeSupport {
  /** Any transport reports this codec as decodable. */
  supported: boolean;
  /** mediaCapabilities confirmed decode at 4K. Undefined until the async probe lands. */
  uhd?: boolean;
  /** mediaCapabilities reports hardware-backed decode at 4K. */
  hardware?: boolean;
}

const UNSUPPORTED: DecodeSupport = { supported: false };

/** True when MSE accepts any string in the matrix. */
function mseAccepts(types: readonly string[]): boolean {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported) {
    return false;
  }
  for (const type of types) {
    try {
      if (MediaSource.isTypeSupported(type)) return true;
    } catch {
      /* a throwing string is a no, not a fatal error */
    }
  }
  return false;
}

/** True when a `<video>` element accepts any string in the matrix. */
function elementAccepts(types: readonly string[]): boolean {
  if (typeof document === "undefined") return false;
  let probe: HTMLVideoElement;
  try {
    probe = document.createElement("video");
  } catch {
    return false;
  }
  for (const type of types) {
    try {
      const answer = probe.canPlayType(type);
      if (answer === "probably" || answer === "maybe") return true;
    } catch {
      /* keep probing the rest of the matrix */
    }
  }
  return false;
}

/** Synchronous best answer: either transport accepting any tier is support. */
export function probeDecodeSync(types: readonly string[]): DecodeSupport {
  if (typeof window === "undefined") return UNSUPPORTED;
  return { supported: mseAccepts(types) || elementAccepts(types) };
}

const hevcCache: { value: DecodeSupport | null } = { value: null };
const av1Cache: { value: DecodeSupport | null } = { value: null };

function cachedProbe(
  cache: { value: DecodeSupport | null },
  types: readonly string[]
): DecodeSupport {
  if (cache.value) return cache.value;
  if (typeof window === "undefined") return UNSUPPORTED;
  cache.value = probeDecodeSync(types);
  return cache.value;
}

export function hevcSupport(): DecodeSupport {
  return cachedProbe(hevcCache, HEVC_PROBE_TYPES);
}

export function av1Support(): DecodeSupport {
  return cachedProbe(av1Cache, AV1_PROBE_TYPES);
}

/**
 * Living-room panels whose codec probes lie. Hisense VIDAA / Chrome 76
 * answers "" for every hvc1 string even though the SoC decodes HEVC in
 * hardware. Inventory (`supportsHevc`) and the engine path
 * (`hevcNeedsNativePath`) must agree, or remuxed 4K HEVC is handed to
 * hls.js+MSE and blacks out.
 */
function isLivingRoomHevcTrust(): boolean {
  if (typeof navigator !== "undefined" && isTvUserAgent(navigator.userAgent || "")) {
    return true;
  }
  return (
    typeof document !== "undefined" &&
    document.documentElement?.getAttribute("data-tv") === "1"
  );
}

export function supportsHevc(): boolean {
  // Trust the panel, not the broken probe — otherwise every 4K HEVC release
  // vanishes from the 85-inch roster.
  if (isLivingRoomHevcTrust()) return true;
  return hevcSupport().supported;
}

export function supportsAv1(): boolean {
  return av1Support().supported;
}

let hev1FileCache: boolean | null = null;

/**
 * Whether a plain MP4 whose HEVC is tagged `hev1` plays here. Chromium takes
 * either tag; Apple's player takes only `hvc1`, and half the HEVC MP4s in
 * circulation are `hev1`. No opinion (true) without a DOM, and on TV panels
 * whose codec probes answer nothing at all.
 */
export function supportsHev1Files(): boolean {
  if (typeof document === "undefined" || isLivingRoomHevcTrust()) return true;
  if (hev1FileCache === null) hev1FileCache = elementAccepts(HEV1_FILE_PROBE_TYPES);
  return hev1FileCache;
}

/** True where the browser decodes Dolby Vision itself (Safari on Apple screens that support it). */
export function supportsDolbyVision(): boolean {
  return probeDecodeSync(DOLBY_VISION_PROBE_TYPES).supported;
}

interface DecodingInfo {
  supported: boolean;
  smooth?: boolean;
  powerEfficient?: boolean;
}

interface CapabilityNavigator {
  mediaCapabilities?: {
    decodingInfo(config: unknown): Promise<DecodingInfo>;
  };
}

/** One size of one codec, as asked of the browser's decoder. */
interface DecodeTier {
  contentType: string;
  width: number;
  height: number;
  bitrate: number;
}

const HD_WIDTH = 1920;
const HD_HEIGHT = 1080;
const HD_BITRATE = 8_000_000;

/** Largest first: the first tier is the 4K one. */
const HEVC_TIERS: readonly DecodeTier[] = [
  { contentType: 'video/mp4; codecs="hvc1.2.4.L150.B0"', width: UHD_WIDTH, height: UHD_HEIGHT, bitrate: UHD_BITRATE },
  { contentType: 'video/mp4; codecs="hvc1.1.6.L123.B0"', width: HD_WIDTH, height: HD_HEIGHT, bitrate: HD_BITRATE },
];
const AV1_TIERS: readonly DecodeTier[] = [
  { contentType: 'video/mp4; codecs="av01.0.13M.10"', width: UHD_WIDTH, height: UHD_HEIGHT, bitrate: UHD_BITRATE },
  { contentType: 'video/mp4; codecs="av01.0.08M.08"', width: HD_WIDTH, height: HD_HEIGHT, bitrate: HD_BITRATE },
];
/** Both ways a stream reaches the decoder here: appended through Media Source, or opened as a file. */
const DECODE_ROUTES = ["media-source", "file"] as const;

async function probeTier(tier: DecodeTier, type: (typeof DECODE_ROUTES)[number]): Promise<DecodingInfo | null> {
  if (typeof navigator === "undefined") return null;
  const api = (navigator as unknown as CapabilityNavigator).mediaCapabilities;
  if (!api?.decodingInfo) return null;
  try {
    return await api.decodingInfo({
      type,
      video: { contentType: tier.contentType, width: tier.width, height: tier.height, bitrate: tier.bitrate, framerate: UHD_FRAMERATE },
    });
  } catch {
    return null;
  }
}

/** What the browser's decoder says of a codec, or null when it cannot be asked. */
async function measureDecode(tiers: readonly DecodeTier[]): Promise<DecodeSupport | null> {
  const answers = await Promise.all(
    tiers.map(async (tier) => (await Promise.all(DECODE_ROUTES.map((route) => probeTier(tier, route)))).filter((a) => a !== null))
  );
  if (answers.every((tier) => tier.length === 0)) return null;
  const top = answers[0] ?? [];
  return {
    supported: answers.some((tier) => tier.some((a) => a.supported)),
    uhd: top.some((a) => a.supported),
    hardware: top.some((a) => a.supported && a.powerEfficient === true),
  };
}

type MeasuredCodec = "hevc" | "av1";

/** What the decoder said of each codec when asked (null until it has been, or when it cannot be). */
const measured: Record<MeasuredCodec, DecodeSupport | null> = { hevc: null, av1: null };

const REFUSED_STORAGE_KEY = "absolute-cinema.decode-refused";
/** A refusal is forgotten after this long, so a new driver or browser version gets another try. */
const REFUSAL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function readRefusals(): Partial<Record<MeasuredCodec, number>> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(REFUSED_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<MeasuredCodec, number>>) : {};
  } catch {
    return {};
  }
}

function rememberRefusal(codec: MeasuredCodec): void {
  try {
    localStorage.setItem(REFUSED_STORAGE_KEY, JSON.stringify({ ...readRefusals(), [codec]: Date.now() }));
  } catch {
    /* private mode: the refusal holds for this visit only */
  }
}

function cacheOf(codec: MeasuredCodec): { value: DecodeSupport | null } {
  return codec === "hevc" ? hevcCache : av1Cache;
}

/**
 * Asks the decoder itself what it plays. A yes turns a codec on that the type
 * strings were too modest about (one narrow HEVC string answered "no" for a
 * browser that decodes 4K). A no is only kept, for `reportDecodeFailure`: the
 * strings and a working picture outrank a second opinion on its own.
 */
export async function warmDecodeCapabilities(): Promise<void> {
  const [hevc, av1] = await Promise.all([measureDecode(HEVC_TIERS), measureDecode(AV1_TIERS)]);
  measured.hevc = hevc;
  measured.av1 = av1;
  const refused = readRefusals();
  for (const codec of ["hevc", "av1"] as const) {
    const answer = measured[codec];
    if (!answer) continue;
    const before = codec === "hevc" ? hevcSupport() : av1Support();
    const stillRefused = !answer.supported && Date.now() - (refused[codec] ?? 0) < REFUSAL_MAX_AGE_MS;
    cacheOf(codec).value = { ...answer, supported: stillRefused ? false : before.supported || answer.supported };
  }
}

/**
 * A file of this codec failed to decode here. One file can be at fault, so
 * the codec is only given up when the decoder had also said it does not play
 * it: a Chromium with no hardware HEVC decoder (a remote session, a virtual
 * machine, some GPUs) accepts every HEVC type string, and each HEVC file then
 * failed on its first frame, one after another, before playback reached one
 * it could show. Remembered for this device, so it costs one failed start.
 */
export function reportDecodeFailure(codec: string | undefined): void {
  if (codec !== "hevc" && codec !== "av1") return;
  const answer = measured[codec];
  if (!answer || answer.supported) return;
  cacheOf(codec).value = { ...answer, supported: false };
  rememberRefusal(codec);
}

export function hevcNeedsNativePath(): boolean {
  if (mseAccepts(HEVC_PROBE_TYPES)) return false;
  if (elementAccepts(HEVC_PROBE_TYPES)) return true;
  return isLivingRoomHevcTrust();
}

export function resetDecodeCapabilityCache(): void {
  hevcCache.value = null;
  av1Cache.value = null;
  hev1FileCache = null;
  measured.hevc = null;
  measured.av1 = null;
}

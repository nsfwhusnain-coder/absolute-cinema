/**
 * Per-browser media buffer budgets.
 *
 * A browser caps how much media one SourceBuffer may hold, and the cap is in
 * bytes, not seconds: Chrome, Edge and Opera on desktop refuse appends at about
 * 150 MB of video, Firefox at about 100 MB, Safari on macOS at about 290 MB
 * (and it evicts silently rather than refusing), and a Chromecast-class TV
 * browser at about 30 MB. A remuxed 4K file at 40 Mbit/s is 5 MB a second, so a
 * number of seconds that is safe in one browser is a refused append in another.
 * The budgets here are therefore in bytes, sized under each cap, and
 * `BufferBudget` turns them into seconds from the bitrate actually being loaded.
 *
 * Detection is deliberately conservative: only a positive TV match gets the TV
 * budget. Every other browser is placed by its engine, and an unrecognised
 * agent gets the Chromium budget, the one most browsers that are not named here
 * are built on.
 */

import { isTvLikeDevice, isTvUserAgent } from "@/lib/tv-detect";

export type DeviceClass = "tv" | "desktop";

/** The browser families that have a buffer budget of their own. */
export type MediaPlatform = "chromium" | "firefox" | "safari" | "ios" | "android" | "tv";

export interface MediaBufferProfile {
  /** Bytes held for media ahead of the playhead. */
  forwardBytes: number;
  /** Bytes kept behind the playhead for an instant rewind. */
  backBytes: number;
  /** Most seconds ever held ahead of the playhead, however low the bitrate. */
  forwardMaxS: number;
  /** Most seconds ever kept behind the playhead. */
  backMaxS: number;
  /** Seconds ahead used until a bitrate is known, from the server, the manifest or a measurement. */
  fallbackForwardS: number;
  /** Seconds behind used until a bitrate is known. */
  fallbackBackS: number;
  /** Pre-measurement ABR bandwidth guess, bits/sec. */
  abrInitialEstimateBps: number;
}

const MB = 1_000_000;

/**
 * One budget per browser family. Desktop Safari has the largest cap, so it has
 * the largest budget; the TV budget is the smallest so a set's tab does not run
 * out of memory, yet still holds a 4K HEVC fragment of 4 to 8 MB with room
 * to spare.
 */
const PROFILES: Record<MediaPlatform, MediaBufferProfile> = {
  chromium: {
    forwardBytes: 90 * MB,
    backBytes: 20 * MB,
    forwardMaxS: 120,
    backMaxS: 30,
    fallbackForwardS: 30,
    fallbackBackS: 10,
    abrInitialEstimateBps: 10_000_000,
  },
  firefox: {
    forwardBytes: 60 * MB,
    backBytes: 15 * MB,
    forwardMaxS: 120,
    backMaxS: 30,
    fallbackForwardS: 30,
    fallbackBackS: 10,
    abrInitialEstimateBps: 10_000_000,
  },
  safari: {
    forwardBytes: 160 * MB,
    backBytes: 30 * MB,
    forwardMaxS: 120,
    backMaxS: 30,
    fallbackForwardS: 30,
    fallbackBackS: 10,
    abrInitialEstimateBps: 10_000_000,
  },
  ios: {
    forwardBytes: 90 * MB,
    backBytes: 15 * MB,
    forwardMaxS: 90,
    backMaxS: 20,
    fallbackForwardS: 30,
    fallbackBackS: 10,
    abrInitialEstimateBps: 10_000_000,
  },
  android: {
    forwardBytes: 60 * MB,
    backBytes: 10 * MB,
    forwardMaxS: 90,
    backMaxS: 20,
    fallbackForwardS: 30,
    fallbackBackS: 10,
    abrInitialEstimateBps: 10_000_000,
  },
  tv: {
    forwardBytes: 40 * MB,
    backBytes: 8 * MB,
    forwardMaxS: 60,
    backMaxS: 12,
    fallbackForwardS: 12,
    fallbackBackS: 4,
    abrInitialEstimateBps: 12_000_000,
  },
};

/**
 * JS heap ceiling below which a browser gets the TV budget regardless of user
 * agent. 1.5 GB is comfortably under desktop Chrome (typically ~2-4 GB) and
 * above the constrained tabs this protects, so it catches TV browsers that
 * disguise their UA without ever mis-classifying a laptop.
 */
const CONSTRAINED_HEAP_LIMIT_BYTES = 1_500_000_000;

interface HeapAwarePerformance extends Performance {
  memory?: { jsHeapSizeLimit?: number };
}

/** JS heap ceiling in bytes, or 0 when the browser does not report one. */
export function reportedHeapLimitBytes(): number {
  if (typeof performance === "undefined") return 0;
  const memory = (performance as HeapAwarePerformance).memory;
  const limit = memory?.jsHeapSizeLimit;
  return typeof limit === "number" && limit > 0 ? limit : 0;
}

/**
 * Classify from a user-agent string. Exported separately from `detectDeviceClass`
 * so it stays pure and testable without a DOM.
 */
export function deviceClassFromUserAgent(userAgent: string): DeviceClass {
  return isTvUserAgent(userAgent) ? "tv" : "desktop";
}

/** Cached — device class cannot change mid-session, and callers sit in hot paths. */
let deviceClassCache: DeviceClass | null = null;

export function detectDeviceClass(): DeviceClass {
  if (deviceClassCache !== null) return deviceClassCache;
  if (typeof navigator === "undefined") {
    deviceClassCache = "desktop";
    return deviceClassCache;
  }
  // isTvLikeDevice() carries the query-string override and the input-profile
  // heuristic as well as the user agent, so a Google TV panel reporting plain
  // Chrome now gets the TV budget it needs rather than the desktop one it was
  // silently being handed.
  const heap = reportedHeapLimitBytes();
  const constrained = heap > 0 && heap < CONSTRAINED_HEAP_LIMIT_BYTES;
  deviceClassCache = isTvLikeDevice() || constrained ? "tv" : "desktop";
  return deviceClassCache;
}

export interface MediaPlatformInput {
  userAgent: string;
  /** `navigator.maxTouchPoints`. */
  maxTouchPoints: number;
  /** The TV decision of `detectDeviceClass()`, which also reads the input profile and the heap limit. */
  tv: boolean;
}

/** Chromium-family tokens: a Safari token next to one of these is Chrome, Edge or Opera, not Safari. */
const CHROMIUM_TOKEN = /chrom(e|ium)\/|edg[ae]?\/|opr\/|opera/i;

/**
 * The browser family whose buffer budget applies. Pure, so it is tested with
 * the user agents each family actually sends.
 */
export function mediaPlatformFor({ userAgent, maxTouchPoints, tv }: MediaPlatformInput): MediaPlatform {
  if (tv || isTvUserAgent(userAgent)) return "tv";
  // iPadOS asks for the desktop site by default, so its agent names a Mac. Only a touch screen tells it apart from one.
  if (/iphone|ipod|ipad/i.test(userAgent) || (/macintosh/i.test(userAgent) && maxTouchPoints > 1)) return "ios";
  // Every Android browser gets the Android budget, Firefox for Android included, so this is checked before the desktop Firefox pattern.
  if (/android/i.test(userAgent)) return "android";
  if (/firefox\//i.test(userAgent)) return "firefox";
  if (/safari\//i.test(userAgent) && !CHROMIUM_TOKEN.test(userAgent)) return "safari";
  return "chromium";
}

let mediaPlatformCache: MediaPlatform | null = null;

/** The budget family of the browser running this session. Cached, like the device class. */
export function activeMediaPlatform(): MediaPlatform {
  if (mediaPlatformCache !== null) return mediaPlatformCache;
  if (typeof navigator === "undefined") {
    mediaPlatformCache = "chromium";
    return mediaPlatformCache;
  }
  mediaPlatformCache = mediaPlatformFor({
    userAgent: navigator.userAgent || "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    tv: detectDeviceClass() === "tv",
  });
  return mediaPlatformCache;
}

/** Buffer budget for a browser family. Pure — pass the family in to test it. */
export function bufferProfileFor(platform: MediaPlatform): MediaBufferProfile {
  return PROFILES[platform];
}

/** Buffer budget for the browser actually running this session. */
export function activeBufferProfile(): MediaBufferProfile {
  return bufferProfileFor(activeMediaPlatform());
}

/**
 * Compact platform summary for telemetry. Without this, `player_feedback`
 * records provider/engine/heights and nothing that distinguishes a television
 * session from a laptop one — which is why cross-device playback differences
 * were invisible in production logs.
 */
export interface PlatformSummary {
  deviceClass: DeviceClass;
  uaPlatform: string;
  heapLimitMb?: number;
  cores?: number;
  screenWidth?: number;
}

/** Coarse platform token — never the raw UA, which is long and identifying. */
export function uaPlatformToken(userAgent: string): string {
  // VIDAA / Hisense panels also say Chrome/76 — match the panel first so
  // player_feedback is not recorded as a laptop Chrome session.
  if (/vidaa/i.test(userAgent)) return "vidaa";
  if (/hisense/i.test(userAgent) && !/mobile/i.test(userAgent)) return "hisense";
  const match = userAgent.match(
    /(web[o0]s|tizen|hbbtv|netcast|android\s?tv|crkey|smart-?tv)/i
  );
  if (match) return match[1].toLowerCase().replace(/\s+/g, "");
  if (/edg\//i.test(userAgent)) return "edge";
  if (/firefox\//i.test(userAgent)) return "firefox";
  if (/chrome\//i.test(userAgent)) return "chrome";
  if (/safari\//i.test(userAgent)) return "safari";
  return "other";
}

export function platformSummary(): PlatformSummary | undefined {
  if (typeof navigator === "undefined") return undefined;
  const userAgent = navigator.userAgent || "";
  const heap = reportedHeapLimitBytes();
  return {
    deviceClass: detectDeviceClass(),
    uaPlatform: uaPlatformToken(userAgent),
    ...(heap > 0 ? { heapLimitMb: Math.round(heap / 1_048_576) } : {}),
    ...(navigator.hardwareConcurrency
      ? { cores: navigator.hardwareConcurrency }
      : {}),
    ...(typeof screen !== "undefined" && screen.width
      ? { screenWidth: screen.width }
      : {}),
  };
}

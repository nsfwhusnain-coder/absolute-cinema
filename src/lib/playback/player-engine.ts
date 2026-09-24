import type { PlaybackSource } from "./types";
import { sourceDelivery } from "./source-quality";
import { hevcNeedsNativePath } from "./decode-capability";
import { shouldUseNativeHlsOnTv } from "./hls-engine";
import { isTvLikeDevice } from "@/lib/tv-navigation";

/** Must match the pinned hls.js package and vendored public worker asset. */
export const HLS_WORKER_PATH = "/hls.worker-1.6.16.js";

/** Valid no-op classic script — construct and terminate only, never posted to. */
const HLS_WORKER_PROBE_SOURCE = "self.onmessage=function(){};";
const HLS_WORKER_SCRIPT_MIME = "text/javascript";

let hlsWorkerSupportCache: boolean | null = null;

export function preferNativeHls(
  _video: HTMLVideoElement,
  source?: PlaybackSource | null
): boolean {
  if (!isTvLikeDevice()) return false;
  return shouldUseNativeHlsOnTv({
    isTv: true,
    hevcNeedsNative: hevcNeedsNativePath(),
    codec: source?.codec,
    origin: source?.origin,
    compat: source?.compat,
    delivery: source ? sourceDelivery(source) : undefined,
  });
}

function probeBlobWorker(): boolean {
  if (typeof Worker === "undefined") return false;
  if (typeof Blob === "undefined" || typeof URL === "undefined") return false;
  if (typeof URL.createObjectURL !== "function") return false;
  let objectUrl = "";
  try {
    objectUrl = URL.createObjectURL(
      new Blob([HLS_WORKER_PROBE_SOURCE], { type: HLS_WORKER_SCRIPT_MIME })
    );
    const worker = new Worker(objectUrl);
    worker.terminate();
    return true;
  } catch {
    return false;
  } finally {
    if (objectUrl !== "") {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* probe result already decided */
      }
    }
  }
}

/**
 * hls.js demuxer worker: capability only (Worker + blob-URL construct).
 * Cached — the runtime cannot grow a Worker mid-session. No user-agent fork.
 */
export function hlsWorkerSupportedHere(): boolean {
  if (hlsWorkerSupportCache !== null) return hlsWorkerSupportCache;
  if (typeof Worker === "undefined") return false;
  hlsWorkerSupportCache = probeBlobWorker();
  return hlsWorkerSupportCache;
}

/** Test seam. Production code never needs to clear the cache. */
export function resetHlsWorkerSupportCache(): void {
  hlsWorkerSupportCache = null;
}

export function isSessionExpiredError(data: {
  response?: { code?: number };
  details?: string;
  reason?: string;
  url?: string;
}): boolean {
  const code = data.response?.code;
  const detail = String(data.details ?? data.reason ?? "").toLowerCase();
  const url = String(data.url ?? "").toLowerCase();
  return (
    code === 410 ||
    detail.includes("410") ||
    detail.includes("session expired") ||
    url.includes("session expired")
  );
}

export function attemptAutoplay(
  video: HTMLVideoElement,
  onBlocked: () => void,
  onMutedFallback?: () => void,
  allowMutedFallback = true
): void {
  video.play().catch((err: unknown) => {
    const isNotAllowed = err instanceof DOMException && err.name === "NotAllowedError";
    if (isNotAllowed && allowMutedFallback && !video.muted && onMutedFallback) {
      video.muted = true;
      video.play().then(onMutedFallback, () => onBlocked());
      return;
    }
    onBlocked();
  });
}

export function freezeLastVideoFrame(video: HTMLVideoElement): void {
  if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    video.poster = canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    /* Cross-origin frames cannot be snapshotted. */
  }
}

export function classifyPlaybackUrl(
  src: string,
  streamType: PlaybackSource["type"] | string | undefined
): {
  useDash: boolean;
  useHls: boolean;
  isTranscoded: boolean;
  isHomeHlsProxy: boolean;
  isWorkerProxy: boolean;
  isProxied: boolean;
} {
  const isHomeHlsProxy = src.startsWith("/api/hls/");
  const isTranscoded = src.startsWith("/api/transcode");
  const isWorkerProxy =
    src.includes("workers.dev") ||
    (src.startsWith("https://") && src.includes("/?t=")) ||
    Boolean(
      process.env.NEXT_PUBLIC_WORKER_PROXY_HOST &&
        src.includes(process.env.NEXT_PUBLIC_WORKER_PROXY_HOST)
    );
  const useDash = streamType === "dash" && !isTranscoded;
  const useHls =
    isTranscoded ||
    streamType === "hls" ||
    (streamType !== "mp4" && streamType !== "dash" && src.includes(".m3u8"));
  return {
    useDash,
    useHls,
    isTranscoded,
    isHomeHlsProxy,
    isWorkerProxy,
    isProxied: isHomeHlsProxy || isWorkerProxy || isTranscoded,
  };
}

export function bufferedAheadSeconds(video: HTMLVideoElement): number {
  try {
    const t = video.currentTime;
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      const end = ranges.end(i);
      if (t >= start && t <= end) return Math.max(0, end - t);
      if (t < start) return 0;
    }
    return ranges.length ? Math.max(0, ranges.end(ranges.length - 1) - t) : 0;
  } catch {
    return -1;
  }
}

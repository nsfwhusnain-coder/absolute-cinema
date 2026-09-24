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

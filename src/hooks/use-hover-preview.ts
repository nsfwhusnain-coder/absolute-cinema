"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type HlsType from "hls.js";
import {
  PREVIEW_MAX_FRAMES,
  captureVideoFrame,
  nearestPreviewFrame,
  previewBucket,
} from "@/lib/playback/hover-preview";

/**
 * Scout engine buffer envelope.
 *
 * The scout exists only to decode ONE frame at the hovered position, so it is
 * configured to hold essentially nothing. This matters: the app previously
 * OOM-killed itself by letting a second consumer retain media buffers, so the
 * scout must never accumulate. Everything here is deliberately tiny.
 */
const SCOUT_HLS_CONFIG = {
  maxBufferLength: 2,
  maxMaxBufferLength: 4,
  maxBufferSize: 4 * 1000 * 1000,
  backBufferLength: 0,
  liveSyncDurationCount: 1,
  enableWorker: false,
  lowLatencyMode: false,
  startFragPrefetch: false,
  testBandwidth: false,
  // Preview frames never justify a 4K download; cap the scout at the cheapest
  // rendition so hovering costs a fraction of a segment.
  capLevelToPlayerSize: false,
  startLevel: 0,
} as const;

/**
 * Builds a smooth hover video frame thumbnail preview.
 * Captures real frames during playback into a ring buffer, and uses an invisible
 * scout video element for fast frame rendering when scrubbing ahead.
 */
export function useHoverPreview(options: {
  videoRef: RefObject<HTMLVideoElement | null>;
  hoverTime: number | null;
  remux?: boolean;
  poster?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
}): { previewSrc: string | null; scoutRef: RefObject<HTMLVideoElement | null> } {
  const { videoRef, hoverTime, sourceUrl, sourceType } = options;
  const framesRef = useRef(new Map<number, string>());
  const orderRef = useRef<number[]>([]);
  const scoutRef = useRef<HTMLVideoElement | null>(null);
  const scoutHlsRef = useRef<HlsType | null>(null);
  const scoutManifestRef = useRef<string | null>(null);
  const scoutDirectRef = useRef<string | null>(null);
  /** The time the viewer is hovering, so a late scout frame for an old position is ignored. */
  const wantedTime = useRef<number | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const remember = (timeS: number, url: string, keepExisting = false) => {
    if (!url) return;
    const key = previewBucket(timeS);
    const frames = framesRef.current;
    // A frame seen during playback beats a scout capture for the same moment.
    if (keepExisting && frames.has(key)) return;
    if (!frames.has(key)) {
      orderRef.current.push(key);
      if (orderRef.current.length > PREVIEW_MAX_FRAMES) {
        const oldest = orderRef.current.shift();
        if (oldest != null) frames.delete(oldest);
      }
    }
    frames.set(key, url);
  };

  // Continuous frame capture during regular playback, seeking, and timeupdate
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let lastSampleTime = 0;
    const sample = () => {
      const now = Date.now();
      if (now - lastSampleTime < 400) return;
      // One capture per 2 s bucket: drawing and JPEG-encoding a frame (a GPU
      // readback on 4K) five times per bucket, and again on every rewatch,
      // was work the main thread did all through playback for nothing.
      if (framesRef.current.has(previewBucket(video.currentTime)) || document.visibilityState !== "visible") return;
      lastSampleTime = now;
      const url = captureVideoFrame(video);
      if (url) {
        remember(video.currentTime, url);
      }
    };

    // Not "seeking": at that moment the picture is still the old position's,
    // and it would be filed under the new time.
    video.addEventListener("timeupdate", sample);
    video.addEventListener("seeked", sample);
    video.addEventListener("playing", sample);
    return () => {
      video.removeEventListener("timeupdate", sample);
      video.removeEventListener("seeked", sample);
      video.removeEventListener("playing", sample);
    };
  }, [videoRef]);

  // Synchronize scout element with source media
  useEffect(() => {
    const scout = scoutRef.current;
    const main = videoRef.current;
    if (!scout) return;

    // Progressive sources can be scrubbed by pointing a plain <video> at the
    // same URL. HLS/DASH cannot: hls.js drives the main element through MSE, so
    // `currentSrc` is a blob: URL that a second element can never open. That is
    // why hovering AHEAD of the watched position used to show nothing at all on
    // exactly the sources that now auto-play (the 4K HLS rungs) — the scout had
    // no usable src and only cached frames already seen during playback.
    const isAdaptive = sourceType === "hls" || sourceType === "dash";
    const candidate =
      sourceUrl && !sourceUrl.startsWith("blob:") && !isAdaptive
        ? sourceUrl
        : main?.currentSrc && !main.currentSrc.startsWith("blob:")
          ? main.currentSrc
          : null;
    // Same-origin files only. A debrid CDN link is cross-origin: frames could
    // never be read from it (CORS), and pointing a second element at it on
    // every player open fetched the raw file a second time for nothing.
    const directSrc = candidate && sameOrigin(candidate) ? candidate : null;

    if (directSrc) {
      // Attached on first hover (below), so a session that never scrubs pays nothing.
      scoutDirectRef.current = directSrc;
      return () => {
        scoutDirectRef.current = null;
        if (scout.getAttribute("src")) {
          scout.removeAttribute("src");
          scout.load();
        }
      };
    }

    // Adaptive source: give the scout its own tiny engine so it can seek
    // anywhere in the timeline. Created lazily on first hover (see hoverTime
    // effect) and torn down whenever the source changes or the player unmounts.
    if (!isAdaptive || !sourceUrl || sourceUrl.startsWith("blob:")) return;
    scoutManifestRef.current = sourceUrl;
    return () => {
      scoutManifestRef.current = null;
      scoutHlsRef.current?.destroy();
      scoutHlsRef.current = null;
    };
  }, [sourceUrl, sourceType, videoRef]);

  // Lazily attach the scout engine — only once the viewer actually hovers, so a
  // session that never scrubs pays nothing.
  useEffect(() => {
    if (hoverTime == null) return;
    const scout = scoutRef.current;
    const direct = scoutDirectRef.current;
    if (scout && direct && !scout.getAttribute("src")) {
      scout.preload = "metadata";
      scout.src = direct;
      return;
    }
    const manifest = scoutManifestRef.current;
    if (!scout || !manifest || scoutHlsRef.current || scout.src) return;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("hls.js");
        const Hls = mod.default;
        if (cancelled || !Hls.isSupported()) return;
        const engine = new Hls(SCOUT_HLS_CONFIG) as HlsType;
        scoutHlsRef.current = engine;
        // Pin the cheapest rendition. A preview thumbnail is ~240px wide, so
        // pulling a 4K segment for it would waste the viewer's bandwidth on
        // every hover.
        engine.on(Hls.Events.MANIFEST_PARSED, () => {
          engine.currentLevel = 0;
        });
        engine.loadSource(manifest);
        engine.attachMedia(scout);
      } catch {
        /* preview is best-effort; never disturb playback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hoverTime]);

  // Handle hover scrub preview
  useEffect(() => {
    if (hoverTime == null) {
      setPreviewSrc(null);
      return;
    }

    // A captured frame near hoverTime, or none: leaving the last frame up
    // showed a picture from somewhere else in the film.
    setPreviewSrc(nearestPreviewFrame(framesRef.current, hoverTime) ?? null);
    wantedTime.current = hoverTime;

    const scout = scoutRef.current;
    if (!scout || !scout.src) return;

    const handle = window.setTimeout(() => {
      try {
        if (scout.readyState >= 1) {
          scout.currentTime = hoverTime;
        }
      } catch {
        /* ignore unseekable hover */
      }
    }, 40);

    return () => window.clearTimeout(handle);
  }, [hoverTime]);

  // Capture frame from scout on seeked and canplay
  useEffect(() => {
    const scout = scoutRef.current;
    if (!scout) return;

    // Only a finished seek near the hovered time is a real frame; "canplay"
    // often fired on a blank, not-yet-decoded picture.
    const onSeeked = () => {
      const wanted = wantedTime.current;
      if (wanted == null || Math.abs(scout.currentTime - wanted) > 3) return;
      const url = captureVideoFrame(scout);
      if (!url) return;
      remember(scout.currentTime, url, true);
      setPreviewSrc(url);
    };

    scout.addEventListener("seeked", onSeeked);
    return () => {
      scout.removeEventListener("seeked", onSeeked);
    };
  }, []);

  return { previewSrc, scoutRef };
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

"use client";

import { useEffect, useRef, type RefObject } from "react";
import { usePlayerState } from "./store";

/** How often the lock screen's progress bar is corrected. */
const POSITION_UPDATE_MS = 5_000;

interface MediaSessionOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  title: string;
  /** "S2 · E4 · Name" for an episode. */
  subtitle?: string;
  artwork?: string | null;
  seekStep: number;
  seek(time: number): void;
  seekBy(delta: number): void;
  onNextEpisode?: () => void;
}

/**
 * Lock screen, Control Centre, media keys and headphone buttons: shows the
 * title and artwork and routes play, pause, skip and "next" to the player.
 */
export function useMediaSession({ videoRef, title, subtitle, artwork, seekStep, seek, seekBy, onNextEpisode }: MediaSessionOptions): void {
  const latest = useRef({ seekStep, seek, seekBy, onNextEpisode });
  latest.current = { seekStep, seek, seekBy, onNextEpisode };

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({
      title,
      artist: subtitle ?? "",
      album: "Absolute Cinema",
      artwork: artwork ? [{ src: artwork, sizes: "1280x720", type: "image/jpeg" }] : [],
    });
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ["play", () => void videoRef.current?.play().catch(() => undefined)],
      ["pause", () => videoRef.current?.pause()],
      ["stop", () => videoRef.current?.pause()],
      ["seekbackward", (d) => latest.current.seekBy(-(d.seekOffset || latest.current.seekStep))],
      ["seekforward", (d) => latest.current.seekBy(d.seekOffset || latest.current.seekStep)],
      ["seekto", (d) => (d.seekTime != null ? latest.current.seek(d.seekTime) : undefined)],
      ["nexttrack", onNextEpisode ? () => latest.current.onNextEpisode?.() : null],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* this browser does not support that action */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* unsupported */
        }
      }
      session.metadata = null;
    };
  }, [videoRef, title, subtitle, artwork, onNextEpisode]);

  // Keep the lock screen's progress bar honest.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    const update = () => {
      const { duration, currentTime, rate } = usePlayerState.getState();
      if (!(duration > 0) || currentTime > duration) return;
      try {
        navigator.mediaSession.setPositionState({ duration, position: Math.max(0, currentTime), playbackRate: rate || 1 });
      } catch {
        /* invalid state mid-switch: corrected on the next update */
      }
    };
    const id = setInterval(update, POSITION_UPDATE_MS);
    const video = videoRef.current;
    video?.addEventListener("seeked", update);
    video?.addEventListener("ratechange", update);
    return () => {
      clearInterval(id);
      video?.removeEventListener("seeked", update);
      video?.removeEventListener("ratechange", update);
    };
  }, [videoRef]);
}

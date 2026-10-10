"use client";

import { useEffect, useRef, useState } from "react";
import type { LoaderPalette } from "@/lib/loader/palette";
import { currentsMode, pickScene, readSceneOverride, type CurrentsMode, type LoaderSceneId } from "@/lib/loader/select";
import { cn } from "@/lib/utils";
import { SCENE_PALETTES } from "./scenes/common";
import { LoaderBackdrop } from "./loader-backdrop";
import type { LoaderHandle } from "./runtime";

/** How long to wait for a title's genres before choosing a scene without them. */
const LOOK_WAIT_MS = 700;
/** Idle time the browser is given before the scene engine is fetched in the background. */
const WARM_IDLE_TIMEOUT_MS = 5000;
const WARM_FALLBACK_DELAY_MS = 2500;
/** The GPU scene fades in over the backdrop, and the loader lingers this long when leaving without one. */
const SCENE_FADE_MS = 900;

/** What the loader needs about a title: its colours and genres. */
export interface LoaderLook {
  palette?: LoaderPalette;
  genres: number[];
}

/** Warm the engine and this title's colours before Play, so the loader appears at once. */
export function preloadLoaderEngine(): void {
  if (loaderEffects() === "static") return;
  // A failed download is not an error worth surfacing: the loader runs without the engine.
  void import("./runtime").catch(() => undefined);
}

/**
 * Fetches the scene engine in the background once the page is idle, so it is
 * already in the browser's cache whichever button starts playback (a hero, a
 * card, Continue Watching, the next episode). A loader whose engine was still
 * downloading when the video started never got to show, which is why it only
 * sometimes appeared. Skipped where scenes do not run or data is precious.
 */
export function warmLoaderWhenIdle(): () => void {
  if (typeof window === "undefined" || loaderEffects() === "static") return () => {};
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  if ("requestIdleCallback" in window) {
    const id = window.requestIdleCallback(preloadLoaderEngine, { timeout: WARM_IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(id);
  }
  const timer = setTimeout(preloadLoaderEngine, WARM_FALLBACK_DELAY_MS);
  return () => clearTimeout(timer);
}

export function loaderEffects(): "static" | "low" | "full" {
  if (typeof window === "undefined") return "static";
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return "static";
  if (document.documentElement.getAttribute("data-tv") === "1") return "static";
  const nav = navigator as Navigator & { deviceMemory?: number };
  const weak = (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
  const phone = window.matchMedia?.("(pointer: coarse)").matches;
  return weak || phone ? "low" : "full";
}

/**
 * The loading screen's picture. A CSS backdrop in the film's colours is there
 * from the first paint; on devices that can afford it a GPU scene suited to
 * the film is drawn over it and fades in once it is really drawing. Whatever
 * goes wrong with the scene (its engine fails to download, the device has no
 * WebGL to spare, the context is lost mid-wait) the backdrop carries on, so
 * the screen is never still. When `leaving` turns true the scene plays its
 * exit, frees the GPU and calls `onGone`.
 */
export function CinematicLoader({ look, leaving, onGone }: { look?: LoaderLook; leaving: boolean; onGone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<LoaderHandle | null>(null);
  // The scene suits the film, so wait briefly for its genres when they are not cached yet.
  const [choice, setChoice] = useState<{ scene: LoaderSceneId; mode: CurrentsMode } | null>(() =>
    look ? { scene: readSceneOverride() ?? pickScene(look.genres), mode: currentsMode(look.genres) } : null
  );
  const [effects] = useState(loaderEffects);
  const [sceneShown, setSceneShown] = useState(false);
  const scene = choice?.scene;
  const mode = choice?.mode;
  const palette = look?.palette ?? SCENE_PALETTES[scene ?? "stars"];
  const paletteRef = useRef(palette);
  const onGoneRef = useRef(onGone);
  useEffect(() => {
    paletteRef.current = palette;
    onGoneRef.current = onGone;
  });

  useEffect(() => {
    if (choice) return;
    const decide = (genres: number[]) =>
      setChoice({ scene: readSceneOverride() ?? pickScene(genres), mode: currentsMode(genres) });
    if (look) {
      decide(look.genres);
      return;
    }
    const timer = setTimeout(() => decide([]), LOOK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [choice, look]);

  useEffect(() => {
    if (effects === "static" || !scene || !mode) return;
    let cancelled = false;
    const start = ({ startLoader }: typeof import("./runtime")) => {
      if (cancelled || !canvasRef.current) return;
      handleRef.current = startLoader(canvasRef.current, {
        scene,
        mode,
        palette: paletteRef.current,
        quality: effects === "low" ? 0.6 : 1,
        onReady: () => !cancelled && setSceneShown(true),
        onLost: () => !cancelled && setSceneShown(false),
      });
    };
    // An engine that cannot be fetched (offline, a deploy replaced its file) leaves the backdrop on its own.
    void import("./runtime")
      .then(start)
      .catch(() => undefined);
    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [effects, scene, mode]);

  useEffect(() => {
    handleRef.current?.setPalette(palette);
  }, [palette]);

  useEffect(() => {
    if (!leaving) return;
    const handle = handleRef.current;
    if (!handle) {
      const timer = setTimeout(() => onGoneRef.current(), SCENE_FADE_MS);
      return () => clearTimeout(timer);
    }
    let cancelled = false;
    void handle.exit().then(() => {
      handle.dispose();
      handleRef.current = null;
      if (!cancelled) onGoneRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [leaving]);

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <LoaderBackdrop palette={palette} paused={sceneShown} />
      {effects !== "static" && (
        <canvas
          ref={canvasRef}
          className={cn("absolute inset-0 h-full w-full transition-opacity ease-out", sceneShown ? "opacity-100" : "opacity-0")}
          style={{ transitionDuration: `${SCENE_FADE_MS}ms` }}
        />
      )}
    </div>
  );
}

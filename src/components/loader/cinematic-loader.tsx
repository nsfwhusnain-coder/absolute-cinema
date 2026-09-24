"use client";

import { useEffect, useRef, useState } from "react";
import type { LoaderPalette } from "@/lib/loader/palette";
import { currentsMode, pickScene, readSceneOverride, type CurrentsMode, type LoaderSceneId } from "@/lib/loader/select";
import { cn } from "@/lib/utils";
import { SCENE_PALETTES } from "./scenes/common";
import type { LoaderHandle } from "./runtime";

/** How long to wait for a title's genres before choosing a scene without them. */
const LOOK_WAIT_MS = 1500;

/** What the loader needs about a title: its colours and genres. */
export interface LoaderLook {
  palette?: LoaderPalette;
  genres: number[];
}

/** Warm the engine and this title's colours before Play, so the loader appears at once. */
export function preloadLoaderEngine(): void {
  void import("./runtime");
}

function reducedEffects(): "static" | "low" | "full" {
  if (typeof window === "undefined") return "static";
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return "static";
  if (document.documentElement.getAttribute("data-tv") === "1") return "static";
  const nav = navigator as Navigator & { deviceMemory?: number };
  const weak = (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
  const phone = window.matchMedia?.("(pointer: coarse)").matches;
  return weak || phone ? "low" : "full";
}

/**
 * A continuously evolving scene behind the loading screen. It picks a scene
 * that suits the film, paints it in the film's colours, and when `leaving`
 * turns true plays its exit, frees the GPU and calls `onGone`.
 */
export function CinematicLoader({ look, leaving, onGone }: { look?: LoaderLook; leaving: boolean; onGone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<LoaderHandle | null>(null);
  // The scene suits the film, so wait briefly for its genres when they are not cached yet.
  const [choice, setChoice] = useState<{ scene: LoaderSceneId; mode: CurrentsMode } | null>(() =>
    look ? { scene: readSceneOverride() ?? pickScene(look.genres), mode: currentsMode(look.genres) } : null
  );
  const [effects] = useState(reducedEffects);
  const [fallback, setFallback] = useState(effects === "static");
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
    void import("./runtime").then(({ startLoader }) => {
      if (cancelled || !canvasRef.current) return;
      const handle = startLoader(canvasRef.current, {
        scene,
        mode,
        palette: paletteRef.current,
        quality: effects === "low" ? 0.6 : 1,
      });
      if (!handle) setFallback(true);
      handleRef.current = handle;
    });
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
      const timer = setTimeout(() => onGoneRef.current(), 600);
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
    <div className="absolute inset-0 overflow-hidden" style={{ background: palette.background }} aria-hidden>
      {fallback ? (
        <div
          className={cn("absolute inset-0 transition-opacity duration-700", leaving && "opacity-0")}
          style={{
            background: `radial-gradient(60% 55% at 70% 40%, ${palette.main}55, transparent 70%), radial-gradient(45% 40% at 25% 70%, ${palette.accent}33, transparent 70%), ${palette.background}`,
          }}
        />
      ) : (
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      )}
    </div>
  );
}

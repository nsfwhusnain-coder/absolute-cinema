"use client";

import { useLayoutEffect, useRef } from "react";
import type { LoaderPalette } from "@/lib/loader/palette";
import { cn } from "@/lib/utils";

/**
 * The loading screen's base layer: soft fields of the title's colours that
 * drift and breathe. It is plain CSS moving only transform and opacity, so it
 * is on screen from the first paint and runs on every device, whatever
 * becomes of the GPU scene drawn over it. With reduced motion the fields stay
 * put and only breathe.
 */

/** Shown until a title's own colours are known. */
export const NEUTRAL_PALETTE: LoaderPalette = { background: "#06070c", main: "#3d4a7a", accent: "#6a4a78", highlight: "#cdd5f5" };

/** A backdrop mounted again within this long continues the previous one (the page swaps the element under it). */
const CONTINUE_WITHIN_MS = 1500;

let epoch = 0;
let lastSeen = -Infinity;

/** When the backdrop on screen now first appeared, so a remount picks up mid-drift instead of starting over. */
function backdropEpoch(now: number): number {
  if (now - lastSeen > CONTINUE_WITHIN_MS) epoch = now;
  lastSeen = now;
  return epoch;
}

interface Glow {
  role: keyof Omit<LoaderPalette, "background">;
  className: string;
}

const GLOWS: readonly Glow[] = [
  { role: "main", className: "loader-glow-a" },
  { role: "accent", className: "loader-glow-b" },
  { role: "highlight", className: "loader-glow-c" },
];

export function LoaderBackdrop({ palette, paused = false, className }: { palette: LoaderPalette; paused?: boolean; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  // Negative delays place every animation where it would be had it run since the epoch.
  useLayoutEffect(() => {
    const now = performance.now();
    root.current?.style.setProperty("--loader-elapsed", `${(backdropEpoch(now) - now) / 1000}s`);
    return () => {
      lastSeen = performance.now();
    };
  }, []);
  return (
    <div
      ref={root}
      className={cn("loader-backdrop absolute inset-0 overflow-hidden", paused && "loader-backdrop-paused", className)}
      style={{ backgroundColor: palette.background }}
      aria-hidden
    >
      {GLOWS.map((glow) => (
        <div key={glow.role} className={cn("loader-glow", glow.className)} style={{ color: palette[glow.role] }} />
      ))}
      <div className="loader-vignette absolute inset-0" />
    </div>
  );
}

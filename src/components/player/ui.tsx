"use client";

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Check, ChevronLeft, Loader2, RotateCcw, Volume1, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function IconButton({
  label,
  onClick,
  children,
  active = false,
  size = "md",
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  size?: "md" | "lg" | "xl";
  className?: string;
}) {
  const dims = size === "xl" ? "h-16 w-16" : size === "lg" ? "h-12 w-12" : "h-10 w-10";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "glass-icon shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        dims,
        active && "bg-[var(--mat-fill-active)]",
        className
      )}
    >
      {children}
    </button>
  );
}

/** Scrub bar: hover shows time (and a frame when one is available); drag or click to seek. */
export function SeekBar({
  duration,
  currentTime,
  bufferedEnd,
  onSeek,
  onHover,
  previewSrc,
}: {
  duration: number;
  currentTime: number;
  bufferedEnd: number;
  onSeek: (time: number) => void;
  /** Reports the hovered time (null when the pointer leaves) so a preview frame can be fetched. */
  onHover?: (time: number | null) => void;
  previewSrc?: string | null;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const safeDuration = duration > 0 ? duration : 1;

  const timeAt = useCallback(
    (clientX: number) => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return { x: 0, time: 0 };
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return { x: ratio * rect.width, time: ratio * safeDuration };
    },
    [safeDuration]
  );

  const shown = scrubTime ?? currentTime;
  const playedPct = Math.min(100, (shown / safeDuration) * 100);
  const bufferedPct = Math.min(100, (bufferedEnd / safeDuration) * 100);
  const frame = hover ? previewSrc ?? null : null;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setScrubTime(timeAt(e.clientX).time);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const at = timeAt(e.clientX);
    setHover(at);
    onHover?.(at.time);
    if (scrubTime !== null) setScrubTime(at.time);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (scrubTime === null) return;
    onSeek(timeAt(e.clientX).time);
    setScrubTime(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      onSeek(currentTime + (e.key === "ArrowRight" ? 5 : -5));
    }
  };

  return (
    <div
      ref={barRef}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
      className="group relative flex h-6 w-full cursor-pointer touch-none items-center focus-visible:outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (scrubTime !== null) return;
        setHover(null);
        onHover?.(null);
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] duration-150 group-hover:h-1.5 group-focus-visible:h-1.5">
        <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${bufferedPct}%` }} />
        <div className="absolute inset-y-0 left-0 bg-white" style={{ width: `${playedPct}%` }} />
      </div>
      <div
        className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        style={{ left: `${playedPct}%`, ...(scrubTime !== null ? { opacity: 1 } : {}) }}
      />
      {hover && (
        <div
          className="pointer-events-none absolute bottom-7 flex -translate-x-1/2 flex-col items-center gap-1.5"
          style={{ left: Math.min(Math.max(hover.x, 80), (barRef.current?.clientWidth ?? 160) - 80) }}
        >
          {frame && (
            <img src={frame} alt="" className="glass-clear h-[90px] w-40 rounded-xl object-cover" />
          )}
          <span className="glass-clear rounded-full px-2.5 py-1 text-xs font-medium tabular-nums text-white">
            {formatTime(hover.time)}
          </span>
        </div>
      )}
    </div>
  );
}

export function VolumeControl({
  volume,
  muted,
  onVolume,
  onToggleMute,
}: {
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
}) {
  const level = muted ? 0 : volume;
  const Icon = level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;
  return (
    <div className="group/vol flex items-center">
      <IconButton label={muted ? "Unmute" : "Mute"} onClick={onToggleMute}>
        <Icon className="h-5 w-5" />
      </IconButton>
      <input
        type="range"
        aria-label="Volume"
        min={0}
        max={1}
        step={0.05}
        value={level}
        onChange={(e) => onVolume(Number(e.target.value))}
        onClick={(e) => e.stopPropagation()}
        className="player-range ml-1 hidden w-0 opacity-0 transition-all duration-200 group-hover/vol:w-24 group-hover/vol:opacity-100 focus:w-24 focus:opacity-100 sm:block"
        style={{ "--fill": `${level * 100}%` } as React.CSSProperties}
      />
    </div>
  );
}

/** Floating glass menu used for subtitles/audio, settings and servers. */
export function PlayerMenu({
  title,
  onBack,
  children,
  className,
}: {
  title: string;
  onBack?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="dialog"
      aria-label={title}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "glass-clear glass-dense flex max-h-[min(70vh,34rem)] w-[min(92vw,22rem)] flex-col overflow-hidden rounded-3xl text-white",
        className
      )}
    >
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="glass-icon -ml-1 h-8 w-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        <h2 className="text-[0.95rem] font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">{children}</div>
    </div>
  );
}

export function MenuSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="py-1">
      {label && <div className="px-3 pb-1 pt-2 text-[0.7rem] font-semibold uppercase tracking-wider text-white/50">{label}</div>}
      {children}
    </div>
  );
}

/** Current value shown at the right of a menu row. */
export function MenuValue({ children }: { children: ReactNode }) {
  return <span className="max-w-[9rem] truncate text-xs text-white/60">{children}</span>;
}

export function MenuItem({
  label,
  detail,
  selected,
  trailing,
  onClick,
  disabled = false,
}: {
  label: ReactNode;
  detail?: ReactNode;
  /** Set for choices (a check marks the current one); leave out for navigation rows. */
  selected?: boolean;
  trailing?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const choice = selected !== undefined;
  return (
    <button
      type="button"
      role={choice ? "menuitemradio" : "menuitem"}
      aria-checked={choice ? selected : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm transition-colors",
        "hover:bg-[var(--mat-fill-hover)] focus-visible:bg-[var(--mat-fill-hover)] focus-visible:outline-none",
        selected && "bg-[var(--mat-fill-active)]",
        disabled && "cursor-not-allowed opacity-40"
      )}
    >
      {choice && <span className="flex h-4 w-4 shrink-0 items-center justify-center">{selected && <Check className="h-4 w-4" />}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail && <span className="block truncate text-xs text-white/55">{detail}</span>}
      </span>
      {trailing}
    </button>
  );
}

/** Before the first frame: artwork, title and what the player is doing. */
/**
 * The loading screen: the scene and the title, nothing else. Details about
 * servers and buffering stay out of the way; the hairline under the title
 * fills as the first seconds buffer.
 */
export function LoadingOverlay({
  scene,
  leaving = false,
  title,
  subtitle,
  progress,
}: {
  /** The live scene behind the title. */
  scene: ReactNode;
  /** Fading out over the first frames of video. */
  leaving?: boolean;
  title: string;
  subtitle?: string;
  /** 0-1 while buffering the first seconds. */
  progress?: number;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-10 overflow-hidden bg-black transition-opacity duration-700",
        leaving && "pointer-events-none opacity-0"
      )}
    >
      {scene}
      <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/55 to-transparent" />
      <div className="loader-title absolute inset-x-0 bottom-[9vh] flex flex-col items-center gap-3 px-6 text-center">
        <h1 className="font-display text-xl font-extralight uppercase tracking-[0.42em] text-white/95 [text-shadow:0_0_28px_rgba(255,255,255,0.35)] sm:text-3xl sm:tracking-[0.55em]">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[10px] font-light uppercase tracking-[0.45em] text-white/55 sm:text-xs">{subtitle}</p>
        )}
        <div className="mt-2 h-px w-40 overflow-hidden bg-white/10 sm:w-56" aria-hidden>
          <div
            className={cn("h-full bg-white/70 transition-[width] duration-500", progress === undefined && "loader-hairline w-1/3")}
            style={progress === undefined ? undefined : { width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/** Mid-playback buffering indicator. */
export function BufferingSpinner() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="glass-clear flex h-16 w-16 items-center justify-center rounded-full">
        <Loader2 className="h-7 w-7 animate-spin text-white" />
      </div>
    </div>
  );
}

export function FailureCard({
  message,
  onRetry,
  onServers,
  onBack,
}: {
  message: string;
  onRetry: () => void;
  onServers?: () => void;
  onBack: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6" onClick={(e) => e.stopPropagation()}>
      <div role="alertdialog" aria-label="Playback problem" className="glass-clear glass-dense w-full max-w-sm rounded-3xl p-6 text-center text-white">
        <h2 className="font-display text-lg font-semibold">Can&apos;t play this right now</h2>
        <p className="mt-2 text-sm leading-relaxed text-white/70">{message}</p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white font-semibold text-black transition hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <RotateCcw className="h-4 w-4" /> Try again
          </button>
          {onServers && (
            <button
              type="button"
              onClick={onServers}
              className="h-11 rounded-full bg-[var(--mat-fill-hover)] font-medium transition hover:bg-[var(--mat-fill-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Choose a server
            </button>
          )}
          <button type="button" onClick={onBack} className="h-10 rounded-full text-sm text-white/70 hover:text-white">
            Go back
          </button>
        </div>
      </div>
    </div>
  );
}

export function Captions({
  text,
  raised,
  size = "medium",
  background = "box",
}: {
  text: string;
  raised: boolean;
  size?: "small" | "medium" | "large";
  background?: "box" | "shadow";
}) {
  if (!text) return null;
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 flex justify-center px-6 transition-[bottom] duration-300",
        raised ? "bottom-36" : "bottom-12"
      )}
    >
      <p
        data-size={size}
        data-background={background}
        className="player-caption max-w-[80%] whitespace-pre-line rounded-lg bg-black/70 px-3 py-1 text-center font-medium leading-snug text-white"
      >
        {text}
      </p>
    </div>
  );
}

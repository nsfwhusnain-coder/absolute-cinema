"use client";

import { useEffect, useState } from "react";
import { Moon, Play, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SLEEP_EPISODE_CHOICES,
  SLEEP_EXTEND_MINUTES,
  SLEEP_MINUTE_CHOICES,
  SLEEP_WARNING_MS,
  episodesChoiceLabel,
  formatSleepLeft,
  minutesChoiceLabel,
  msUntilSleep,
  sameSleepSetting,
  sleepTimerActive,
  stopsAtThisEnd,
  type SleepSetting,
} from "./sleep-timer";
import { usePlayerState } from "./store";
import { useSleepTimer } from "./use-sleep-timer";
import { MenuItem, MenuSection, PlayerMenu, formatTime } from "./ui";

/** The sleep screen fades almost to black after this long without a touch. */
const SLEEP_SCREEN_DIM_MS = 8_000;

type MediaType = "movie" | "tv";

/**
 * Real time until the sleep timer pauses playback (Infinity when not known).
 * Follows the playhead only when the timer stops at the end of this episode,
 * so a minutes timer does not re-render on every time update.
 */
export function useSleepLeft(): number {
  const timer = useSleepTimer((s) => s.timer);
  const followsPlayhead = stopsAtThisEnd(timer);
  const currentTime = usePlayerState((s) => (followsPlayhead ? s.currentTime : 0));
  const duration = usePlayerState((s) => (followsPlayhead ? s.duration : 0));
  const rate = usePlayerState((s) => (followsPlayhead ? s.rate : 1));
  return msUntilSleep(timer, { currentTime, duration, rate });
}

/** Short state for the chip and the settings row: "23 min", "0:42", "End of episode". */
function useSleepSummary(mediaType: MediaType): string | null {
  const timer = useSleepTimer((s) => s.timer);
  const left = useSleepLeft();
  if (!sleepTimerActive(timer)) return null;
  if (Number.isFinite(left)) return formatSleepLeft(left);
  if (mediaType === "movie") return "End of film";
  return timer.episodesLeft <= 1 ? "End of episode" : `${timer.episodesLeft} episodes`;
}

/** Value at the right of the "Sleep timer" row in the settings menu. */
export function SleepMenuValue({ mediaType }: { mediaType: MediaType }) {
  const summary = useSleepSummary(mediaType);
  return <span className="max-w-[9rem] truncate text-xs tabular-nums text-white/60">{summary ?? "Off"}</span>;
}

/** The sleep timer menu: durations, "end of this episode", and the time left. */
export function SleepMenu({
  mediaType,
  hasNextEpisode,
  onBack,
  onChosen,
}: {
  mediaType: MediaType;
  hasNextEpisode: boolean;
  onBack?: () => void;
  /** Called after a choice, with a line to confirm it. */
  onChosen(confirmation: string): void;
}) {
  const timer = useSleepTimer((s) => s.timer);
  const left = useSleepLeft();
  const active = sleepTimerActive(timer);
  const pick = (setting: SleepSetting, confirmation: string) => {
    if (setting.kind === "off") useSleepTimer.getState().cancel();
    else useSleepTimer.getState().choose(setting);
    onChosen(confirmation);
  };
  const isChosen = (setting: SleepSetting) => sameSleepSetting(timer.setting, setting);
  const episodeChoices = mediaType === "movie" ? [1] : SLEEP_EPISODE_CHOICES.filter((n) => n === 1 || hasNextEpisode);

  return (
    <PlayerMenu title="Sleep timer" onBack={onBack}>
      {active && (
        <div className="mx-1 mb-1 flex items-center gap-3 rounded-2xl bg-[var(--mat-fill-hover)] px-3 py-2.5">
          <Moon className="h-4 w-4 shrink-0 text-white/80" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold tabular-nums">
              {Number.isFinite(left) ? `Pausing in ${formatSleepLeft(left)}` : episodesChoiceLabel(timer.episodesLeft, mediaType)}
            </div>
            <div className="truncate text-xs text-white/55">
              {timer.setting.kind === "minutes" ? "Counts only while playing" : "Then playback pauses"}
            </div>
          </div>
          {timer.setting.kind === "minutes" && (
            <button
              type="button"
              onClick={() => useSleepTimer.getState().extend()}
              className="h-8 shrink-0 rounded-full bg-white/15 px-3 text-xs font-semibold transition hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              +{SLEEP_EXTEND_MINUTES} min
            </button>
          )}
        </div>
      )}
      <MenuItem label="Off" selected={!active} onClick={() => pick({ kind: "off" }, "Sleep timer off")} />
      {SLEEP_MINUTE_CHOICES.map((minutes) => {
        const setting: SleepSetting = { kind: "minutes", minutes };
        const chosen = isChosen(setting);
        return (
          <MenuItem
            key={minutes}
            label={minutesChoiceLabel(minutes)}
            detail={chosen ? `${formatSleepLeft(timer.remainingMs)} left · choose again to restart` : undefined}
            selected={chosen}
            onClick={() => pick(setting, `Sleep timer: pausing in ${minutesChoiceLabel(minutes)}`)}
          />
        );
      })}
      <MenuSection label="When it ends">
        {episodeChoices.map((count) => {
          const setting: SleepSetting = { kind: "episodes", count };
          const label = episodesChoiceLabel(count, mediaType);
          return (
            <MenuItem
              key={count}
              label={label}
              selected={isChosen(setting)}
              onClick={() =>
                pick(
                  setting,
                  count > 1
                    ? `Sleep timer: stopping after ${count} episodes`
                    : `Sleep timer: stopping at the end of ${mediaType === "movie" ? "the film" : "this episode"}`
                )
              }
            />
          );
        })}
      </MenuSection>
      <p className="px-3 pb-2 pt-1 text-xs leading-relaxed text-white/45">
        Counts only while something is playing. The sound fades out over the last 30 seconds.
      </p>
    </PlayerMenu>
  );
}

/** Moon chip in the top bar while a timer runs; opens the sleep menu. */
export function SleepChip({ mediaType, className, onOpen }: { mediaType: MediaType; className?: string; onOpen(): void }) {
  const summary = useSleepSummary(mediaType);
  if (!summary) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Sleep timer: ${summary}`}
      className={cn(
        "glass-clear flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold tabular-nums text-white transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        className
      )}
    >
      <Moon className="h-3.5 w-3.5" /> {summary}
    </button>
  );
}

/**
 * The last minute before the pause: a quiet card with the countdown and a
 * way to keep watching, so someone still awake is not cut off mid-scene.
 */
export function SleepWarning({
  mediaType,
  hasNextEpisode,
  raised,
}: {
  mediaType: MediaType;
  hasNextEpisode: boolean;
  /** Controls are showing: sit above them. */
  raised: boolean;
}) {
  const timer = useSleepTimer((s) => s.timer);
  const asleep = useSleepTimer((s) => s.asleep);
  const left = useSleepLeft();
  if (asleep || !sleepTimerActive(timer) || !(left <= SLEEP_WARNING_MS)) return null;
  const canExtend = timer.setting.kind === "minutes" || (mediaType === "tv" && hasNextEpisode);
  return (
    <div
      role="status"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        // Phones: under the top bar, clear of the subtitles; larger screens: bottom left.
        "glass-clear glass-dense absolute left-3 top-20 z-40 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-full py-1.5 pl-4 pr-1.5 text-sm text-white transition-[bottom] duration-300 sm:left-8 sm:top-auto",
        raised ? "sm:bottom-32" : "sm:bottom-10"
      )}
    >
      <Moon className="h-4 w-4 shrink-0 text-white/80" />
      <span className="whitespace-nowrap tabular-nums">
        {stopsAtThisEnd(timer) ? "Stopping in" : "Pausing in"} {formatSleepLeft(left)}
      </span>
      {canExtend && (
        <button
          type="button"
          onClick={() => useSleepTimer.getState().extend()}
          className="h-8 whitespace-nowrap rounded-full bg-white px-3 text-xs font-semibold text-black transition hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          {timer.setting.kind === "minutes" ? `+${SLEEP_EXTEND_MINUTES} min` : "One more episode"}
        </button>
      )}
      <button
        type="button"
        onClick={() => useSleepTimer.getState().cancel()}
        className="h-8 whitespace-nowrap rounded-full px-3 text-xs font-medium text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        Turn off
      </button>
    </div>
  );
}

/**
 * After the timer ran out: a dark screen that dims itself further, so a
 * sleeping room is not lit by the TV, with one tap to carry on.
 */
export function SleepScreen({
  title,
  episodeLabel,
  onResume,
  onNextEpisode,
  onBack,
}: {
  title: string;
  episodeLabel?: string;
  onResume(): void;
  onNextEpisode?: () => void;
  onBack(): void;
}) {
  const asleep = useSleepTimer((s) => s.asleep);
  const at = useSleepTimer((s) => s.asleepAt);
  const [dim, setDim] = useState(false);

  useEffect(() => {
    if (!asleep) return;
    let timer = setTimeout(() => setDim(true), SLEEP_SCREEN_DIM_MS);
    const brighten = () => {
      setDim(false);
      clearTimeout(timer);
      timer = setTimeout(() => setDim(true), SLEEP_SCREEN_DIM_MS);
    };
    window.addEventListener("pointermove", brighten);
    window.addEventListener("pointerdown", brighten);
    window.addEventListener("keydown", brighten);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", brighten);
      window.removeEventListener("pointerdown", brighten);
      window.removeEventListener("keydown", brighten);
    };
  }, [asleep]);

  if (!asleep) return null;
  const ended = asleep === "ended";
  const primary = ended ? onNextEpisode : onResume;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sleep timer"
      onClick={(e) => e.stopPropagation()}
      className="absolute inset-0 z-50 flex items-center justify-center bg-black p-6 text-white"
    >
      <div className={cn("flex max-w-sm flex-col items-center text-center transition-opacity duration-[1500ms]", dim ? "opacity-[0.12]" : "opacity-100")}>
        <div className="sleep-moon mb-6 flex h-20 w-20 items-center justify-center rounded-full">
          <Moon className="h-8 w-8 text-white/90" />
        </div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/45">Sleep timer</p>
        <h2 className="mt-2 font-display text-2xl font-semibold">
          {ended ? (episodeLabel ? "End of the episode" : "End of the film") : `Paused at ${formatTime(at)}`}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          {ended
            ? onNextEpisode
              ? "The next episode is ready whenever you are."
              : "Sleep well."
            : "Your place is saved. Pick up right here whenever you're ready."}
        </p>
        <p className="mt-1 max-w-full truncate text-xs text-white/35">{episodeLabel ? `${title} · ${episodeLabel}` : title}</p>
        <div className="mt-7 flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {primary && (
            <button
              type="button"
              autoFocus
              onClick={primary}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-6 font-semibold text-black transition hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              {ended ? <SkipForward className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
              {ended ? "Play next episode" : "Resume"}
            </button>
          )}
          <button
            type="button"
            onClick={onBack}
            className="h-11 rounded-full bg-white/10 px-6 font-medium transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            Leave player
          </button>
        </div>
      </div>
    </div>
  );
}

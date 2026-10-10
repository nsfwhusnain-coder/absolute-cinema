"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Airplay,
  ListVideo,
  Maximize,
  Minimize,
  Moon,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Server,
  Settings,
  SkipForward,
  Sparkles,
} from "lucide-react";
import type { PlaybackSource } from "@/lib/playback/types";
import type { PlaybackQualityPreference, SubtitlePreference } from "@/lib/profile-preferences";
import { sourceDelivery, sourceMaxHeight } from "@/lib/playback/source-quality";
import { useHoverPreview } from "@/hooks/use-hover-preview";
import { hdrSdrDisplayMap } from "@/lib/playback/hdr-sdr-map";
import { buildDownloadOptions, downloadDetailLine, downloadFilename, downloadSizeLabel } from "@/lib/playback/download-options";
import { cn } from "@/lib/utils";
import { usePlayerState, PLAYBACK_SPEEDS, VIDEO_FITS, type PlayerState } from "./store";
import { useShallow } from "zustand/react/shallow";
import { languageName } from "@/lib/language-name";
import { titleLanguageKey } from "@/lib/title-language";
import { useQuery } from "@tanstack/react-query";
import { PREFERENCES_QUERY_KEY, fetchPreferences } from "@/lib/preferences-client";
import type { SkipSegment } from "@/lib/playback/skip-times";
import { CinematicLoader, type LoaderLook } from "@/components/loader/cinematic-loader";
import { usePlayerController } from "./use-player-controller";
import { useSubtitles, type ExternalSubtitle } from "./use-subtitles";
import { useSubtitleGuard } from "./use-subtitle-guard";
import { subtitlesRequired } from "./subtitle-policy";
import { normalizeHeight, playableHere, qualityChoices, qualityLabel, type AudioChoice, type TitleContext } from "./playable";
import {
  BufferingSpinner,
  Captions,
  FailureCard,
  IconButton,
  LoadingOverlay,
  MenuItem,
  MenuValue,
  MenuSection,
  PlayerMenu,
  SeekBar,
  VolumeControl,
  formatTime,
} from "./ui";
import { EpisodesMenu, type SeasonOption } from "./episodes-menu";
import { PLAYER_SHORTCUTS } from "@/lib/shortcuts";
import { useMediaSession } from "./use-media-session";
import { useSleepTimer, useSleepTimerClock } from "./use-sleep-timer";
import { SleepChip, SleepMenu, SleepMenuValue, SleepScreen, SleepWarning } from "./sleep-timer-ui";

const CONTROLS_IDLE_MS = 3200;
const NOTICE_MS = 5000;
/** Skip step before the profile's own choice (Settings → Playback) has loaded. */
const DEFAULT_SEEK_STEP_S = 10;
/** "Resumed at 42:10 · Start over" stays this long after playback picks up where it left off. */
const START_OVER_MS = 9000;
/** Resume points closer to the start than this just play on; no offer to start over. */
const START_OVER_MIN_S = 60;
/** How long the "Intro skipped · Watch it" chip stays after an automatic skip. */
const AUTO_SKIP_UNDO_MS = 7000;
const VOLUME_STEP = 0.1;
/** Two taps closer together than this are a double tap. */
const DOUBLE_TAP_MS = 300;
/** Double taps in the outer 35% of the width seek; the middle only toggles controls. */
const SEEK_ZONE = 0.35;
/** The skip button disappears this close to the segment's end. */
const SKIP_TAIL_S = 2;
/** Skip times are trusted when the file is within this many seconds of the measured episode. */
const SKIP_LENGTH_TOLERANCE_S = 20;
/** Seconds buffered that the start-up progress bar counts as full. */
const START_BUFFER_S = 4;

/** "sleep" is the sleep menu opened from its own button; "sleep-settings" the same menu reached through Settings. */
type Panel =
  | "none"
  | "settings"
  | "subtitles"
  | "audio"
  | "picture"
  | "quality"
  | "speed"
  | "servers"
  | "download"
  | "episodes"
  | "sleep"
  | "sleep-settings"
  | "shortcuts";

export interface PlayerProps {
  sources: PlaybackSource[];
  discovering: boolean;
  remuxAvailable: boolean;
  title: TitleContext;
  displayTitle: string;
  episodeLabel?: string;
  /** Synopsis shown while the stream starts. */
  overview?: string;
  /** Colours and genres for the loading scene. */
  loaderLook?: LoaderLook;
  /** Intro/recap/credits times (anime), offered as a skip button. */
  skipSegments?: SkipSegment[];
  backdrop?: string | null;
  logo?: string | null;
  initialTime: number;
  fallbackDurationS: number;
  audio: AudioChoice;
  /** The profile's quality choice (Best, 4K, 1080p…). */
  quality?: PlaybackQualityPreference;
  subtitlePreference: SubtitlePreference;
  externalSubtitles: ExternalSubtitle[];
  onProgress(current: number, duration: number): void;
  onEnded(): void;
  onBack(): void;
  onRefreshSources(): void;
  tv?: {
    seasons: SeasonOption[];
    season: number;
    episode: number;
    onSelectEpisode(season: number, episode: number): void;
    onNextEpisode?: () => void;
  };
}

function useAirPlayAvailable(videoRef: React.RefObject<HTMLVideoElement | null>): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }) | null;
    if (!video || !("WebKitPlaybackTargetAvailabilityEvent" in window)) return;
    const onAvailability = (e: Event) => setAvailable((e as Event & { availability: string }).availability === "available");
    video.addEventListener("webkitplaybacktargetavailabilitychanged", onAvailability);
    return () => video.removeEventListener("webkitplaybacktargetavailabilitychanged", onAvailability);
  }, [videoRef]);
  return available;
}

export function Player(props: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointer = useRef<string>("mouse");
  const lastTapAt = useRef(0);
  // Everything but the 4-per-second fields (playhead, buffer, caption text):
  // those are read by the small components that draw them, so the whole
  // player no longer re-renders on every time update.
  const state = usePlayerState(useShallow(coarseState));
  const hasPlayhead = usePlayerState((s) => s.currentTime > 0);

  const actions = usePlayerController({
    videoRef,
    sources: props.sources,
    discovering: props.discovering,
    remuxAvailable: props.remuxAvailable,
    title: props.title,
    initialTime: props.initialTime,
    audio: props.audio,
    quality: props.quality,
    fallbackDurationS: props.fallbackDurationS,
    onProgress: props.onProgress,
    onEnded: props.onEnded,
    onRefreshSources: props.onRefreshSources,
  });
  const { data: profilePrefs } = useQuery({ queryKey: PREFERENCES_QUERY_KEY, queryFn: fetchPreferences, staleTime: 5 * 60_000 });
  const seekStep = profilePrefs?.seekStep ?? DEFAULT_SEEK_STEP_S;
  /** Runs whatever the skip button would do right now (the S key). Set during render below. */
  const skipNowRef = useRef<(() => void) | null>(null);
  const audioLanguage =
    state.remuxAudio?.tracks.find((t) => t.index === state.remuxAudio?.active)?.language ??
    state.audioTracks.find((t) => t.id === state.activeAudio)?.lang ??
    null;
  const subsRequired = subtitlesRequired(props.title.originalLanguage, audioLanguage);
  const { selectSubtitle } = useSubtitles(
    videoRef,
    props.externalSubtitles,
    props.subtitlePreference,
    titleLanguageKey(props.title.mediaType, props.title.tmdbId),
    subsRequired
  );
  useSubtitleGuard({
    required: subsRequired,
    sources: props.sources,
    remuxAvailable: props.remuxAvailable,
    selectSource: actions.selectSource,
  });

  const activeSource = props.sources.find((s) => s.id === state.activeSourceId) ?? null;
  const isRemux = activeSource ? sourceDelivery(activeSource) === "remux" : false;
  const { previewSrc, scoutRef } = useHoverPreview({
    videoRef,
    hoverTime,
    remux: isRemux || (activeSource?.ladder?.length ?? 0) < 2,
    sourceUrl: activeSource?.url ?? null,
    sourceType: activeSource?.type ?? null,
  });
  const airplay = useAirPlayAvailable(videoRef);
  useSleepTimerClock(videoRef);
  useMediaSession({
    videoRef,
    title: props.displayTitle,
    subtitle: props.episodeLabel,
    artwork: props.backdrop,
    seekStep,
    seek: actions.seek,
    seekBy: actions.seekBy,
    onNextEpisode: props.tv?.onNextEpisode,
  });
  const sleepActive = useSleepTimer((s) => s.timer.setting.kind !== "off");
  const mediaType = props.title.mediaType;
  const hasNextEpisode = Boolean(props.tv?.onNextEpisode);
  // HDR on an SDR display looks crushed and dim; lift shadows unless the screen is HDR.
  const videoFilter = useMemo(() => {
    if (state.dynamicRange === "SDR" || typeof window === "undefined") return undefined;
    if (window.matchMedia?.("(dynamic-range: high)").matches) return undefined;
    const filter = hdrSdrDisplayMap({ dynamicRange: state.dynamicRange }).cssFilter;
    return filter === "none" ? undefined : filter;
  }, [state.dynamicRange]);

  // Controls auto-hide while playing.
  const poke = useCallback(() => {
    usePlayerState.getState().set({ controlsVisible: true });
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      const s = usePlayerState.getState();
      if (s.playing && !s.buffering) s.set({ controlsVisible: false });
    }, CONTROLS_IDLE_MS);
  }, []);
  useEffect(() => {
    if (!state.playing || panel !== "none") usePlayerState.getState().set({ controlsVisible: true });
    else poke();
  }, [state.playing, panel, poke]);
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);


  // Transient notices (e.g. an automatic server change) fade out.
  useEffect(() => {
    if (!state.notice) return;
    const id = state.notice.id;
    const timer = setTimeout(() => {
      if (usePlayerState.getState().notice?.id === id) usePlayerState.getState().set({ notice: null });
    }, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [state.notice]);

  // The whole page goes full screen (not the player element), so moving to the
  // next episode, which remounts the player, stays full screen.
  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (el?.requestFullscreen) {
      void el.requestFullscreen().catch(() => video?.webkitEnterFullscreen?.());
    } else {
      video?.webkitEnterFullscreen?.();
    }
  }, []);
  useEffect(() => {
    const onChange = () => usePlayerState.getState().set({ fullscreen: Boolean(document.fullscreenElement) });
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const togglePip = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else void video.requestPictureInPicture?.().catch(() => {});
  }, []);

  // Keyboard shortcuts (the player owns the keyboard while mounted).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Tabbing through the controls shows them: focus must never sit on an invisible button.
      if (e.key === "Tab") {
        poke();
        return;
      }
      // Space and Enter on a focused button, link or menu item press it, as everywhere else.
      if ((e.key === " " || e.key === "Enter") && target?.closest('button, a[href], [role^="menuitem"], [role="tab"], [role="radio"], [role="switch"]')) return;
      const s = usePlayerState.getState();
      const key = e.key.toLowerCase();
      // On the sleep screen, play carries on: resume, or the next episode when the timer stopped at an end.
      const asleep = useSleepTimer.getState().asleep;
      if (asleep && (key === " " || key === "k")) {
        e.preventDefault();
        if (asleep === "timer") actions.togglePlay();
        else props.tv?.onNextEpisode?.();
        return;
      }
      let handled = true;
      if (key === " " || key === "k") actions.togglePlay();
      else if (key === "arrowleft" || key === "j") actions.seekBy(-seekStep);
      else if (key === "arrowright" || key === "l") actions.seekBy(seekStep);
      else if (key === "arrowup") actions.setVolume(s.volume + VOLUME_STEP);
      else if (key === "arrowdown") actions.setVolume(s.volume - VOLUME_STEP);
      else if (key === "m") actions.toggleMute();
      else if (key === "f") toggleFullscreen();
      else if (key === "c") selectSubtitle(s.activeSubtitle ? null : (s.subtitles[0]?.id ?? null));
      else if (key === "n" && props.tv?.onNextEpisode) props.tv.onNextEpisode();
      else if (key === "z") setPanel(panel === "sleep" || panel === "sleep-settings" ? "none" : "sleep");
      else if (key === "s" && skipNowRef.current) skipNowRef.current();
      else if (key === "p") togglePip();
      else if (e.key === ">" || e.key === "<") {
        const at = PLAYBACK_SPEEDS.indexOf(s.rate as (typeof PLAYBACK_SPEEDS)[number]);
        const next = PLAYBACK_SPEEDS[Math.min(PLAYBACK_SPEEDS.length - 1, Math.max(0, (at < 0 ? 2 : at) + (e.key === ">" ? 1 : -1)))]!;
        actions.setRate(next);
        usePlayerState.getState().showNotice(next === 1 ? "Normal speed" : `Speed ${next}×`);
      } else if (e.key === "?") setPanel(panel === "shortcuts" ? "none" : "shortcuts");
      else if (/^[0-9]$/.test(key) && s.duration > 0) actions.seek((Number(key) / 10) * s.duration);
      else if (key === "escape") {
        if (panel !== "none") setPanel("none");
        else if (!document.fullscreenElement) props.onBack();
        else handled = false;
      } else handled = false;
      if (handled) {
        e.preventDefault();
        poke();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, toggleFullscreen, togglePip, selectSubtitle, panel, props.tv, props.onBack, poke, seekStep]);

  const playable = useMemo(() => playableHere(props.sources, props.remuxAvailable), [props.sources, props.remuxAvailable]);
  const heights = useMemo(() => qualityChoices(props.sources, props.remuxAvailable), [props.sources, props.remuxAvailable]);
  const nowHeight = state.decodedHeight ? normalizeHeight(state.decodedHeight) : 0;
  // Duration only feeds size estimates, so whole minutes are precise enough and
  // avoid rebuilding the list on every timeupdate.
  const durationMinutes = Math.round(state.duration / 60);
  const downloads = useMemo(
    () => buildDownloadOptions(props.sources, durationMinutes * 60).filter((o) => o.downloadable),
    [props.sources, durationMinutes]
  );
  const downloadHref = (option: (typeof downloads)[number]) => {
    const params = new URLSearchParams({
      type: props.title.mediaType,
      id: String(props.title.tmdbId),
      sourceId: option.sourceId,
      height: String(option.height),
      filename: downloadFilename(props.episodeLabel ? `${props.displayTitle} ${props.episodeLabel}` : props.displayTitle, option),
    });
    if (props.title.season != null) params.set("season", String(props.title.season));
    if (props.title.episode != null) params.set("episode", String(props.title.episode));
    const ticket = props.sources.find((s) => s.id === option.sourceId)?.remuxTicket;
    if (ticket) params.set("ticket", ticket);
    return `/api/download?${params}`;
  };
  const started = state.phase === "playing" || state.phase === "recovering" || (state.phase === "starting" && hasPlayhead);

  // A click or tap shows or hides the controls (only the play button pauses);
  // on touch, a double tap on either side seeks, like every phone video app.
  const onTouchTap = useCallback(
    (clientX: number, touch: boolean) => {
      const now = Date.now();
      const doubleTap = touch && now - lastTapAt.current < DOUBLE_TAP_MS;
      lastTapAt.current = now;
      const rect = containerRef.current?.getBoundingClientRect();
      const zone = rect && rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
      if (doubleTap && started && (zone < SEEK_ZONE || zone > 1 - SEEK_ZONE)) {
        actions.seekBy(zone < SEEK_ZONE ? -seekStep : seekStep);
        poke();
        return;
      }
      const s = usePlayerState.getState();
      if (s.controlsVisible && s.playing) {
        if (idleTimer.current) clearTimeout(idleTimer.current);
        s.set({ controlsVisible: false });
      } else {
        poke();
      }
    },
    [actions, poke, started, seekStep]
  );
  const showLoading = !started && !state.failureMessage;
  // Picked up where the viewer left off: offer the beginning for a few seconds.
  const [startOverAt, setStartOverAt] = useState<number | null>(null);
  const startOverChecked = useRef(false);
  useEffect(() => {
    if (!started || startOverChecked.current) return;
    startOverChecked.current = true;
    const at = usePlayerState.getState().currentTime;
    if (at >= START_OVER_MIN_S && props.initialTime >= START_OVER_MIN_S) setStartOverAt(at);
  }, [started, props.initialTime]);
  useEffect(() => {
    if (startOverAt === null) return;
    const timer = setTimeout(() => setStartOverAt(null), START_OVER_MS);
    return () => clearTimeout(timer);
  }, [startOverAt]);
  // The loading scene stays mounted through its exit, then unmounts for good.
  const [loaderGone, setLoaderGone] = useState(false);
  const controlsShown = state.controlsVisible || panel !== "none" || !state.playing;

  const connecting = Boolean(activeSource) && state.phase !== "resolving";
  // Start-up buffer as a share of START_BUFFER_S, in 5% steps (re-renders only when a step changes).
  const startBuffer = usePlayerState((s) => Math.round(Math.min(1, Math.max(0, s.bufferedEnd - s.currentTime) / START_BUFFER_S) * 20) / 20);
  const bufferingStart = connecting && startBuffer > 0;
  // Times only apply to the cut they were measured on: ignore them when this
  // file's length differs by more than a few seconds. Selected as an index so
  // the player re-renders when the playhead enters or leaves a segment, not
  // on every time update.
  const skipIndex = usePlayerState((s) =>
    started && props.skipSegments
      ? props.skipSegments.findIndex(
          (seg) =>
            s.currentTime >= seg.start &&
            s.currentTime < seg.end - SKIP_TAIL_S &&
            (!seg.episodeLength || !s.duration || Math.abs(seg.episodeLength - s.duration) <= SKIP_LENGTH_TOLERANCE_S)
        )
      : -1
  );
  const skip = skipIndex >= 0 ? props.skipSegments?.[skipIndex] : undefined;
  const skipToNext = skip?.kind === "credits" && Boolean(props.tv?.onNextEpisode);
  const showSkip = Boolean(skip) && !(skipToNext && state.upNextVisible);
  skipNowRef.current =
    skip && showSkip
      ? () => {
          if (skipToNext) props.tv!.onNextEpisode!();
          else actions.seek(skip.end);
        }
      : null;

  // "Skip intros automatically": an intro or recap is skipped once as it
  // starts, with a chip to go back and watch it (which also stops it being
  // skipped again this episode).
  const autoSkipped = useRef(new Set<number>());
  const [undoSkip, setUndoSkip] = useState<SkipSegment | null>(null);
  const autoSkip = profilePrefs?.autoSkipIntro === true;
  const skipStart = skip?.start;
  const skipKind = skip?.kind;
  const skipEnd = skip?.end;
  useEffect(() => {
    if (!autoSkip || skipStart === undefined || skipEnd === undefined || (skipKind !== "intro" && skipKind !== "recap")) return;
    if (autoSkipped.current.has(skipStart)) return;
    autoSkipped.current.add(skipStart);
    actions.seek(skipEnd);
    setUndoSkip({ kind: skipKind, start: skipStart, end: skipEnd } as SkipSegment);
  }, [autoSkip, skipStart, skipEnd, skipKind, actions]);
  useEffect(() => {
    if (!undoSkip) return;
    const timer = setTimeout(() => setUndoSkip(null), AUTO_SKIP_UNDO_MS);
    return () => clearTimeout(timer);
  }, [undoSkip]);

  const subtitleLabel = state.subtitles.find((o) => o.id === state.activeSubtitle)?.label ?? "Off";
  const remuxAudio = state.remuxAudio;
  const audioOptions =
    remuxAudio && remuxAudio.tracks.length > 1
      ? remuxAudio.tracks.map((track) => ({
          key: `remux-${track.index}`,
          label: audioTrackLabel(track.language, track.name),
          detail: channelsLabel(track.channels),
          selected: remuxAudio.active === track.index,
          select: () => {
            setPanel("none");
            actions.selectRemuxAudio(track.index);
          },
        }))
      : state.audioTracks.map((track) => ({
          key: `engine-${track.id}`,
          label: track.name,
          detail: track.lang ? languageName(track.lang) : undefined,
          selected: state.activeAudio === track.id,
          select: () => actions.selectAudio(track.id),
        }));
  const activeAudioLabel = audioOptions.find((o) => o.selected)?.label ?? "";

  return (
    <div
      ref={containerRef}
      className={cn("player-shell relative h-full w-full select-none overflow-hidden bg-black text-white", !controlsShown && "cursor-none")}
      onPointerMove={(e) => {
        if (e.pointerType === "mouse") poke();
      }}
      onPointerDown={(e) => {
        // Recorded only: showing the controls here would undo the click's toggle.
        lastPointer.current = e.pointerType;
      }}
      onClick={(e) => {
        // Only the play button pauses; a click or tap elsewhere shows or hides the controls.
        if (panel !== "none") setPanel("none");
        else onTouchTap(e.clientX, lastPointer.current !== "mouse");
      }}
      onDoubleClick={() => {
        if (lastPointer.current === "mouse") toggleFullscreen();
      }}
    >
      <video
        ref={videoRef}
        className={cn(
          "main-player absolute inset-0 h-full w-full bg-black",
          state.videoFit === "cover" ? "object-cover" : state.videoFit === "fill" ? "object-fill" : "object-contain"
        )}
        style={videoFilter ? { filter: videoFilter } : undefined}
        playsInline
        preload="auto"
        x-webkit-airplay="allow"
      />
      <video ref={scoutRef} className="hidden" muted playsInline aria-hidden />

      <LiveCaptions
        raised={controlsShown && started}
        size={profilePrefs?.captionSize}
        background={profilePrefs?.captionBackground}
        color={profilePrefs?.captionColor}
        font={profilePrefs?.captionFont}
      />

      {!loaderGone && (
        <LoadingOverlay
          leaving={!showLoading}
          scene={<CinematicLoader look={props.loaderLook} leaving={!showLoading} onGone={() => setLoaderGone(true)} />}
          title={props.displayTitle}
          subtitle={props.episodeLabel}
          progress={bufferingStart ? startBuffer : undefined}
        />
      )}
      {started && state.buffering && !state.failureMessage && <BufferingSpinner />}

      {state.failureMessage && (
        <FailureCard
          message={state.failureMessage}
          onRetry={actions.retry}
          onServers={playable.length ? () => setPanel("servers") : undefined}
          onBack={props.onBack}
        />
      )}

      {state.notice && (
        <div className="pointer-events-none absolute inset-x-0 top-20 z-40 flex justify-center px-4 sm:top-5">
          <div role="status" className="glass-clear glass-dense max-w-md rounded-full px-4 py-2 text-center text-sm text-white">
            {state.notice.text}
          </div>
        </div>
      )}

      {/* Top bar */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-20 isolate flex items-start justify-between gap-4 p-4 sm:p-6",
          !controlsShown && "pointer-events-none"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={cn("absolute inset-0 -z-10 bg-gradient-to-b from-black/70 via-black/25 to-transparent", fade(controlsShown))} />
        <div className={cn("flex min-w-0 items-center gap-3", fade(controlsShown))}>
          <IconButton label="Back" onClick={props.onBack} className="glass-clear" size="lg">
            <ArrowLeft className="h-5 w-5" />
          </IconButton>
          <div className={cn("min-w-0", showLoading && "invisible")}>
            <div className="truncate font-display text-base font-semibold sm:text-lg">{props.displayTitle}</div>
            {props.episodeLabel && <div className="truncate text-xs text-white/70 sm:text-sm">{props.episodeLabel}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SleepChip mediaType={mediaType} className={fade(controlsShown)} onOpen={() => setPanel(panel === "sleep" ? "none" : "sleep")} />
          {nowHeight > 0 && (
            <div className={cn("glass-clear hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold sm:flex", fade(controlsShown))}>
              <Sparkles className="h-3.5 w-3.5" /> {qualityLabel(nowHeight)}
            </div>
          )}
        </div>
      </div>

      {/* Centre transport (touch-friendly) */}
      {started && (
        <div
          className={cn(
            "absolute inset-0 z-10 flex items-center justify-center gap-10",
            !(controlsShown && !state.buffering) && "pointer-events-none"
          )}
        >
          <IconButton label={`Back ${seekStep} seconds`} onClick={() => actions.seekBy(-seekStep)} className={cn("glass-clear hidden sm:inline-flex", fade(controlsShown && !state.buffering))} size="lg">
            <RotateCcw className="h-5 w-5" />
          </IconButton>
          <IconButton label={state.playing ? "Pause" : "Play"} onClick={actions.togglePlay} className={cn("glass-clear", fade(controlsShown && !state.buffering))} size="xl">
            {state.playing ? <Pause className="h-7 w-7 fill-current" /> : <Play className="h-7 w-7 translate-x-0.5 fill-current" />}
          </IconButton>
          <IconButton label={`Forward ${seekStep} seconds`} onClick={() => actions.seekBy(seekStep)} className={cn("glass-clear hidden sm:inline-flex", fade(controlsShown && !state.buffering))} size="lg">
            <RotateCw className="h-5 w-5" />
          </IconButton>
        </div>
      )}

      {undoSkip && !(skip && showSkip) && (
        <div className={cn("absolute right-4 z-30 transition-[bottom] duration-300 sm:right-8", controlsShown ? "bottom-32" : "bottom-10")}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.seek(undoSkip.start);
              setUndoSkip(null);
            }}
            className="glass-clear flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold text-white transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <RotateCcw className="h-4 w-4" />
            {undoSkip.kind === "recap" ? "Recap skipped" : "Intro skipped"} · Watch it
          </button>
        </div>
      )}
      {skip && showSkip && (
        <div className={cn("absolute right-4 z-30 transition-[bottom] duration-300 sm:right-8", controlsShown ? "bottom-32" : "bottom-10")}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (skipToNext) props.tv!.onNextEpisode!();
              else actions.seek(skip.end);
            }}
            className="glass-clear flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold text-white transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {skipToNext ? "Next Episode" : skip.kind === "intro" ? "Skip Intro" : skip.kind === "recap" ? "Skip Recap" : "Skip Credits"}
            <SkipForward className="h-4 w-4 fill-current" />
          </button>
        </div>
      )}

      {/* Bottom bar */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-20 px-3 pb-3 sm:px-6 sm:pb-6",
          !(controlsShown && started) && "pointer-events-none"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={cn("glass-clear rounded-[1.75rem] px-4 pb-2 pt-1.5 sm:px-5", fade(controlsShown && started))}>
          <SeekRow onSeek={actions.seek} onHover={setHoverTime} previewSrc={previewSrc} />
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-0.5">
              <IconButton label={state.playing ? "Pause" : "Play"} onClick={actions.togglePlay}>
                {state.playing ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
              </IconButton>
              {/* Phones set volume with their own buttons (iOS ignores the page's), and the space is needed. */}
              <div className="hidden sm:block">
                <VolumeControl volume={state.volume} muted={state.muted} onVolume={actions.setVolume} onToggleMute={actions.toggleMute} />
              </div>
              {props.tv?.onNextEpisode && (
                <IconButton label="Next episode" onClick={props.tv.onNextEpisode}>
                  <SkipForward className="h-5 w-5 fill-current" />
                </IconButton>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              {props.tv && (
                <IconButton label="Episodes" active={panel === "episodes"} onClick={() => setPanel(panel === "episodes" ? "none" : "episodes")}>
                  <ListVideo className="h-5 w-5" />
                </IconButton>
              )}
              <IconButton
                label={sleepActive ? "Sleep timer (on)" : "Sleep timer"}
                active={sleepActive || panel === "sleep"}
                onClick={() => setPanel(panel === "sleep" ? "none" : "sleep")}
              >
                <Moon className={cn("h-5 w-5", sleepActive && "fill-current")} />
              </IconButton>
              <IconButton
                label="Settings"
                active={panel !== "none" && panel !== "episodes" && panel !== "sleep"}
                onClick={() => setPanel(panel === "none" || panel === "episodes" || panel === "sleep" ? "settings" : "none")}
              >
                <Settings className="h-5 w-5" />
              </IconButton>
              <IconButton label={state.fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>
                {state.fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </IconButton>
            </div>
          </div>
        </div>
      </div>

      {startOverAt !== null && !state.failureMessage && (
        <div className={cn("absolute left-3 z-30 transition-[bottom] duration-300 sm:left-8", controlsShown ? "bottom-32" : "bottom-10")}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.seek(0);
              setStartOverAt(null);
            }}
            className="glass-clear flex h-11 items-center gap-2 rounded-full px-5 text-sm font-medium text-white transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <RotateCcw className="h-4 w-4" />
            <span className="text-white/70">Resumed at {formatTime(startOverAt)} ·</span> Start over
          </button>
        </div>
      )}
      <SleepWarning mediaType={mediaType} hasNextEpisode={hasNextEpisode} raised={controlsShown && started} />
      <SleepScreen
        title={props.displayTitle}
        episodeLabel={props.episodeLabel}
        onResume={actions.togglePlay}
        onNextEpisode={props.tv?.onNextEpisode}
        onBack={props.onBack}
      />

      {/* Menus */}
      {panel !== "none" && (
        <div className="player-menus absolute bottom-28 right-3 z-30 sm:bottom-32 sm:right-6">
          {panel === "settings" && (
            <PlayerMenu title="Settings">
              <MenuItem label="Subtitles" trailing={<MenuValue>{subtitleLabel}</MenuValue>} onClick={() => setPanel("subtitles")} />
              {audioOptions.length > 1 && (
                <MenuItem label="Audio" trailing={<MenuValue>{activeAudioLabel}</MenuValue>} onClick={() => setPanel("audio")} />
              )}
              <MenuItem
                label="Quality"
                trailing={<MenuValue>{state.qualityChoice === "auto" ? `Auto${nowHeight ? ` (${qualityLabel(nowHeight)})` : ""}` : qualityLabel(state.qualityChoice)}</MenuValue>}
                onClick={() => setPanel("quality")}
              />
              <MenuItem label="Picture" trailing={<MenuValue>{VIDEO_FITS.find((f) => f.value === state.videoFit)?.label}</MenuValue>} onClick={() => setPanel("picture")} />
              <MenuItem label="Playback speed" trailing={<MenuValue>{state.rate === 1 ? "Normal" : `${state.rate}×`}</MenuValue>} onClick={() => setPanel("speed")} />
              <MenuItem label="Server" trailing={<MenuValue>{serverName(activeSource)}</MenuValue>} onClick={() => setPanel("servers")} />
              <MenuItem label="Sleep timer" trailing={<SleepMenuValue mediaType={mediaType} />} onClick={() => setPanel("sleep-settings")} />
              {typeof document !== "undefined" && document.pictureInPictureEnabled && (
                <MenuItem
                  label="Picture in picture"
                  trailing={<PictureInPicture2 className="h-4 w-4 text-white/70" />}
                  onClick={() => {
                    setPanel("none");
                    togglePip();
                  }}
                />
              )}
              {airplay && (
                <MenuItem
                  label="AirPlay"
                  trailing={<Airplay className="h-4 w-4 text-white/70" />}
                  onClick={() => {
                    setPanel("none");
                    (videoRef.current as HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void })?.webkitShowPlaybackTargetPicker?.();
                  }}
                />
              )}
              {downloads.length > 0 && (
                <MenuItem label="Download" trailing={<MenuValue>{`${downloads.length} option${downloads.length > 1 ? "s" : ""}`}</MenuValue>} onClick={() => setPanel("download")} />
              )}
              {lastPointer.current === "mouse" && (
                <MenuItem label="Keyboard shortcuts" trailing={<MenuValue>?</MenuValue>} onClick={() => setPanel("shortcuts")} />
              )}
            </PlayerMenu>
          )}
          {panel === "subtitles" && (
            <PlayerMenu title="Subtitles" onBack={() => setPanel("settings")}>
              <MenuItem label="Off" selected={!state.activeSubtitle} onClick={() => selectSubtitle(null)} />
              {state.subtitles.map((option) => (
                <MenuItem
                  key={option.id}
                  label={option.label}
                  detail={option.origin === "external" ? "Online" : "In the file"}
                  selected={state.activeSubtitle === option.id}
                  onClick={() => selectSubtitle(option.id)}
                />
              ))}
            </PlayerMenu>
          )}
          {panel === "audio" && (
            <PlayerMenu title="Audio" onBack={() => setPanel("settings")}>
              {audioOptions.map((option) => (
                <MenuItem key={option.key} label={option.label} detail={option.detail} selected={option.selected} onClick={option.select} />
              ))}
            </PlayerMenu>
          )}
          {panel === "picture" && (
            <PlayerMenu title="Picture" onBack={() => setPanel("settings")}>
              {VIDEO_FITS.map((fit) => (
                <MenuItem key={fit.value} label={fit.label} detail={fit.detail} selected={state.videoFit === fit.value} onClick={() => usePlayerState.getState().set({ videoFit: fit.value })} />
              ))}
            </PlayerMenu>
          )}
          {panel === "download" && (
            <PlayerMenu title="Download" onBack={() => setPanel("settings")}>
              <p className="px-3 pb-2 text-xs leading-relaxed text-white/60">Saves the original file to this device.</p>
              {downloads.map((option) => (
                <a
                  key={option.id}
                  href={downloadHref(option)}
                  download
                  className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm transition-colors hover:bg-[var(--mat-fill-hover)] focus-visible:bg-[var(--mat-fill-hover)] focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block truncate text-xs text-white/55">{downloadDetailLine(option)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-white/60">{downloadSizeLabel(option)}</span>
                </a>
              ))}
            </PlayerMenu>
          )}
          {panel === "quality" && (
            <PlayerMenu title="Quality" onBack={() => setPanel("settings")}>
              <MenuItem label="Auto" detail="Best quality for your connection" selected={state.qualityChoice === "auto"} onClick={() => actions.setQuality("auto")} />
              {heights.map((h) => (
                <MenuItem key={h} label={qualityLabel(h)} detail={h >= 2160 ? "Ultra HD" : h >= 1080 ? "Full HD" : undefined} selected={state.qualityChoice === h} onClick={() => actions.setQuality(h)} />
              ))}
            </PlayerMenu>
          )}
          {panel === "speed" && (
            <PlayerMenu title="Playback speed" onBack={() => setPanel("settings")}>
              {PLAYBACK_SPEEDS.map((rate) => (
                <MenuItem key={rate} label={rate === 1 ? "Normal" : `${rate}×`} selected={state.rate === rate} onClick={() => actions.setRate(rate)} />
              ))}
            </PlayerMenu>
          )}
          {panel === "servers" && (
            <PlayerMenu title="Server" onBack={state.failureMessage ? undefined : () => setPanel("settings")}>
              {playable.length === 0 && <p className="px-3 py-4 text-sm text-white/60">No servers yet — still searching.</p>}
              {playable.map((source) => (
                <MenuItem
                  key={source.id}
                  label={serverName(source)}
                  detail={serverDetail(source)}
                  selected={source.id === state.activeSourceId}
                  onClick={() => {
                    actions.selectSource(source.id);
                    setPanel("none");
                  }}
                />
              ))}
              {props.discovering && (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-white/50">
                  <Server className="h-3.5 w-3.5" /> Still looking for more servers…
                </div>
              )}
            </PlayerMenu>
          )}
          {(panel === "sleep" || panel === "sleep-settings") && (
            <SleepMenu
              mediaType={mediaType}
              hasNextEpisode={hasNextEpisode}
              onBack={panel === "sleep-settings" ? () => setPanel("settings") : undefined}
              onChosen={(confirmation) => {
                setPanel("none");
                usePlayerState.getState().showNotice(confirmation);
              }}
            />
          )}
          {panel === "shortcuts" && (
            <PlayerMenu title="Keyboard shortcuts" onBack={() => setPanel("settings")}>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-3 pb-3 text-sm">
                {PLAYER_SHORTCUTS.map(({ key, desc }) => (
                  <div key={key} className="contents">
                    <kbd className="justify-self-start whitespace-nowrap rounded-md bg-white/10 px-2 py-0.5 font-mono text-xs text-white/90">{key}</kbd>
                    <span className="text-white/75">{desc}</span>
                  </div>
                ))}
              </div>
            </PlayerMenu>
          )}
          {panel === "episodes" && props.tv && (
            <EpisodesMenu
              tvId={props.title.tmdbId}
              seasons={props.tv.seasons}
              season={props.tv.season}
              episode={props.tv.episode}
              onSelect={(s, e) => {
                setPanel("none");
                props.tv!.onSelectEpisode(s, e);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function audioTrackLabel(language: string | null, name: string | null): string {
  const base = languageName(language);
  const extra = name?.trim();
  return extra && extra.toLowerCase() !== base.toLowerCase() ? `${base} · ${extra}` : base;
}

function channelsLabel(channels: number | null): string | undefined {
  if (!channels) return undefined;
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo";
  return `${channels - 1}.1`;
}

/**
 * Fades a floating control in or out. The fade sits on the glass element
 * itself, never on a wrapper: an ancestor below full opacity becomes the
 * blur's backdrop root, so the glass would stop blurring the video and turn
 * clear for the length of every fade.
 */
function fade(shown: boolean): string {
  return cn("transition-opacity duration-300", shown ? "opacity-100" : "opacity-0");
}

function serverName(source: PlaybackSource | null): string {
  if (!source) return "—";
  return source.label.split("•")[0]!.replace(/·.*$/, "").trim() || source.provider;
}

/** Which debrid account a premium row came from (Real-Debrid rows are labelled "Debrid"). */
function debridServiceName(source: PlaybackSource): string {
  const provider = source.provider.toLowerCase();
  if (provider.includes("alldebrid")) return "AllDebrid";
  if (provider.includes("torbox")) return "TorBox";
  return "Real-Debrid";
}

function serverDetail(source: PlaybackSource): string {
  const height = sourceMaxHeight(source);
  const parts = [height ? qualityLabel(normalizeHeight(height)) : "Auto"];
  if (source.origin === "debrid") parts.push(debridServiceName(source));
  if (sourceDelivery(source) === "remux") parts.push("Remux");
  return parts.join(" · ");
}

/** Every player field except the ones that change several times a second. */
function coarseState(s: PlayerState): Omit<PlayerState, "currentTime" | "bufferedEnd" | "cueText"> {
  const { currentTime, bufferedEnd, cueText, ...rest } = s;
  return rest;
}

/** Elapsed and remaining time around the seek bar: the only part of the controls that follows the playhead. */
function SeekRow({
  onSeek,
  onHover,
  previewSrc,
}: {
  onSeek(time: number): void;
  onHover(time: number | null): void;
  previewSrc: string | null;
}) {
  const currentTime = usePlayerState((s) => s.currentTime);
  const duration = usePlayerState((s) => s.duration);
  const bufferedEnd = usePlayerState((s) => s.bufferedEnd);
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 text-right text-xs font-medium tabular-nums text-white/90">{formatTime(currentTime)}</span>
      <SeekBar duration={duration} currentTime={currentTime} bufferedEnd={bufferedEnd} onSeek={onSeek} onHover={onHover} previewSrc={previewSrc} />
      <span className="w-14 text-xs font-medium tabular-nums text-white/70">-{formatTime(Math.max(0, duration - currentTime))}</span>
    </div>
  );
}

/** Captions that follow the cue text on their own. */
function LiveCaptions(props: Omit<React.ComponentProps<typeof Captions>, "text">) {
  const text = usePlayerState((s) => s.cueText);
  return <Captions text={text} {...props} />;
}

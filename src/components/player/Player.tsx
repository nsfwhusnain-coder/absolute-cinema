"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Airplay,
  Captions as CaptionsIcon,
  ListVideo,
  Maximize,
  Minimize,
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
import type { SubtitlePreference } from "@/lib/profile-preferences";
import { sourceDelivery, sourceMaxHeight } from "@/lib/playback/source-quality";
import { useHoverPreview } from "@/hooks/use-hover-preview";
import { hdrSdrDisplayMap } from "@/lib/playback/hdr-sdr-map";
import { buildDownloadOptions, downloadDetailLine, downloadFilename, downloadSizeLabel } from "@/lib/playback/download-options";
import { cn } from "@/lib/utils";
import { usePlayerState, PLAYBACK_SPEEDS } from "./store";
import { usePlayerController } from "./use-player-controller";
import { useSubtitles, type ExternalSubtitle } from "./use-subtitles";
import { normalizeHeight, playableHere, qualityChoices, qualityLabel, type AudioChoice, type TitleContext } from "./playable";
import {
  BufferingSpinner,
  Captions,
  FailureCard,
  IconButton,
  LoadingOverlay,
  MenuItem,
  MenuSection,
  PlayerMenu,
  SeekBar,
  VolumeControl,
  formatTime,
} from "./ui";
import { EpisodesMenu, type SeasonOption } from "./episodes-menu";

const CONTROLS_IDLE_MS = 3200;
const NOTICE_MS = 5000;
const SEEK_STEP_S = 10;
const VOLUME_STEP = 0.1;

type Panel = "none" | "subtitles" | "settings" | "quality" | "speed" | "servers" | "download" | "episodes";

export interface PlayerProps {
  sources: PlaybackSource[];
  discovering: boolean;
  remuxAvailable: boolean;
  title: TitleContext;
  displayTitle: string;
  episodeLabel?: string;
  backdrop?: string | null;
  logo?: string | null;
  initialTime: number;
  fallbackDurationS: number;
  audio: AudioChoice;
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
  const state = usePlayerState();

  const actions = usePlayerController({
    videoRef,
    sources: props.sources,
    discovering: props.discovering,
    remuxAvailable: props.remuxAvailable,
    title: props.title,
    initialTime: props.initialTime,
    audio: props.audio,
    fallbackDurationS: props.fallbackDurationS,
    onProgress: props.onProgress,
    onEnded: props.onEnded,
    onRefreshSources: props.onRefreshSources,
  });
  const { selectSubtitle } = useSubtitles(videoRef, props.externalSubtitles, props.subtitlePreference);

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

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
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
      const s = usePlayerState.getState();
      const key = e.key.toLowerCase();
      let handled = true;
      if (key === " " || key === "k") actions.togglePlay();
      else if (key === "arrowleft" || key === "j") actions.seekBy(-SEEK_STEP_S);
      else if (key === "arrowright" || key === "l") actions.seekBy(SEEK_STEP_S);
      else if (key === "arrowup") actions.setVolume(s.volume + VOLUME_STEP);
      else if (key === "arrowdown") actions.setVolume(s.volume - VOLUME_STEP);
      else if (key === "m") actions.toggleMute();
      else if (key === "f") toggleFullscreen();
      else if (key === "c") selectSubtitle(s.activeSubtitle ? null : (s.subtitles[0]?.id ?? null));
      else if (key === "n" && props.tv?.onNextEpisode) props.tv.onNextEpisode();
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
  }, [actions, toggleFullscreen, selectSubtitle, panel, props.tv, props.onBack, poke]);

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
  const started = state.phase === "playing" || state.phase === "recovering" || (state.phase === "starting" && state.currentTime > 0);
  const showLoading = !started && !state.failureMessage;
  const controlsShown = state.controlsVisible || panel !== "none" || !state.playing;

  const loadingStatus =
    state.phase === "resolving"
      ? props.sources.length
        ? "Finding the best stream…"
        : "Searching servers…"
      : activeSource
        ? `Starting ${qualityLabel(normalizeHeight(sourceMaxHeight(activeSource) || 1080))}${isRemux ? " · preparing" : ""}…`
        : "Starting…";

  return (
    <div
      ref={containerRef}
      className={cn("relative h-full w-full select-none overflow-hidden bg-black text-white", !controlsShown && "cursor-none")}
      onMouseMove={poke}
      onPointerDown={poke}
      onClick={() => {
        if (panel !== "none") setPanel("none");
        else if (started) actions.togglePlay();
      }}
      onDoubleClick={toggleFullscreen}
    >
      <video
        ref={videoRef}
        className="main-player absolute inset-0 h-full w-full bg-black object-contain"
        style={videoFilter ? { filter: videoFilter } : undefined}
        playsInline
        preload="auto"
        x-webkit-airplay="allow"
      />
      <video ref={scoutRef} className="hidden" muted playsInline aria-hidden />

      <Captions text={state.cueText} raised={controlsShown && started} />

      {showLoading && (
        <LoadingOverlay
          backdrop={props.backdrop}
          logo={props.logo}
          title={props.displayTitle}
          subtitle={props.episodeLabel}
          status={loadingStatus}
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
        <div className="pointer-events-none absolute inset-x-0 top-5 z-40 flex justify-center px-4">
          <div role="status" className="glass max-w-md rounded-full px-4 py-2 text-center text-sm text-white">
            {state.notice.text}
          </div>
        </div>
      )}

      {/* Top bar */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 bg-gradient-to-b from-black/70 via-black/25 to-transparent p-4 transition-opacity duration-300 sm:p-6",
          controlsShown ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-3">
          <IconButton label="Back" onClick={props.onBack} className="glass" size="lg">
            <ArrowLeft className="h-5 w-5" />
          </IconButton>
          <div className="min-w-0">
            <div className="truncate font-display text-base font-semibold sm:text-lg">{props.displayTitle}</div>
            {props.episodeLabel && <div className="truncate text-xs text-white/70 sm:text-sm">{props.episodeLabel}</div>}
          </div>
        </div>
        {nowHeight > 0 && (
          <div className="glass hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold sm:flex">
            <Sparkles className="h-3.5 w-3.5" /> {qualityLabel(nowHeight)}
          </div>
        )}
      </div>

      {/* Centre transport (touch-friendly) */}
      {started && (
        <div
          className={cn(
            "absolute inset-0 z-10 flex items-center justify-center gap-10 transition-opacity duration-300",
            controlsShown && !state.buffering ? "opacity-100" : "pointer-events-none opacity-0"
          )}
        >
          <IconButton label="Back 10 seconds" onClick={() => actions.seekBy(-SEEK_STEP_S)} className="glass hidden sm:inline-flex" size="lg">
            <RotateCcw className="h-5 w-5" />
          </IconButton>
          <IconButton label={state.playing ? "Pause" : "Play"} onClick={actions.togglePlay} className="glass" size="xl">
            {state.playing ? <Pause className="h-7 w-7 fill-current" /> : <Play className="h-7 w-7 translate-x-0.5 fill-current" />}
          </IconButton>
          <IconButton label="Forward 10 seconds" onClick={() => actions.seekBy(SEEK_STEP_S)} className="glass hidden sm:inline-flex" size="lg">
            <RotateCw className="h-5 w-5" />
          </IconButton>
        </div>
      )}

      {/* Bottom bar */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-20 px-3 pb-3 transition-opacity duration-300 sm:px-6 sm:pb-6",
          controlsShown && started ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="glass rounded-[1.75rem] px-4 pb-2 pt-1.5 sm:px-5">
          <div className="flex items-center gap-3">
            <span className="w-14 text-right text-xs font-medium tabular-nums text-white/85">{formatTime(state.currentTime)}</span>
            <SeekBar
              duration={state.duration}
              currentTime={state.currentTime}
              bufferedEnd={state.bufferedEnd}
              onSeek={actions.seek}
              onHover={setHoverTime}
              previewSrc={previewSrc}
            />
            <span className="w-14 text-xs font-medium tabular-nums text-white/60">-{formatTime(Math.max(0, state.duration - state.currentTime))}</span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-0.5">
              <IconButton label={state.playing ? "Pause" : "Play"} onClick={actions.togglePlay}>
                {state.playing ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
              </IconButton>
              <VolumeControl volume={state.volume} muted={state.muted} onVolume={actions.setVolume} onToggleMute={actions.toggleMute} />
            </div>
            <div className="flex items-center gap-0.5">
              {props.tv?.onNextEpisode && (
                <IconButton label="Next episode" onClick={props.tv.onNextEpisode}>
                  <SkipForward className="h-5 w-5" />
                </IconButton>
              )}
              {props.tv && (
                <IconButton label="Episodes" active={panel === "episodes"} onClick={() => setPanel(panel === "episodes" ? "none" : "episodes")}>
                  <ListVideo className="h-5 w-5" />
                </IconButton>
              )}
              <IconButton label="Subtitles and audio" active={panel === "subtitles"} onClick={() => setPanel(panel === "subtitles" ? "none" : "subtitles")}>
                <CaptionsIcon className="h-5 w-5" />
              </IconButton>
              <IconButton
                label="Settings"
                active={panel === "settings" || panel === "quality" || panel === "speed" || panel === "servers" || panel === "download"}
                onClick={() => setPanel(panel === "none" ? "settings" : "none")}
              >
                <Settings className="h-5 w-5" />
              </IconButton>
              {airplay && (
                <IconButton
                  label="AirPlay"
                  onClick={() => (videoRef.current as HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void })?.webkitShowPlaybackTargetPicker?.()}
                >
                  <Airplay className="h-5 w-5" />
                </IconButton>
              )}
              {typeof document !== "undefined" && document.pictureInPictureEnabled && (
                <IconButton label="Picture in picture" onClick={togglePip} className="hidden sm:inline-flex">
                  <PictureInPicture2 className="h-5 w-5" />
                </IconButton>
              )}
              <IconButton label={state.fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>
                {state.fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </IconButton>
            </div>
          </div>
        </div>
      </div>

      {/* Menus */}
      {panel !== "none" && (
        <div className="absolute bottom-28 right-3 z-30 sm:bottom-32 sm:right-6">
          {panel === "subtitles" && (
            <PlayerMenu title="Subtitles & audio">
              <MenuSection label="Subtitles">
                <MenuItem label="Off" selected={!state.activeSubtitle} onClick={() => selectSubtitle(null)} />
                {state.subtitles.map((option) => (
                  <MenuItem
                    key={option.id}
                    label={option.label}
                    detail={option.origin === "embedded" ? "In stream" : undefined}
                    selected={state.activeSubtitle === option.id}
                    onClick={() => selectSubtitle(option.id)}
                  />
                ))}
              </MenuSection>
              {state.audioTracks.length > 1 && (
                <MenuSection label="Audio">
                  {state.audioTracks.map((track) => (
                    <MenuItem key={track.id} label={track.name} detail={track.lang || undefined} selected={state.activeAudio === track.id} onClick={() => actions.selectAudio(track.id)} />
                  ))}
                </MenuSection>
              )}
            </PlayerMenu>
          )}
          {panel === "settings" && (
            <PlayerMenu title="Settings">
              <MenuItem
                label="Quality"
                trailing={<span className="text-xs text-white/60">{state.qualityChoice === "auto" ? `Auto${nowHeight ? ` (${qualityLabel(nowHeight)})` : ""}` : qualityLabel(state.qualityChoice)}</span>}
                onClick={() => setPanel("quality")}
              />
              <MenuItem
                label="Playback speed"
                trailing={<span className="text-xs text-white/60">{state.rate === 1 ? "Normal" : `${state.rate}×`}</span>}
                onClick={() => setPanel("speed")}
              />
              <MenuItem
                label="Server"
                trailing={<span className="max-w-[9rem] truncate text-xs text-white/60">{serverName(activeSource)}</span>}
                onClick={() => setPanel("servers")}
              />
              {downloads.length > 0 && (
                <MenuItem label="Download" trailing={<span className="text-xs text-white/60">{downloads.length} option{downloads.length > 1 ? "s" : ""}</span>} onClick={() => setPanel("download")} />
              )}
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

function serverName(source: PlaybackSource | null): string {
  if (!source) return "—";
  return source.label.split("•")[0]!.replace(/·.*$/, "").trim() || source.provider;
}

function serverDetail(source: PlaybackSource): string {
  const height = sourceMaxHeight(source);
  const parts = [height ? qualityLabel(normalizeHeight(height)) : "Auto"];
  if (source.origin === "debrid") parts.push("Real-Debrid");
  if (sourceDelivery(source) === "remux") parts.push("Remux");
  return parts.join(" · ");
}

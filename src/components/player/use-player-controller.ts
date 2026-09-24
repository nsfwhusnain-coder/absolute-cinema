"use client";

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { PlaybackSource } from "@/lib/playback/types";
import {
  initialOrchestratorState,
  onAwaitRefresh,
  onFirstFrame,
  onPlaybackError,
  onRetryAll,
  onRoster,
  onStartFailed,
  onUserSelect,
  type Command,
  type OrchestratorState,
  type Transition,
} from "@/lib/playback/orchestrator";
import { emitPlayerFeedback, setFeedbackTitleContext, clearFeedbackTitleContext } from "@/lib/playback/player-feedback";
import { getPreferredProvider, getSavedPlaybackSpeed, setSavedPlaybackSpeed } from "@/lib/player-preferences";
import { MediaEngine } from "./engine";
import { createRanker, resolvePlayable, type AudioChoice, type TitleContext } from "./playable";
import { usePlayerState } from "./store";
import { getTitleLanguage, rememberTitleLanguage, titleLanguageKey } from "@/lib/title-language";

/** No first frame within this long means the source is not going to start. */
const START_TIMEOUT_MS = 20_000;
/** Remux sessions open, index and produce their first segment before a frame exists (cold 4K measured at up to ~11s). */
const REMUX_START_TIMEOUT_MS = 25_000;
/** This many rebuffers inside the window means the source cannot keep up, even if each one recovers. */
const REBUFFER_LIMIT = 3;
const REBUFFER_WINDOW_MS = 90_000;
/** Buffering right after a seek is expected and does not count. */
const SEEK_GRACE_MS = 4_000;
const QUALITY_STEPS = [2160, 1440, 1080, 720, 480];
/** Buffering this long with no progress while playing means the server is too slow. */
const STALL_TIMEOUT_MS = 12_000;
/** A retry of a source that was already playing gets less patience than a cold start. */
const RECOVERY_TIMEOUT_MS = 15_000;
const PROGRESS_REPORT_MS = 10_000;
/** Watch time that proves a source works (feeds per-title source memory). */
const SUSTAINED_PLAY_MS = 90_000;
const TIME_UPDATE_MIN_MS = 250;

export interface PlayerControllerOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  sources: PlaybackSource[];
  discovering: boolean;
  remuxAvailable: boolean;
  title: TitleContext;
  initialTime: number;
  audio: AudioChoice;
  /** Title length from the catalog, used until the stream reports its own. */
  fallbackDurationS: number;
  onProgress(current: number, duration: number): void;
  onEnded(): void;
  onRefreshSources(): void;
}

export function usePlayerController(options: PlayerControllerOptions) {
  const { videoRef } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const orchestrator = useRef<OrchestratorState>(initialOrchestratorState);
  const engineRef = useRef<MediaEngine | null>(null);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Audio track the viewer picked inside a remuxed file (applies to that source only). */
  const audioOverride = useRef<{ sourceId: string; index: number } | null>(null);
  const rebuffers = useRef<number[]>([]);
  const lastSeekAt = useRef(0);
  const rebufferSwitches = useRef(0);
  const attachAbort = useRef<AbortController | null>(null);
  const attemptStartedAt = useRef(0);
  const playedOnSourceMs = useRef(0);
  const sustainedReported = useRef(false);
  const lastProgressAt = useRef(0);
  const lastTimeUpdate = useRef(0);
  const positionRef = useRef(options.initialTime);
  const remuxDuration = useRef<number | null>(null);
  /** One automatic roster refresh is tried before an error is shown. */
  const autoRefreshed = useRef(false);
  const store = usePlayerState;

  const sourceById = useCallback((id: string | null) => optionsRef.current.sources.find((s) => s.id === id), []);

  const ranker = useCallback(() => {
    const { remuxAvailable } = optionsRef.current;
    return createRanker(store.getState().qualityChoice, remuxAvailable, getPreferredProvider());
  }, [store]);

  const clearTimers = useCallback(() => {
    if (startTimer.current) clearTimeout(startTimer.current);
    if (stallTimer.current) clearTimeout(stallTimer.current);
    if (recheckTimer.current) clearTimeout(recheckTimer.current);
    startTimer.current = null;
    stallTimer.current = null;
    recheckTimer.current = null;
  }, []);

  const reportSustained = useCallback(() => {
    const source = sourceById(orchestrator.current.activeId);
    if (!source || playedOnSourceMs.current < 1000) return;
    emitPlayerFeedback({ event: "sustained_play", sourceId: source.id, provider: source.provider, watchedMs: Math.round(playedOnSourceMs.current) });
    playedOnSourceMs.current = 0;
  }, [sourceById]);

  // Applies a transition; `execute` is assigned below (mutually recursive with the failure handlers).
  const executeRef = useRef<(command: Command) => void>(() => {});
  const apply = useCallback(
    (transition: Transition) => {
      orchestrator.current = transition.state;
      store.getState().set({ phase: transition.state.phase, activeSourceId: transition.state.activeId });
      executeRef.current(transition.command);
    },
    [store]
  );

  const startFailed = useCallback(
    (reason: string) => {
      const state = orchestrator.current;
      if (state.phase !== "starting") return;
      const source = sourceById(state.activeId);
      if (source) {
        emitPlayerFeedback({ event: "handoff_failed", sourceId: source.id, provider: source.provider, reason, engine: engineRef.current?.kind });
        const name = source.label.split("•")[0]?.trim() || source.provider;
        store.getState().set({ startNote: `${name} didn't respond, trying the next server` });
      }
      const { sources, discovering } = optionsRef.current;
      apply(onStartFailed(state, sources, reason, discovering, ranker(), Date.now()));
    },
    [apply, ranker, sourceById]
  );

  const playbackFailed = useCallback(
    (reason: string, kind: "error" | "stall" = "error") => {
      const state = orchestrator.current;
      if (state.phase === "starting") return startFailed(reason);
      if (state.phase !== "playing" && state.phase !== "recovering") return;
      const source = sourceById(state.activeId);
      if (source) emitPlayerFeedback({ event: "stall", sourceId: source.id, provider: source.provider, reason, engine: engineRef.current?.kind });
      if (state.retries >= 1) optionsRef.current.onRefreshSources();
      apply(onPlaybackError(state, optionsRef.current.sources, reason, ranker(), Date.now(), kind));
    },
    [apply, ranker, sourceById, startFailed]
  );

  const armStall = useCallback(() => {
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => playbackFailed("stall", "stall"), STALL_TIMEOUT_MS);
  }, [playbackFailed]);

  const execute = useCallback(
    async (command: Command) => {
      const s = store.getState();
      if (command.type === "wait") {
        s.set({ failureMessage: null });
        if (command.recheckInMs) {
          if (recheckTimer.current) clearTimeout(recheckTimer.current);
          recheckTimer.current = setTimeout(() => {
            recheckTimer.current = null;
            const { sources, discovering } = optionsRef.current;
            apply(onRoster(orchestrator.current, sources, discovering, ranker(), Date.now()));
          }, command.recheckInMs);
        }
        return;
      }
      if (command.type === "fail") {
        clearTimers();
        if (!autoRefreshed.current) {
          autoRefreshed.current = true;
          orchestrator.current = onAwaitRefresh(orchestrator.current);
          s.set({ phase: "resolving" });
          optionsRef.current.onRefreshSources();
          return;
        }
        engineRef.current?.destroy();
        s.set({ failureMessage: command.message, buffering: false, playing: false });
        return;
      }
      if (command.type !== "attach") return;
      const video = videoRef.current;
      const engine = engineRef.current;
      const source = sourceById(command.sourceId);
      if (!video || !engine || !source) return;
      if (command.notice) s.showNotice(command.notice, "warning");
      reportSustained();
      clearTimers();
      attachAbort.current?.abort();
      const abort = new AbortController();
      attachAbort.current = abort;
      const startAt = command.keepPosition ? positionRef.current : optionsRef.current.initialTime;
      s.set({ buffering: true, failureMessage: null, levels: [], audioTracks: [], currentLevel: -1 });
      attemptStartedAt.current = Date.now();
      sustainedReported.current = false;
      const { title } = optionsRef.current;
      const override = audioOverride.current?.sourceId === source.id ? audioOverride.current.index : undefined;
      // A language picked earlier for this show beats the profile default.
      const remembered = getTitleLanguage(titleLanguageKey(title.mediaType, title.tmdbId))?.audio;
      const baseAudio = remembered ? { preference: "preferred" as const, language: remembered } : optionsRef.current.audio;
      const audio = override === undefined ? baseAudio : { ...baseAudio, index: override };
      try {
        const resolved = await resolvePlayable(source, title, audio, startAt, video, abort.signal);
        if (abort.signal.aborted) return;
        remuxDuration.current = resolved.durationS ?? null;
        const tracks = resolved.remuxTracks;
        s.set({
          dynamicRange: resolved.dynamicRange ?? "SDR",
          streamSubtitles: tracks?.subtitles.length ? { base: tracks.subtitleBase, tracks: tracks.subtitles } : null,
          remuxAudio: tracks ? { tracks: tracks.audioTracks, active: tracks.audioIndex } : null,
        });
        const recovering = orchestrator.current.phase === "recovering";
        startTimer.current = setTimeout(
          () => (orchestrator.current.phase === "starting" ? startFailed("timeout") : playbackFailed("timeout", "stall")),
          resolved.remux ? REMUX_START_TIMEOUT_MS : recovering ? RECOVERY_TIMEOUT_MS : START_TIMEOUT_MS
        );
        const choice = store.getState().qualityChoice;
        await engine.load(resolved.playable, startAt, choice === "auto" ? undefined : choice);
        if (abort.signal.aborted) return;
        video.playbackRate = s.rate;
        video.play().catch((err: unknown) => {
          // Autoplay blocked: show the play button rather than failing the source.
          if (err instanceof DOMException && err.name === "NotAllowedError") {
            clearTimers();
            store.getState().set({ buffering: false, playing: false });
          }
        });
      } catch (err) {
        if (abort.signal.aborted) return;
        const reason = err instanceof Error ? err.message : "load failed";
        if (orchestrator.current.phase === "starting") startFailed(reason);
        else playbackFailed(reason);
      }
    },
    [apply, clearTimers, playbackFailed, ranker, reportSustained, sourceById, startFailed, store, videoRef]
  );
  executeRef.current = execute;

  // Engine lifecycle.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const engine = new MediaEngine(video, {
      onLevels: (levels) => {
        const hdrLevel = levels.find((l) => l.videoRange === "PQ" || l.videoRange === "HLG");
        store.getState().set({ levels, ...(hdrLevel ? { dynamicRange: hdrLevel.videoRange! } : {}) });
      },
      onLevelSwitched: (index) => store.getState().set({ currentLevel: index, autoLevel: engine.autoLevel }),
      onAudioTracks: (audioTracks, activeAudio) => store.getState().set({ audioTracks, activeAudio }),
      onFatal: (reason) => playbackFailed(reason),
    });
    engineRef.current = engine;
    const { title } = optionsRef.current;
    setFeedbackTitleContext({ tmdbId: String(title.tmdbId), mediaType: title.mediaType, season: title.season, episode: title.episode });
    store.getState().reset();
    store.getState().set({ rate: getSavedPlaybackSpeed() });
    video.volume = store.getState().volume;
    return () => {
      reportSustained();
      clearTimers();
      attachAbort.current?.abort();
      engine.destroy();
      engineRef.current = null;
      clearFeedbackTitleContext();
    };
  }, [videoRef, store, playbackFailed, clearTimers, reportSustained]);

  // Media element events.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const s = () => store.getState();
    let lastTick = performance.now();

    const onPlaying = () => {
      s().set({ playing: true, buffering: false });
      if (stallTimer.current) clearTimeout(stallTimer.current);
      const phase = orchestrator.current.phase;
      if ((phase === "starting" || phase === "recovering") && video.videoWidth > 0) {
        clearTimers();
        const source = sourceById(orchestrator.current.activeId);
        orchestrator.current = onFirstFrame(orchestrator.current);
        s().set({ phase: "playing", decodedHeight: video.videoHeight, startNote: null });
        if (source && phase === "starting") {
          emitPlayerFeedback({
            event: "first_frame",
            sourceId: source.id,
            provider: source.provider,
            timeToFirstFrameMs: Date.now() - attemptStartedAt.current,
            decodedHeight: video.videoHeight,
            engine: engineRef.current?.kind,
          });
        }
      }
    };
    const onTimeUpdate = () => {
      const now = performance.now();
      const t = video.currentTime;
      if (!video.paused && !video.seeking) {
        playedOnSourceMs.current += Math.min(1000, now - lastTick);
        if (!sustainedReported.current && playedOnSourceMs.current > SUSTAINED_PLAY_MS) {
          sustainedReported.current = true;
          reportSustained();
        }
      }
      lastTick = now;
      if (orchestrator.current.phase === "playing" || orchestrator.current.phase === "recovering") positionRef.current = t;
      if (stallTimer.current && !video.paused) {
        clearTimeout(stallTimer.current);
        stallTimer.current = null;
      }
      if (now - lastTimeUpdate.current >= TIME_UPDATE_MIN_MS) {
        lastTimeUpdate.current = now;
        const duration = effectiveDuration(video);
        const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
        s().set({ currentTime: t, duration, bufferedEnd: buffered, decodedHeight: video.videoHeight || s().decodedHeight });
      }
      if (Date.now() - lastProgressAt.current > PROGRESS_REPORT_MS && orchestrator.current.everPlayed) {
        lastProgressAt.current = Date.now();
        const duration = effectiveDuration(video);
        if (duration > 0) optionsRef.current.onProgress(t, duration);
      }
    };
    const onWaiting = () => {
      s().set({ buffering: true });
      if (orchestrator.current.phase !== "playing") return;
      armStall();
      if (video.seeking || Date.now() - lastSeekAt.current < SEEK_GRACE_MS) return;
      const now = Date.now();
      rebuffers.current = [...rebuffers.current.filter((t) => now - t < REBUFFER_WINDOW_MS), now];
      if (rebuffers.current.length >= REBUFFER_LIMIT) {
        rebuffers.current = [];
        moveToSmootherSource();
      }
    };
    const onSeeking = () => {
      lastSeekAt.current = Date.now();
    };
    // Playback keeps pausing to buffer: this server cannot keep up. Try another
    // one at the same point; if that happened before, also step quality down.
    const moveToSmootherSource = () => {
      rebufferSwitches.current += 1;
      if (rebufferSwitches.current > 1) {
        const current = s().decodedHeight >= 1500 ? 2160 : s().decodedHeight >= 900 ? 1080 : s().decodedHeight;
        const lower = QUALITY_STEPS.find((h) => h < current);
        if (lower) {
          s().set({ qualityChoice: lower });
          s().showNotice(`Switched to ${lower}p for smoother playback`);
        }
      }
      playbackFailed("rebuffering", "stall");
    };
    const onPause = () => {
      s().set({ playing: false });
      const duration = effectiveDuration(video);
      if (orchestrator.current.everPlayed && duration > 0) optionsRef.current.onProgress(video.currentTime, duration);
    };
    const onMeta = () => s().set({ duration: effectiveDuration(video) });
    const onEnded = () => {
      s().set({ playing: false });
      optionsRef.current.onEnded();
    };
    const onError = () => engineRef.current?.mediaElementFailed();
    const onVolume = () => s().set({ volume: video.volume, muted: video.muted });
    const onRate = () => s().set({ rate: video.playbackRate });

    const effectiveDuration = (v: HTMLVideoElement) => {
      if (remuxDuration.current) return remuxDuration.current;
      if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
      return optionsRef.current.fallbackDurationS;
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("pause", onPause);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("durationchange", onMeta);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    video.addEventListener("volumechange", onVolume);
    video.addEventListener("ratechange", onRate);
    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("durationchange", onMeta);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
      video.removeEventListener("volumechange", onVolume);
      video.removeEventListener("ratechange", onRate);
    };
  }, [videoRef, store, armStall, clearTimers, playbackFailed, reportSustained, sourceById]);

  // Roster changes: start when nothing is running; never switch a running source.
  const { sources, discovering } = options;
  useEffect(() => {
    apply(onRoster(orchestrator.current, sources, discovering, ranker(), Date.now()));
  }, [sources, discovering, apply, ranker]);

  const actions = useMemo(() => {
    const video = () => videoRef.current;
    return {
      togglePlay() {
        const v = video();
        if (!v) return;
        if (v.paused) void v.play().catch(() => {});
        else v.pause();
      },
      seek(time: number) {
        const v = video();
        if (!v) return;
        const duration = store.getState().duration || v.duration;
        const target = Math.max(0, Math.min(time, (duration || time) - 0.5));
        v.currentTime = target;
        positionRef.current = target;
        store.getState().set({ currentTime: target });
      },
      seekBy(delta: number) {
        const v = video();
        if (v) this.seek(v.currentTime + delta);
      },
      setVolume(volume: number) {
        const v = video();
        if (!v) return;
        v.volume = Math.max(0, Math.min(1, volume));
        if (v.volume > 0 && v.muted) v.muted = false;
        store.getState().set({ volume: v.volume });
      },
      toggleMute() {
        const v = video();
        if (v) v.muted = !v.muted;
      },
      setRate(rate: number) {
        const v = video();
        if (v) v.playbackRate = rate;
        setSavedPlaybackSpeed(rate);
        store.getState().set({ rate });
      },
      /** Quality: switch the stream level when this source has it, otherwise the best source at that height. */
      setQuality(choice: "auto" | number) {
        const s = store.getState();
        s.set({ qualityChoice: choice });
        const engine = engineRef.current;
        if (choice === "auto") {
          engine?.setLevel(-1);
          s.set({ autoLevel: true });
          return;
        }
        const level = s.levels.filter((l) => l.height > 0 && l.height <= choice).sort((a, b) => b.height - a.height)[0];
        const active = sourceById(orchestrator.current.activeId);
        const activeHeight = active?.maxHeight ?? 0;
        if (level && (activeHeight === 0 || Math.abs(level.height - choice) < choice * 0.3)) {
          engine?.setLevel(level.index);
          s.set({ autoLevel: false });
          return;
        }
        const best = ranker().pick(optionsRef.current.sources);
        if (best && best.id !== orchestrator.current.activeId) apply(onUserSelect(orchestrator.current, best.id));
      },
      selectSource(id: string) {
        if (id === orchestrator.current.activeId) return;
        apply(onUserSelect(orchestrator.current, id));
      },
      selectAudio(id: number) {
        engineRef.current?.setAudioTrack(id);
      },
      /** Remuxed files stream one audio track: switching reopens the same source at the same point. */
      selectRemuxAudio(index: number) {
        const sourceId = orchestrator.current.activeId;
        if (!sourceId || store.getState().remuxAudio?.active === index) return;
        audioOverride.current = { sourceId, index };
        const track = store.getState().remuxAudio?.tracks.find((t) => t.index === index);
        const { title } = optionsRef.current;
        if (track?.language) rememberTitleLanguage(titleLanguageKey(title.mediaType, title.tmdbId), { audio: track.language });
        executeRef.current({ type: "attach", sourceId, keepPosition: true, refresh: false });
      },
      retry() {
        orchestrator.current = onRetryAll(orchestrator.current);
        optionsRef.current.onRefreshSources();
        apply(onRoster(orchestrator.current, optionsRef.current.sources, true, ranker(), Date.now()));
      },
    };
  }, [apply, ranker, sourceById, store, videoRef]);

  return actions;
}

export type PlayerActions = ReturnType<typeof usePlayerController>;

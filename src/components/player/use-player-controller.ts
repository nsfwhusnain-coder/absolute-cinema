"use client";

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { PlaybackSource } from "@/lib/playback/types";
import {
  hasAlternative,
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
  type Outlook,
  type Transition,
} from "@/lib/playback/orchestrator";
import {
  PlaybackReporter,
  clearFeedbackTitleContext,
  deliveryOfSource,
  emitPlayerFeedback,
  setFeedbackTitleContext,
  type PlayerReadings,
} from "@/lib/playback/player-feedback";
import { bufferAheadSeconds } from "@/lib/telemetry/qoe";
import type { PlayerState } from "./store";
import { getPreferredProvider, getPreferredQualityHeight, getSavedPlaybackSpeed, setSavedPlaybackSpeed } from "@/lib/player-preferences";
import type { PlaybackQualityPreference } from "@/lib/profile-preferences";
import { lacksWantedAudio, normalizeTrackLanguage, selectAudioTrack } from "@/lib/playback/track-selection";
import { isHdrLikeRange, videoFrameRange } from "@/lib/playback/dynamic-range";
import { reportDecodeFailure } from "@/lib/playback/decode-capability";
import { isViewerSideFailure } from "@/lib/playback/failure-kind";
import { MediaEngine, type EngineAudioTrack } from "./engine";
import { createRanker, resolvePlayable, startAudio, type AudioChoice, type TitleContext } from "./playable";
import { CapacityError, getSeatKeeper, seatStreamFor, type CapacityReason } from "@/lib/playback/capacity";
import { sourceDelivery, sourceMaxHeight } from "@/lib/playback/source-quality";
import { usePlayerState } from "./store";
import { useSleepTimer } from "./use-sleep-timer";
import { getTitleLanguage, rememberTitleLanguage, titleLanguageKey } from "@/lib/title-language";

/** No first frame within this long means the source is not going to start. */
const START_TIMEOUT_MS = 20_000;
/** Remux sessions open, index and produce their first segment before a frame exists (cold 4K measured at up to ~11s). */
const REMUX_START_TIMEOUT_MS = 25_000;
/** This many rebuffers inside the window means the source cannot keep up, even if each one recovers. */
const REBUFFER_LIMIT = 3;
const REBUFFER_WINDOW_MS = 90_000;
/**
 * Buffering right after a seek is expected and does not count. A remuxed
 * source restarts its converter at the new position and then produces only
 * a little faster than real time, so the first few rebuffers after a long
 * jump are the converter catching up, not a failing server.
 */
const SEEK_GRACE_MS = 15_000;
/**
 * A source that was playing before the seek has proven itself: give the
 * jump this long to land before calling it stalled, and then retry it at the
 * same spot rather than moving to another server or searching again.
 */
const SEEK_STALL_TIMEOUT_MS = 30_000;
const QUALITY_STEPS = [2160, 1440, 1080, 720, 480];
/** Buffering this long with no progress while playing means the server is too slow. */
const STALL_TIMEOUT_MS = 12_000;
/** A retry of a source that was already playing gets less patience than a cold start. */
const RECOVERY_TIMEOUT_MS = 15_000;
const PROGRESS_REPORT_MS = 10_000;
/** Watch time that proves a source works (feeds per-title source memory). */
const SUSTAINED_PLAY_MS = 90_000;
const TIME_UPDATE_MIN_MS = 250;
/** The picture counts as moving again this far past where a jump landed. */
const SEEK_MOVING_S = 0.25;
/** Reported when a file is passed over for having no audio in the wanted language. */
const WRONG_LANGUAGE_REASON = "no audio in the wanted language";

/** The language being heard: a remuxed file's own track, else the element's active one. */
function heardLanguage(s: PlayerState): string | null {
  const remux = s.remuxAudio;
  const remuxTrack = remux ? remux.tracks.find((t) => t.index === remux.active) : undefined;
  const elementTrack = s.audioTracks.find((t) => t.id === s.activeAudio);
  return remuxTrack?.language || elementTrack?.lang || null;
}

/** The language of the subtitles shown, or null while they are off. */
function shownSubtitleLanguage(s: PlayerState): string | null {
  if (!s.activeSubtitle) return null;
  return s.subtitles.find((o) => o.id === s.activeSubtitle)?.language || null;
}

export interface PlayerControllerOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  sources: PlaybackSource[];
  discovering: boolean;
  /** What the server says can still arrive; ends the wait for a better source early. */
  outlook: Outlook;
  remuxAvailable: boolean;
  title: TitleContext;
  initialTime: number;
  audio: AudioChoice;
  /** Title length from the catalog, used until the stream reports its own. */
  fallbackDurationS: number;
  /** The profile's quality choice; the viewer's own pick in the menu overrides it. */
  quality?: PlaybackQualityPreference;
  onProgress(current: number, duration: number): void;
  onEnded(): void;
  onRefreshSources(): void;
}

/**
 * What a seat is asked for, for a source: remuxed here, relayed through this
 * server (a same-origin address), or read by the player straight from its CDN.
 */
function seatStreamOf(source: PlaybackSource, durationS: number) {
  const delivery = sourceDelivery(source) === "remux" ? "remux" : source.url.startsWith("/") ? "web" : "direct";
  return seatStreamFor({ delivery, height: sourceMaxHeight(source), sizeBytes: source.sizeBytes, durationS });
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
  /** This title view's heartbeats and summary (see PlaybackReporter). Kept across a development remount of the same title. */
  const reporterRef = useRef<PlaybackReporter | null>(null);
  const attemptStartedAt = useRef(0);
  /** When the player opened on this title, for what the viewer waited in all. */
  const openedAt = useRef(0);
  /** A jump still waiting for its picture: when it was made and where it landed. */
  const pendingSeek = useRef<{ at: number; target: number } | null>(null);
  const playedOnSourceMs = useRef(0);
  const sustainedReported = useRef(false);
  const lastProgressAt = useRef(0);
  const lastTimeUpdate = useRef(0);
  const positionRef = useRef(options.initialTime);
  const remuxDuration = useRef<number | null>(null);
  /** The preferred audio track is chosen once per attach; after that the viewer's menu choice stands. */
  const audioApplied = useRef(false);
  const qualityPickedByViewer = useRef(false);
  /** One automatic roster refresh is tried before an error is shown. */
  const autoRefreshed = useRef(false);
  /** The viewer paused (not the browser while a source was being swapped). */
  const userPaused = useRef(false);
  /** A source is being attached: pause events now come from the swap, not the viewer. */
  const attaching = useRef(false);
  /** Opens refused for capacity in a row: the seat is asked for again a few times, then the line is shown. */
  const capacityRetries = useRef(0);
  /** What to do when the server stops this stream to protect itself (set below, with the engine). */
  const evictedRef = useRef<(reason: CapacityReason) => void>(() => {});
  /**
   * Where the film was when the server stopped it: kept apart from positionRef, which the emptied player's
   * clock (back at 0) would overwrite, so rejoining picks it up where it stopped.
   */
  const stoppedAt = useRef<number | null>(null);
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
    (reason: string, why = "didn't respond") => {
      const state = orchestrator.current;
      if (state.phase !== "starting") return;
      // Stopped to protect the server: the card says so, and no other server is tried behind it.
      if (getSeatKeeper().evicted) return;
      const source = sourceById(state.activeId);
      if (source) {
        const failure = { event: "handoff_failed" as const, reason, engine: engineRef.current?.kind };
        // The decoder refusing a file may be the device lacking the codec: see reportDecodeFailure.
        if (isViewerSideFailure(failure)) reportDecodeFailure(source.codec);
        emitPlayerFeedback({ event: "handoff_failed", sourceId: source.id, provider: source.provider, reason, engine: engineRef.current?.kind, delivery: deliveryOfSource(source) });
        const name = source.label.split("•")[0]?.trim() || source.provider;
        store.getState().set({ startNote: `${name} ${why}, trying the next server` });
      }
      const { sources, discovering } = optionsRef.current;
      apply(onStartFailed(state, sources, reason, discovering, ranker(), Date.now()));
    },
    [apply, ranker, sourceById]
  );

  /**
   * True when the file about to play has no audio in the language the viewer
   * wants and another source could take its place. Only at the start, and
   * never against a server the viewer chose by hand.
   */
  const isDubToSkip = useCallback(
    (tracks: ReadonlyArray<{ language?: string | null }>, audio: AudioChoice, originalLanguage?: string | null) => {
      const state = orchestrator.current;
      if (state.phase !== "starting" || state.pinned || state.everPlayed) return false;
      const selection = { preference: audio.preference, originalLanguage, preferredLanguage: audio.language };
      if (!lacksWantedAudio(tracks, selection)) return false;
      return hasAlternative(state, optionsRef.current.sources, ranker(), Date.now());
    },
    [ranker]
  );

  const failPlayback = useCallback(
    (reason: string, kind: "error" | "stall") => {
      const state = orchestrator.current;
      if (state.phase === "starting") return startFailed(reason);
      if (state.phase !== "playing" && state.phase !== "recovering") return;
      const source = sourceById(state.activeId);
      if (source) emitPlayerFeedback({ event: "stall", sourceId: source.id, provider: source.provider, reason, engine: engineRef.current?.kind, delivery: deliveryOfSource(source) });
      if (state.retries >= 1) optionsRef.current.onRefreshSources();
      apply(onPlaybackError(state, optionsRef.current.sources, reason, ranker(), Date.now(), kind));
    },
    [apply, ranker, sourceById, startFailed]
  );

  const playbackFailed = useCallback(
    (reason: string, kind: "error" | "stall" = "error") => {
      const seats = getSeatKeeper();
      if (seats.evicted) return;
      // A stream the server stopped to protect itself fails like a broken one, or runs dry like a slow one.
      // The server is asked first (one quick renewal), so the viewer hears why instead of being moved to a
      // worse source.
      if (seats.current) {
        void seats.renew().then((evicted) => {
          if (!evicted) failPlayback(reason, kind);
        });
        return;
      }
      failPlayback(reason, kind);
    },
    [failPlayback]
  );

  const armStall = useCallback(() => {
    if (stallTimer.current) clearTimeout(stallTimer.current);
    const afterSeek = Date.now() - lastSeekAt.current < SEEK_GRACE_MS;
    stallTimer.current = afterSeek
      ? setTimeout(() => playbackFailed("seek stall", "error"), SEEK_STALL_TIMEOUT_MS)
      : setTimeout(() => playbackFailed("stall", "stall"), STALL_TIMEOUT_MS);
  }, [playbackFailed]);

  /**
   * Streams with several audio tracks (Vixsrc marks its Italian dub as the
   * default) open on whatever the provider flagged, so the viewer's language is
   * chosen here: a language picked earlier for this show, else the profile's
   * original-or-English preference.
   */
  const chooseAudioTrack = useCallback(
    (tracks: EngineAudioTrack[], active: number) => {
      if (audioApplied.current || tracks.length === 0) return;
      audioApplied.current = true;
      if (tracks.length < 2) return;
      const { title, audio } = optionsRef.current;
      // As startAudio: a viewer who asked for the original language gets it, whatever was picked here before.
      const remembered = audio.preference === "original" ? undefined : getTitleLanguage(titleLanguageKey(title.mediaType, title.tmdbId))?.audio;
      const base = remembered ? { preference: "preferred" as const, language: remembered } : audio;
      const pick = selectAudioTrack(tracks, {
        preference: base.preference,
        originalLanguage: title.originalLanguage,
        preferredLanguage: base.language,
      });
      if (pick && pick.id !== active) engineRef.current?.setAudioTrack(pick.id);
    },
    []
  );

  const execute = useCallback(
    async (command: Command) => {
      const s = store.getState();
      if (command.type === "wait") {
        s.set({ failureMessage: null });
        if (command.recheckInMs) {
          if (recheckTimer.current) clearTimeout(recheckTimer.current);
          recheckTimer.current = setTimeout(() => {
            recheckTimer.current = null;
            const { sources, discovering, outlook } = optionsRef.current;
            apply(onRoster(orchestrator.current, sources, discovering, ranker(), Date.now(), outlook));
          }, command.recheckInMs);
        }
        return;
      }
      if (command.type === "fail") {
        reporterRef.current?.failed();
        clearTimers();
        if (!autoRefreshed.current) {
          autoRefreshed.current = true;
          orchestrator.current = onAwaitRefresh(orchestrator.current);
          s.set({ phase: "resolving" });
          optionsRef.current.onRefreshSources();
          return;
        }
        engineRef.current?.destroy();
        // Nothing plays behind the failure card: its seat is someone else's to use (Try again asks anew).
        getSeatKeeper().release();
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
      // From here on, errors from the source being replaced are nobody's.
      engine.abandon();
      attachAbort.current?.abort();
      const abort = new AbortController();
      attachAbort.current = abort;
      // A seat on the server first (docs/CAPACITY.md): held already when playing, else asked for, waiting in
      // line while there is none. A better source found meanwhile keeps the place in line.
      let seat: string | null;
      try {
        seat = await getSeatKeeper().acquire(seatStreamOf(source, optionsRef.current.fallbackDurationS), abort.signal);
      } catch {
        // A newer attach took over, or the line is full and the card says so: nothing is tried meanwhile.
        return;
      }
      if (abort.signal.aborted) return;
      reporterRef.current?.attach({ sourceId: source.id, provider: source.provider, delivery: deliveryOfSource(source) });
      const startAt = command.keepPosition ? positionRef.current : optionsRef.current.initialTime;
      // A viewer who paused and then picked another server, quality or audio
      // track expects to stay paused at the same spot.
      const stayPaused = command.keepPosition && userPaused.current && orchestrator.current.everPlayed;
      attaching.current = true;
      pendingSeek.current = null;
      s.set({ buffering: true, failureMessage: null, levels: [], audioTracks: [], currentLevel: -1 });
      attemptStartedAt.current = Date.now();
      sustainedReported.current = false;
      audioApplied.current = false;
      const { title } = optionsRef.current;
      const override = audioOverride.current?.sourceId === source.id ? audioOverride.current.index : undefined;
      // A language picked earlier for this show beats the profile default.
      const baseAudio = startAudio(title, optionsRef.current.audio);
      const audio = override === undefined ? baseAudio : { ...baseAudio, index: override };
      try {
        const resolved = await resolvePlayable(source, title, audio, startAt, video, abort.signal, seat);
        if (abort.signal.aborted) return;
        // The file's own track list is the one sure word on its language: a dub
        // whose name gave nothing away is passed over while anything else can play.
        if (override === undefined && resolved.remuxTracks && isDubToSkip(resolved.remuxTracks.audioTracks, audio, title.originalLanguage)) {
          attaching.current = false;
          startFailed(WRONG_LANGUAGE_REASON, "is in another language");
          return;
        }
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
        await engine.load(resolved.playable, startAt, {
          startHeight: choice === "auto" ? undefined : choice,
          lockLevel: choice !== "auto",
          seekPoints: resolved.seekPoints,
        });
        if (abort.signal.aborted) return;
        video.playbackRate = s.rate;
        attaching.current = false;
        if (stayPaused) {
          clearTimers();
          store.getState().set({ buffering: false, playing: false });
          return;
        }
        video.play().catch((err: unknown) => {
          // Autoplay blocked: show the play button rather than failing the source.
          if (err instanceof DOMException && err.name === "NotAllowedError") {
            clearTimers();
            store.getState().set({ buffering: false, playing: false, autoplayBlocked: true });
          }
        });
      } catch (err) {
        attaching.current = false;
        if (abort.signal.aborted) return;
        if (err instanceof CapacityError) {
          // The server is full, or stopped this viewer's stream: never the source's fault.
          if (err.capacity === "evicted") return evictedRef.current(err.reason);
          // Opened under a seat the server no longer knows: the seat is asked for again (the line, if need be).
          getSeatKeeper().forget();
          if (++capacityRetries.current <= 3) return void executeRef.current(command);
          capacityRetries.current = 0;
          s.set({ capacity: { kind: "full", reason: err.reason, retryAfterS: 15 }, buffering: false });
          return;
        }
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
      onAudioTracks: (audioTracks, activeAudio) => {
        store.getState().set({ audioTracks, activeAudio });
        chooseAudioTrack(audioTracks, activeAudio);
      },
      onFatal: (reason) => playbackFailed(reason),
    });
    engineRef.current = engine;
    const seats = getSeatKeeper();
    // The server stopped this stream to protect itself: it ends here, the place in the film kept, and the card
    // offers the line again. Nothing fails over: another server would only be refused the same way.
    evictedRef.current = (reason: CapacityReason) => {
      stoppedAt.current = positionRef.current;
      const duration = remuxDuration.current ?? (Number.isFinite(video.duration) ? video.duration : 0);
      if (orchestrator.current.everPlayed && duration > 0) optionsRef.current.onProgress(positionRef.current, duration);
      clearTimers();
      attachAbort.current?.abort();
      attaching.current = false;
      engine.destroy();
      const source = sourceById(orchestrator.current.activeId);
      if (source) emitPlayerFeedback({ event: "capacity_stopped", sourceId: source.id, provider: source.provider, reason, engine: engine.kind, delivery: deliveryOfSource(source) });
      store.getState().set({ playing: false, buffering: false, capacity: { kind: "evicted", reason } });
    };
    seats.hold((capacity) => store.getState().set({ capacity }), (reason) => evictedRef.current(reason));
    const onPageHide = (event: PageTransitionEvent) => {
      engine.leave();
      // A page kept for the back button comes back with its film: the seat lapses or is renewed then, not given away.
      if (!event.persisted) seats.release(true);
    };
    window.addEventListener("pagehide", onPageHide);
    const { title } = optionsRef.current;
    const feedbackTitle = { tmdbId: String(title.tmdbId), mediaType: title.mediaType, season: title.season, episode: title.episode };
    setFeedbackTitleContext(feedbackTitle);
    // What a report reads of the player as this engine and element now stand (see PlaybackReporter).
    const readPlayer = (): PlayerReadings => {
      const s = store.getState();
      const stats = engine.stats();
      // Not every browser has the frame counts; a report without them is still a report.
      const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
      return {
        engine: engine.kind,
        paused: video.paused,
        ended: video.ended,
        seeking: video.seeking,
        buffering: s.buffering,
        positionS: video.currentTime,
        durationS: remuxDuration.current || (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : optionsRef.current.fallbackDurationS),
        bufferAheadS: bufferAheadSeconds(video.buffered, video.currentTime),
        decodedWidth: video.videoWidth,
        decodedHeight: video.videoHeight,
        levelBitrateBps: stats.levelBitrateBps,
        declaredBitrateBps: stats.declaredBitrateBps,
        bandwidthBps: stats.bandwidthBps,
        bytesLoaded: stats.fragmentBytes,
        loadMs: stats.fragmentLoadMs,
        droppedFrames: quality ? quality.droppedVideoFrames : null,
        decodedFrames: quality ? quality.totalVideoFrames : null,
        audioLanguage: heardLanguage(s),
        subtitleLanguage: shownSubtitleLanguage(s),
      };
    };
    const reporter = (reporterRef.current ??= new PlaybackReporter());
    reporter.open(readPlayer, feedbackTitle);
    openedAt.current = Date.now();
    pendingSeek.current = null;
    // Mute and full screen carry over from the previous episode (the page stays
    // full screen across episodes); the new element starts from them.
    const carried = { muted: store.getState().muted };
    store.getState().reset();
    store.getState().set({
      rate: getSavedPlaybackSpeed(),
      qualityChoice: getPreferredQualityHeight(),
      fullscreen: Boolean(document.fullscreenElement),
      muted: carried.muted,
    });
    video.volume = store.getState().volume;
    video.muted = carried.muted;
    return () => {
      reportSustained();
      // Leaving the player: record exactly where the viewer stopped, not the
      // last periodic report (which can be seconds or a whole seek behind).
      const duration = remuxDuration.current ?? (Number.isFinite(video.duration) ? video.duration : 0);
      if (orchestrator.current.everPlayed && duration > 0) optionsRef.current.onProgress(positionRef.current, duration);
      clearTimers();
      attachAbort.current?.abort();
      window.removeEventListener("pagehide", onPageHide);
      // Read while the engine still stands; the summary follows a moment later unless another title takes over first.
      reporterRef.current?.close();
      engine.destroy();
      engineRef.current = null;
      // The seat outlives this player a little, so the next episode takes it over rather than queueing again.
      seats.letGo();
      clearFeedbackTitleContext();
    };
  }, [videoRef, store, playbackFailed, clearTimers, reportSustained, chooseAudioTrack, sourceById]);

  // The profile's quality, once the server has confirmed it, unless the viewer already picked one.
  const profileQuality = options.quality;
  useEffect(() => {
    if (profileQuality === undefined || qualityPickedByViewer.current) return;
    store.getState().set({ qualityChoice: profileQuality });
  }, [profileQuality, store]);

  // Media element events.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const s = () => store.getState();
    let lastTick = performance.now();

    const onPlaying = () => {
      // While another source is being opened, the element still plays the one
      // it replaces. Its frame is not the new source's first.
      if (attaching.current) return;
      reporterRef.current?.playing();
      getSeatKeeper().setPlaying(true);
      capacityRetries.current = 0;
      s().set({ playing: true, buffering: false, autoplayBlocked: false });
      if (stallTimer.current) clearTimeout(stallTimer.current);
      // A first frame always settles the attach's start timer, whatever the
      // phase: re-attaching the same source (a remux audio switch) keeps the
      // phase at "playing", and the timer then failed a working server later.
      if (startTimer.current && video.videoWidth > 0) {
        clearTimeout(startTimer.current);
        startTimer.current = null;
      }
      const phase = orchestrator.current.phase;
      if ((phase === "starting" || phase === "recovering") && video.videoWidth > 0) {
        clearTimers();
        const source = sourceById(orchestrator.current.activeId);
        const firstOfTitle = !orchestrator.current.everPlayed;
        reporterRef.current?.picture(firstOfTitle ? Date.now() - openedAt.current : null);
        orchestrator.current = onFirstFrame(orchestrator.current, Date.now());
        s().set({ phase: "playing", decodedHeight: video.videoHeight, startNote: null });
        // A file played directly says nothing about its range: ask the picture itself.
        if (!isHdrLikeRange(s().dynamicRange)) {
          const seen = videoFrameRange(video);
          if (seen) s().set({ dynamicRange: seen });
        }
        if (source && phase === "starting") {
          emitPlayerFeedback({
            event: "first_frame",
            sourceId: source.id,
            provider: source.provider,
            timeToFirstFrameMs: Date.now() - attemptStartedAt.current,
            ...(firstOfTitle ? { sinceOpenMs: Date.now() - openedAt.current } : {}),
            decodedHeight: video.videoHeight,
            decodedWidth: video.videoWidth,
            engine: engineRef.current?.kind,
            delivery: deliveryOfSource(source),
          });
        }
      }
    };
    const onTimeUpdate = () => {
      // Stopped by the server: the emptied element's clock says 0, which is not where the viewer was.
      if (stoppedAt.current !== null) return;
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
      const jump = pendingSeek.current;
      // Paused meanwhile: the wait from here on is the viewer's own.
      if (jump && video.paused) pendingSeek.current = null;
      else if (jump && !video.seeking && t > jump.target + SEEK_MOVING_S) {
        pendingSeek.current = null;
        const source = sourceById(orchestrator.current.activeId);
        if (source) emitPlayerFeedback({ event: "seek", sourceId: source.id, provider: source.provider, seekMs: Math.round(now - jump.at), engine: engineRef.current?.kind, delivery: deliveryOfSource(source) });
      }
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
      // A wait is a stall only after the first picture, and not while a jump (or the grace after one) is what it waits for.
      const stall = !attaching.current && orchestrator.current.phase === "playing" && !video.seeking && Date.now() - lastSeekAt.current >= SEEK_GRACE_MS;
      reporterRef.current?.waiting(stall);
      // Viewers' stalls tell the server it is at its limit (see the governor's "playback" reading).
      if (stall) getSeatKeeper().noteStall();
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
    // A jump is a meaningful new position: save it without waiting for the next report.
    const onSeeked = () => {
      reporterRef.current?.seekDone(!video.paused && !video.ended);
      const duration = effectiveDuration(video);
      if (orchestrator.current.everPlayed && duration > 0) {
        lastProgressAt.current = Date.now();
        optionsRef.current.onProgress(video.currentTime, duration);
      }
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
      getSeatKeeper().setPlaying(false);
      reporterRef.current?.paused();
      // Paused by the viewer: buffering that was in progress is no longer a stall.
      if (stallTimer.current) {
        clearTimeout(stallTimer.current);
        stallTimer.current = null;
      }
      if (!attaching.current && !video.ended) userPaused.current = true;
      const duration = effectiveDuration(video);
      if (orchestrator.current.everPlayed && duration > 0) optionsRef.current.onProgress(video.currentTime, duration);
    };
    const onMeta = () => s().set({ duration: effectiveDuration(video) });
    const onEnded = () => {
      s().set({ playing: false });
      reporterRef.current?.ended();
      optionsRef.current.onEnded();
    };
    const onPlay = () => {
      userPaused.current = false;
    };
    const onError = () => engineRef.current?.mediaElementFailed();
    // The sleep timer's fade lowers the element's volume; the viewer's own
    // level (shown on the slider and saved for next time) stays as it was.
    const onVolume = () =>
      useSleepTimer.getState().fading ? s().set({ muted: video.muted }) : s().set({ volume: video.volume, muted: video.muted });
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
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
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
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("durationchange", onMeta);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
      video.removeEventListener("volumechange", onVolume);
      video.removeEventListener("ratechange", onRate);
    };
  }, [videoRef, store, armStall, clearTimers, playbackFailed, reportSustained, sourceById]);

  // Roster changes: start when nothing is running; never switch a running source.
  const { sources, discovering, outlook } = options;
  useEffect(() => {
    apply(onRoster(orchestrator.current, sources, discovering, ranker(), Date.now(), outlook));
  }, [sources, discovering, outlook, apply, ranker]);

  const actions = useMemo(() => {
    const video = () => videoRef.current;
    const seek = (time: number) => {
      const v = video();
      if (!v) return;
      reporterRef.current?.seeked();
      const duration = store.getState().duration || v.duration;
      const wanted = Math.max(0, Math.min(time, (duration || time) - 0.5));
      const target = engineRef.current?.seekTarget(wanted) ?? wanted;
      // Timed only while playing: a jump made before the first picture is part of the start.
      pendingSeek.current = orchestrator.current.phase === "playing" && !v.paused ? { at: performance.now(), target } : null;
      v.currentTime = target;
      positionRef.current = target;
      store.getState().set({ currentTime: target });
    };
    return {
      togglePlay() {
        const v = video();
        if (!v) return;
        if (v.paused) void v.play().catch(() => {});
        else v.pause();
      },
      seek,
      // Not `this.seek`: these are handed around as plain functions (media keys, timers).
      seekBy(delta: number) {
        const v = video();
        if (v) seek(v.currentTime + delta);
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
        qualityPickedByViewer.current = true;
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
        const track = store.getState().audioTracks.find((t) => t.id === id);
        const language = normalizeTrackLanguage(track?.lang);
        if (language) {
          const { title } = optionsRef.current;
          rememberTitleLanguage(titleLanguageKey(title.mediaType, title.tmdbId), { audio: language });
        }
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
      /** The engine playing the file now (hlsjs, native_hls or native_file), or null before one is loaded. For a viewer's report. */
      engineKind: () => engineRef.current?.kind ?? null,
      retry() {
        orchestrator.current = onRetryAll(orchestrator.current);
        optionsRef.current.onRefreshSources();
        apply(onRoster(orchestrator.current, optionsRef.current.sources, true, ranker(), Date.now()));
      },
      /** After a full line or a stopped stream: joins the line again, to start where the viewer was. */
      rejoin() {
        getSeatKeeper().clearEviction();
        store.getState().set({ capacity: { kind: "none" }, buffering: true });
        // Back where the film stopped, not where the emptied player's clock says.
        if (stoppedAt.current !== null) positionRef.current = stoppedAt.current;
        stoppedAt.current = null;
        const sourceId = orchestrator.current.activeId;
        if (sourceId) executeRef.current({ type: "attach", sourceId, keepPosition: orchestrator.current.everPlayed, refresh: false });
        else apply(onRoster(orchestrator.current, optionsRef.current.sources, optionsRef.current.discovering, ranker(), Date.now()));
      },
    };
  }, [apply, ranker, sourceById, store, videoRef]);

  return actions;
}

export type PlayerActions = ReturnType<typeof usePlayerController>;

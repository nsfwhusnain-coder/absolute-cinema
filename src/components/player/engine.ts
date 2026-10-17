/**
 * MediaEngine — attaches one playable stream to the <video> element.
 *
 * HLS goes through hls.js wherever Media Source Extensions exist (including
 * iOS 17.1+ via ManagedMediaSource), and through the browser's own HLS stack
 * otherwise (older iOS, some TVs, HEVC on TVs whose MSE rejects it). Plain
 * files play through <video src>. Every path reports the same events, so the
 * player behaves the same on every browser.
 *
 * Low-level recovery lives here: one network restart and one media-error
 * recovery per attach before a failure is reported upward, where the
 * orchestrator decides between retrying and switching sources.
 */

import { leaveRemuxSession, remuxSessionIdOf } from "@/lib/playback/remux-leave";
import type HlsType from "hls.js";
import type { ErrorData, Level, MediaPlaylist } from "hls.js";
import { BufferBudget } from "@/lib/playback/buffer-budget";
import { activeBufferProfile } from "@/lib/playback/device-profile";
import { HLS_WORKER_PATH, hlsWorkerSupportedHere } from "@/lib/playback/player-engine";
import { seekPointAtOrBefore, snapSeek } from "@/lib/playback/seek-points";

export interface Playable {
  kind: "hls" | "file";
  url: string;
  /**
   * The same stream cut into slices shorter than its keyframe interval. Only
   * hls.js can play it: it appends whatever arrives, where the browser's own
   * HLS player wants every entry to open on a keyframe.
   */
  slicedUrl?: string;
  /** Force the browser's own HLS stack. */
  nativeHls?: boolean;
  /** Same-origin stream that needs the session cookie. */
  withCredentials?: boolean;
  /** The file's average bitrate in bits per second, when the server knows it (a remux does). */
  declaredBitrateBps?: number;
  /** The file's longest gap between keyframes in seconds, when the server knows it (a remux does). */
  keyframeGapS?: number;
}

export interface QualityLevel {
  index: number;
  height: number;
  bitrate: number;
  /** hls.js VIDEO-RANGE: SDR, PQ or HLG. */
  videoRange?: string;
}

export interface EngineAudioTrack {
  id: number;
  name: string;
  lang: string;
  /** The stream's own default, which providers often set to a dub. */
  default: boolean;
}

export interface EngineHandlers {
  onLevels(levels: QualityLevel[]): void;
  onLevelSwitched(index: number): void;
  onAudioTracks(tracks: EngineAudioTrack[], active: number): void;
  onFatal(reason: string): void;
}

const MANIFEST_TIMEOUT_MS = 20_000;
/**
 * Opening rendition when the viewer has not chosen a quality: the top of the
 * ladder. Opening on 1080p and waiting for adaptive switching to climb meant a
 * 4K-capable stream often never left 1080p; it still drops if the connection
 * cannot sustain the top rung.
 */
export const DEFAULT_START_HEIGHT = 2160;

export interface LoadOptions {
  /** Rendition to open on: the highest at or below it. */
  startHeight?: number;
  /** Keep to the opening rendition instead of adapting (the viewer asked for that quality). */
  lockLevel?: boolean;
  /** Times a sliced stream may be entered at. */
  seekPoints?: readonly number[];
}
/**
 * Automatic quality never picks renditions below this. Embed CDNs that take
 * seconds to send each segment's first byte drag hls.js's bandwidth estimate
 * down to tiny renditions it is slow to leave; a connection that genuinely
 * cannot carry this is handled by moving to another server instead.
 */
const MIN_AUTO_BITRATE_BPS = 1_200_000;
const FRAG_TIMEOUT_MS = 30_000;

export type EngineKind = "hlsjs" | "native_hls" | "native_file";

export class MediaEngine {
  private hls: HlsType | null = null;
  private generation = 0;
  private networkRecoveries = 0;
  private mediaRecoveries = 0;
  private abandoned = false;
  /** The remux session behind what is loaded, so the server can be told when it is done with. */
  private remuxId: string | null = null;
  /** Set while a sliced stream is attached: jumps then land on these times. */
  private seekPoints: readonly number[] | null = null;
  kind: EngineKind = "native_file";

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly handlers: EngineHandlers
  ) {}

  /**
   * Tears down whatever was playing and starts `playable` at `startAt` seconds.
   * Adaptive switching takes over from the opening rendition unless the
   * viewer's quality is locked.
   */
  async load(playable: Playable, startAt: number, options: LoadOptions = {}): Promise<void> {
    const startHeight = options.startHeight ?? DEFAULT_START_HEIGHT;
    this.teardown();
    this.moveTo(remuxSessionIdOf(playable.url));
    const generation = ++this.generation;
    this.abandoned = false;
    this.seekPoints = null;
    this.networkRecoveries = 0;
    this.mediaRecoveries = 0;
    const video = this.video;

    if (playable.kind === "file") {
      this.kind = "native_file";
      video.src = playable.url;
      this.seekWhenReady(startAt, generation);
      video.load();
      return;
    }

    const Hls = (await import("hls.js")).default;
    if (generation !== this.generation) return;
    const useHlsJs = !playable.nativeHls && Hls.isSupported();
    if (!useHlsJs) {
      this.kind = "native_hls";
      video.src = playable.url;
      this.seekWhenReady(startAt, generation);
      this.reportNativeAudio(generation);
      video.load();
      return;
    }

    this.kind = "hlsjs";
    const sliced = Boolean(playable.slicedUrl && options.seekPoints?.length);
    if (sliced) {
      this.seekPoints = options.seekPoints!;
      startAt = seekPointAtOrBefore(this.seekPoints, startAt);
    }
    const profile = activeBufferProfile();
    const budget = new BufferBudget(profile, playable.declaredBitrateBps, playable.keyframeGapS);
    const initial = budget.lengths();
    const hls = new Hls({
      enableWorker: hlsWorkerSupportedHere(),
      workerPath: HLS_WORKER_PATH,
      lowLatencyMode: false,
      startPosition: startAt > 0 ? startAt : -1,
      testBandwidth: false,
      // Off so the opening rendition chosen below is the one fetched first.
      startFragPrefetch: false,
      capLevelToPlayerSize: false,
      abrEwmaDefaultEstimate: profile.abrInitialEstimateBps,
      abrMaxWithRealBitrate: true,
      minAutoBitrate: MIN_AUTO_BITRATE_BPS,
      maxBufferLength: initial.maxBufferLengthS,
      maxMaxBufferLength: initial.maxMaxBufferLengthS,
      maxBufferSize: initial.maxBufferSize,
      backBufferLength: initial.backBufferLengthS,
      maxBufferHole: 0.8,
      nudgeMaxRetry: 8,
      manifestLoadingTimeOut: MANIFEST_TIMEOUT_MS,
      manifestLoadingMaxRetry: 2,
      levelLoadingTimeOut: MANIFEST_TIMEOUT_MS,
      levelLoadingMaxRetry: 3,
      fragLoadingTimeOut: FRAG_TIMEOUT_MS,
      fragLoadingMaxRetry: 4,
      xhrSetup: (xhr) => {
        if (playable.withCredentials) xhr.withCredentials = true;
      },
    });
    // Captions are drawn by the player; a default track must never be shown natively as well.
    hls.subtitleDisplay = false;
    this.hls = hls;

    // The buffer's length follows the bytes per second actually loaded, so it stays under what the browser holds.
    const applyBudget = () => {
      const lengths = budget.lengths();
      hls.config.maxBufferLength = lengths.maxBufferLengthS;
      hls.config.maxMaxBufferLength = lengths.maxMaxBufferLengthS;
      hls.config.backBufferLength = lengths.backBufferLengthS;
      hls.config.maxBufferSize = lengths.maxBufferSize;
    };
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      if (generation !== this.generation) return;
      // Open on a sharp rendition instead of hls.js's cautious lowest-first
      // guess; ABR still drops lower if the connection cannot sustain it.
      const start = openingLevel(data.levels, startHeight);
      if (start >= 0) hls.startLevel = start;
      if (start >= 0 && options.lockLevel) hls.nextLevel = start;
      // A web stream's manifest states its opening rendition's bitrate, which the budget uses until a segment is measured.
      if (start >= 0) budget.seed(data.levels[start]!.bitrate);
      applyBudget();
      this.handlers.onLevels(toLevels(data.levels));
    });
    hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
      if (generation !== this.generation) return;
      budget.observe(data.frag.stats.total, data.frag.duration);
      applyBudget();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      if (generation === this.generation) this.handlers.onLevelSwitched(data.level);
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_e, data) => {
      if (generation === this.generation) this.handlers.onAudioTracks(toAudio(data.audioTracks), hls.audioTrack);
    });
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => {
      if (generation === this.generation) this.handlers.onAudioTracks(toAudio(hls.audioTracks), hls.audioTrack);
    });
    hls.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
      if (generation !== this.generation) return;
      // The remuxer has said this file cannot be served from here. hls.js
      // would ask again, with growing pauses, and be told the same each time.
      if (isRemuxRefusal(data)) {
        this.handlers.onFatal(`remux:${data.response?.code}`);
        return;
      }
      if (data.details === Hls.ErrorDetails.BUFFER_FULL_ERROR) {
        budget.full();
        applyBudget();
      }
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.networkRecoveries < 1) {
        this.networkRecoveries++;
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries < 1) {
        this.mediaRecoveries++;
        hls.recoverMediaError();
        return;
      }
      this.handlers.onFatal(`hls:${data.details}`);
    });

    hls.attachMedia(video);
    hls.loadSource(sliced ? playable.slicedUrl! : playable.url);
  }

  /**
   * Where a jump to `to` should go. In a sliced stream a time not yet
   * buffered can only be reached from the keyframe before it; anything
   * buffered, and every other kind of stream, is reached directly.
   */
  seekTarget(to: number): number {
    if (!this.seekPoints || isBuffered(this.video, to)) return to;
    return snapSeek(this.seekPoints, this.video.currentTime, to);
  }

  /**
   * Stops listening to whatever is attached, without stopping it: another
   * source is about to take its place. Opening that one takes a moment
   * (seconds, for a remux), and a failing source goes on raising errors for
   * as long as it is attached. They used to be taken for the next source's,
   * which was failed before it had loaded, and playback fell two servers down
   * for one bad file.
   */
  abandon(): void {
    this.generation++;
    this.abandoned = true;
  }

  /** Error on the element itself (all engines). */
  mediaElementFailed(): void {
    // Loading a source clears the element's error: an event that finds none
    // is a late one about the source before.
    if (this.abandoned || !this.video.error) return;
    if (this.kind === "hlsjs" && this.hls && this.mediaRecoveries < 1) {
      this.mediaRecoveries++;
      this.hls.recoverMediaError();
      return;
    }
    this.handlers.onFatal(`media:${this.video.error?.code ?? "unknown"}`);
  }

  setLevel(index: number): void {
    if (!this.hls) return;
    // Next fragment switch keeps what is buffered; -1 = automatic.
    this.hls.nextLevel = index;
    if (index === -1) this.hls.currentLevel = -1;
  }

  get autoLevel(): boolean {
    return this.hls ? this.hls.autoLevelEnabled : true;
  }

  setAudioTrack(id: number): void {
    if (this.hls) {
      this.hls.audioTrack = id;
      return;
    }
    const list = nativeAudioTracks(this.video);
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i]!.enabled = i === id;
    this.handlers.onAudioTracks(toNativeAudio(list), id);
  }

  destroy(): void {
    this.generation++;
    this.teardown();
    this.moveTo(null);
  }

  /** The page is going away with a remux session still loaded. */
  leave(): void {
    if (this.remuxId) leaveRemuxSession(this.remuxId);
  }

  /** Lets go of the remux session that was loaded, unless `next` is the same one loaded again. */
  private moveTo(next: string | null): void {
    if (this.remuxId && this.remuxId !== next) leaveRemuxSession(this.remuxId);
    this.remuxId = next;
  }

  private teardown(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    const video = this.video;
    if (video.getAttribute("src")) {
      video.removeAttribute("src");
      video.load();
    }
  }

  /** Safari's own HLS player exposes the stream's audio tracks on the element. */
  private reportNativeAudio(generation: number): void {
    const video = this.video;
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (generation !== this.generation) return;
        const list = nativeAudioTracks(video);
        if (!list || list.length === 0) return;
        const tracks = toNativeAudio(list);
        this.handlers.onAudioTracks(tracks, Math.max(0, tracks.findIndex((t) => t.default)));
      },
      { once: true }
    );
  }

  private seekWhenReady(startAt: number, generation: number): void {
    if (startAt <= 0) return;
    const video = this.video;
    const apply = () => {
      if (generation !== this.generation) return;
      try {
        video.currentTime = startAt;
      } catch {
        /* not seekable yet — next metadata event will retry */
      }
    };
    video.addEventListener("loadedmetadata", apply, { once: true });
  }
}

/** Statuses the remuxer answers with when a source is beyond serving (a busy or slow one answers 503 or 504, and is asked again). */
const REMUX_REFUSALS: readonly number[] = [415, 502];

function isRemuxRefusal(data: ErrorData): boolean {
  const code = data.response?.code;
  return code !== undefined && REMUX_REFUSALS.includes(code) && (data.url ?? data.frag?.url ?? "").includes("/api/vod/");
}

/** A little slack at the edges, so a time on the last buffered frame still counts. */
const BUFFERED_EDGE_S = 0.25;

function isBuffered(video: HTMLVideoElement, time: number): boolean {
  for (let i = 0; i < video.buffered.length; i++) {
    if (time >= video.buffered.start(i) && time <= video.buffered.end(i) - BUFFERED_EDGE_S) return true;
  }
  return false;
}

/** Index of the highest rendition at or below `height` (the lowest one if none are). */
export function openingLevel(levels: readonly { height: number }[], height: number): number {
  let best = -1;
  levels.forEach((level, index) => {
    if (level.height > 0 && level.height <= height && (best < 0 || level.height > levels[best]!.height)) best = index;
  });
  if (best >= 0) return best;
  let lowest = -1;
  levels.forEach((level, index) => {
    if (lowest < 0 || level.height < levels[lowest]!.height) lowest = index;
  });
  return lowest;
}

function toLevels(levels: Level[]): QualityLevel[] {
  return levels.map((level, index) => ({
    index,
    height: level.height || 0,
    bitrate: level.bitrate || 0,
    videoRange: level.videoRange,
  }));
}

function toAudio(tracks: MediaPlaylist[]): EngineAudioTrack[] {
  return tracks.map((track) => ({
    id: track.id,
    name: track.name || track.lang || `Track ${track.id + 1}`,
    lang: track.lang || "",
    default: Boolean(track.default),
  }));
}

interface NativeAudioTrackList {
  length: number;
  [index: number]: { enabled: boolean; label: string; language: string } | undefined;
}

function nativeAudioTracks(video: HTMLVideoElement): NativeAudioTrackList | null {
  return (video as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }).audioTracks ?? null;
}

function toNativeAudio(list: NativeAudioTrackList): EngineAudioTrack[] {
  const tracks: EngineAudioTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const track = list[i]!;
    tracks.push({ id: i, name: track.label || track.language || `Track ${i + 1}`, lang: track.language || "", default: track.enabled });
  }
  return tracks;
}

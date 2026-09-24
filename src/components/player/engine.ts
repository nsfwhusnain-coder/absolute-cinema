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

import type HlsType from "hls.js";
import type { ErrorData, Level, MediaPlaylist } from "hls.js";
import { activeBufferProfile } from "@/lib/playback/device-profile";
import { HLS_WORKER_PATH, hlsWorkerSupportedHere } from "@/lib/playback/player-engine";

export interface Playable {
  kind: "hls" | "file";
  url: string;
  /** Force the browser's own HLS stack. */
  nativeHls?: boolean;
  /** Same-origin stream that needs the session cookie. */
  withCredentials?: boolean;
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
}

export interface EngineHandlers {
  onLevels(levels: QualityLevel[]): void;
  onLevelSwitched(index: number): void;
  onAudioTracks(tracks: EngineAudioTrack[], active: number): void;
  onFatal(reason: string): void;
}

const MANIFEST_TIMEOUT_MS = 20_000;
/** Opening rendition when the viewer has not chosen a quality. */
export const DEFAULT_START_HEIGHT = 1080;
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
  kind: EngineKind = "native_file";

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly handlers: EngineHandlers
  ) {}

  /**
   * Tears down whatever was playing and starts `playable` at `startAt` seconds.
   * `startHeight` is the rendition to open on (the highest at or below it);
   * adaptive switching takes over from there.
   */
  async load(playable: Playable, startAt: number, startHeight = DEFAULT_START_HEIGHT): Promise<void> {
    this.teardown();
    const generation = ++this.generation;
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
      video.load();
      return;
    }

    this.kind = "hlsjs";
    const profile = activeBufferProfile();
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
      maxBufferLength: profile.maxBufferLengthS,
      maxMaxBufferLength: profile.maxMaxBufferLengthS,
      maxBufferSize: profile.maxBufferSizeBytes,
      backBufferLength: profile.backBufferLengthS,
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
    this.hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      if (generation !== this.generation) return;
      // Open on a sharp rendition instead of hls.js's cautious lowest-first
      // guess; ABR still drops lower if the connection cannot sustain it.
      const start = openingLevel(data.levels, startHeight);
      if (start >= 0) hls.startLevel = start;
      this.handlers.onLevels(toLevels(data.levels));
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
      if (generation !== this.generation || !data.fatal) return;
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
    hls.loadSource(playable.url);
  }

  /** Error on the element itself (all engines). */
  mediaElementFailed(): void {
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
    if (this.hls) this.hls.audioTrack = id;
  }

  destroy(): void {
    this.generation++;
    this.teardown();
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
  return tracks.map((track) => ({ id: track.id, name: track.name || track.lang || `Track ${track.id + 1}`, lang: track.lang || "" }));
}

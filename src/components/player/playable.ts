import type { PlaybackSource } from "@/lib/playback/types";
import { decidePlayback, withoutWebFallbacks } from "@/lib/playback/decide-playback";
import { bitrateSustainabilityRank, isSourcePlayableHere, sourceDelivery, sourceMaxHeight } from "@/lib/playback/source-quality";
import { preferNativeHls } from "@/lib/playback/player-engine";
import { supportsDolbyVision } from "@/lib/playback/decode-capability";
import type { Ranker } from "@/lib/playback/orchestrator";
import type { Playable } from "./engine";
import type { RemuxAudioTrack, StreamSubtitleTrack } from "./store";
import { timeoutSignal } from "@/lib/abort";
import { getTitleLanguage, titleLanguageKey } from "@/lib/title-language";

export interface TitleContext {
  tmdbId: number;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
  originalLanguage?: string | null;
}

export interface AudioChoice {
  preference: "original" | "english" | "preferred";
  language: string;
  /** A specific track of a remuxed file the viewer picked; overrides the preference. */
  index?: number;
}

/** Sources the browser on this device can play at all. */
export function playableHere(sources: readonly PlaybackSource[], remuxAvailable: boolean): PlaybackSource[] {
  return sources.filter((s) => {
    if (s.type === "dash") return false;
    if (!isSourcePlayableHere(s)) return false;
    return remuxAvailable || sourceDelivery(s) !== "remux";
  });
}

/**
 * Ranks for the viewer's quality choice. "auto" takes the best playable
 * source; a height narrows to sources at that height (or the closest below)
 * before ranking, so choosing 1080p never quietly starts a 4K stream.
 */
/**
 * The server has reason to doubt this source: its probe failed, its provider
 * is cooling down, or its CDN was measured too slow to carry it. The last
 * matters most in the first answer for a title, which can hold nothing else:
 * started then, the file is never left for the better one a moment behind it.
 */
export function isSuspect(source: PlaybackSource, now = Date.now()): boolean {
  if (source.probe?.ok === false || bitrateSustainabilityRank(source) < 0) return true;
  return (source.runtimeHealth?.cooldownUntil ?? 0) > now;
}

/**
 * Best (auto) aims for 4K: a start below it waits while discovery may still
 * find one (see START_WAIT_MS). Capping this at 1080 let whichever 1080p
 * source answered first win the start, so one episode played 4K and the
 * next did not.
 */
const BEST_START_HEIGHT = 2160;

export function createRanker(quality: "auto" | number, remuxAvailable: boolean, preferredProvider: string): Ranker {
  return {
    targetHeight: quality === "auto" ? BEST_START_HEIGHT : Math.min(quality, BEST_START_HEIGHT),
    isSuspect: (source) => isSuspect(source),
    pick(candidates) {
      const playable = playableHere(candidates, remuxAvailable);
      if (!playable.length) return null;
      // Sources the server has seen failing are a last resort, not a first try.
      const healthy = playable.filter((s) => !isSuspect(s));
      // A web stream never leads a healthy debrid file of 1080p or better, whatever its height.
      const pool = healthy.length ? withoutWebFallbacks(healthy) : playable;
      let narrowed = pool;
      if (quality !== "auto") {
        const heights = [...new Set(pool.map(sourceMaxHeight))].filter((h) => h > 0 && h <= quality);
        const target = heights.length ? Math.max(...heights) : null;
        if (target !== null) narrowed = pool.filter((s) => sourceMaxHeight(s) === target);
      }
      return (
        decidePlayback(narrowed, { preferredHeight: quality, fourKStartup: "fast", preferredProvider, remuxAvailable })
          .immediate ?? narrowed[0] ?? null
      );
    },
  };
}

/** Quality choices offered in the menu: every distinct playable height, best first. */
export function qualityChoices(sources: readonly PlaybackSource[], remuxAvailable: boolean): number[] {
  const heights = new Set<number>();
  for (const s of playableHere(sources, remuxAvailable)) {
    const h = sourceMaxHeight(s);
    if (h >= 360) heights.add(normalizeHeight(h));
  }
  return [...heights].sort((a, b) => b - a);
}

const HEIGHT_RUNGS = [360, 480, 720, 1080, 1440, 2160] as const;
/** A wide (2.39:1) picture is only about three quarters as tall as its nominal rung, never much taller than it. */
const RUNG_MIN_SHARE = 0.72;
const RUNG_MAX_SHARE = 1.05;

/**
 * Snap a picture height to the quality it is sold as: the smallest rung it
 * does not exceed (give or take rounding), so a 2.39:1 1080p picture reported
 * as 802 lines is "1080p". The old snap took the largest rung the height was
 * within 70% of, which called every ordinary 1080-line stream "1440p".
 */
export function normalizeHeight(height: number): number {
  const rung = HEIGHT_RUNGS.find((r) => height <= r * RUNG_MAX_SHARE);
  if (rung === undefined) return HEIGHT_RUNGS[HEIGHT_RUNGS.length - 1];
  return height >= rung * RUNG_MIN_SHARE ? rung : height;
}

export function qualityLabel(height: number): string {
  if (height >= 2160) return "4K";
  return `${height}p`;
}

export interface ResolvedPlayable {
  playable: Playable;
  /** True length when the server knows it (remux). */
  durationS?: number;
  /** SDR, PQ (HDR10), HLG or DV (Dolby Vision) when the server read it from the file. */
  dynamicRange?: string;
  remux: boolean;
  /** Times a jump may land on when the stream is played in slices (see seek-points.ts). */
  seekPoints?: number[];
  /** Subtitle and audio tracks inside a remuxed file. */
  remuxTracks?: {
    subtitleBase: string;
    subtitles: StreamSubtitleTrack[];
    audioTracks: RemuxAudioTrack[];
    audioIndex: number | null;
  };
}

const VOD_OPEN_TIMEOUT_MS = 15_000;

/**
 * The audio a title starts with: a language the viewer picked for this show
 * before, else the profile's choice.
 */
export function startAudio(title: TitleContext, profile: AudioChoice): AudioChoice {
  const remembered = getTitleLanguage(titleLanguageKey(title.mediaType, title.tmdbId))?.audio;
  return remembered ? { preference: "preferred", language: remembered } : profile;
}

/**
 * The /api/vod/open query for a source. The player and the prewarm before
 * Play both build it here: the server keys a session on these values, so the
 * two must agree to the letter or the prewarm warms a session nobody uses.
 */
export function remuxOpenQuery(source: PlaybackSource, title: TitleContext, audio: AudioChoice, startAt: number): URLSearchParams {
  const params = new URLSearchParams({
    type: title.mediaType,
    id: String(title.tmdbId),
    sourceId: source.id,
    startAt: String(Math.floor(startAt)),
    audioPreference: audio.preference,
    audioLanguage: audio.language,
  });
  if (audio.index !== undefined) params.set("audioIndex", String(audio.index));
  if (source.remuxTicket) params.set("ticket", source.remuxTicket);
  if (title.season != null) params.set("season", String(title.season));
  if (title.episode != null) params.set("episode", String(title.episode));
  if (title.originalLanguage) params.set("originalLanguage", title.originalLanguage);
  if (supportsDolbyVision()) params.set("dolbyVision", "1");
  return params;
}

/** Turns a source into something the engine can load (opening a remux session when needed). */
export async function resolvePlayable(
  source: PlaybackSource,
  title: TitleContext,
  audio: AudioChoice,
  startAt: number,
  video: HTMLVideoElement,
  signal: AbortSignal
): Promise<ResolvedPlayable> {
  const sameOrigin = source.url.startsWith("/");
  if (sourceDelivery(source) === "remux") {
    const params = remuxOpenQuery(source, title, audio, startAt);
    const timeout = timeoutSignal(VOD_OPEN_TIMEOUT_MS, signal);
    const res = await fetch(`/api/vod/open?${params}`, { signal: timeout.signal }).finally(timeout.done);
    const body = (await res.json().catch(() => ({}))) as {
      playlistUrl?: string;
      slicedPlaylistUrl?: string;
      seekPoints?: number[];
      durationS?: number;
      bitrateBps?: number | null;
      dynamicRange?: string;
      audioIndex?: number | null;
      audioTracks?: RemuxAudioTrack[];
      subtitles?: StreamSubtitleTrack[];
      subtitleBase?: string;
      error?: string;
    };
    if (!res.ok || !body.playlistUrl) throw new Error(body.error || `remux open failed (${res.status})`);
    return {
      playable: {
        kind: "hls",
        url: body.playlistUrl,
        ...(body.slicedPlaylistUrl && body.seekPoints?.length ? { slicedUrl: body.slicedPlaylistUrl } : {}),
        ...(body.bitrateBps ? { declaredBitrateBps: body.bitrateBps } : {}),
        withCredentials: true,
        nativeHls: preferNativeHls(video, source),
      },
      seekPoints: body.seekPoints,
      durationS: body.durationS,
      dynamicRange: body.dynamicRange,
      remux: true,
      remuxTracks: {
        subtitleBase: body.subtitleBase ?? "",
        subtitles: body.subtitles ?? [],
        audioTracks: body.audioTracks ?? [],
        audioIndex: body.audioIndex ?? null,
      },
    };
  }
  if (source.type === "hls") {
    return {
      playable: { kind: "hls", url: source.url, withCredentials: sameOrigin, nativeHls: preferNativeHls(video, source) },
      remux: false,
    };
  }
  return { playable: { kind: "file", url: source.url }, remux: false };
}

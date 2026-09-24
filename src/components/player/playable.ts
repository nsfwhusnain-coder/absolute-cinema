import type { PlaybackSource } from "@/lib/playback/types";
import { decidePlayback } from "@/lib/playback/decide-playback";
import { isSourcePlayableHere, sourceDelivery, sourceMaxHeight } from "@/lib/playback/source-quality";
import { preferNativeHls } from "@/lib/playback/player-engine";
import type { Ranker } from "@/lib/playback/orchestrator";
import type { Playable } from "./engine";

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
/** The server has seen this source fail recently: its probe failed or its provider is cooling down. */
export function isSuspect(source: PlaybackSource, now = Date.now()): boolean {
  if (source.probe?.ok === false) return true;
  return (source.runtimeHealth?.cooldownUntil ?? 0) > now;
}

/** A start below this waits briefly for something better (see LOW_QUALITY_GRACE_MS). */
const GOOD_START_HEIGHT = 1080;

export function createRanker(quality: "auto" | number, remuxAvailable: boolean, preferredProvider: string): Ranker {
  return {
    targetHeight: quality === "auto" ? GOOD_START_HEIGHT : Math.min(quality, GOOD_START_HEIGHT),
    isSuspect: (source) => isSuspect(source),
    pick(candidates) {
      const playable = playableHere(candidates, remuxAvailable);
      if (!playable.length) return null;
      // Sources the server has seen failing are a last resort, not a first try.
      const healthy = playable.filter((s) => !isSuspect(s));
      const pool = healthy.length ? healthy : playable;
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

/** Snap odd heights (e.g. 2.39:1 1080p reported as 802) to standard rungs. */
export function normalizeHeight(height: number): number {
  const rungs = [2160, 1440, 1080, 720, 480, 360];
  return rungs.find((r) => height >= r * 0.7) ?? height;
}

export function qualityLabel(height: number): string {
  if (height >= 2160) return "4K";
  return `${height}p`;
}

export interface ResolvedPlayable {
  playable: Playable;
  /** True length when the server knows it (remux). */
  durationS?: number;
  /** SDR, PQ (HDR10 / Dolby Vision) or HLG when the server read it from the file. */
  dynamicRange?: string;
  remux: boolean;
}

const VOD_OPEN_TIMEOUT_MS = 15_000;

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
    const params = new URLSearchParams({
      type: title.mediaType,
      id: String(title.tmdbId),
      sourceId: source.id,
      startAt: String(Math.floor(startAt)),
      audioPreference: audio.preference,
      audioLanguage: audio.language,
    });
    if (source.remuxTicket) params.set("ticket", source.remuxTicket);
    if (title.season != null) params.set("season", String(title.season));
    if (title.episode != null) params.set("episode", String(title.episode));
    if (title.originalLanguage) params.set("originalLanguage", title.originalLanguage);
    const res = await fetch(`/api/vod/open?${params}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(VOD_OPEN_TIMEOUT_MS)]),
    });
    const body = (await res.json().catch(() => ({}))) as {
      playlistUrl?: string;
      durationS?: number;
      dynamicRange?: string;
      error?: string;
    };
    if (!res.ok || !body.playlistUrl) throw new Error(body.error || `remux open failed (${res.status})`);
    return {
      playable: { kind: "hls", url: body.playlistUrl, withCredentials: true, nativeHls: preferNativeHls(video, source) },
      durationS: body.durationS,
      dynamicRange: body.dynamicRange,
      remux: true,
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

/**
 * The server's reading of a player's heartbeat and end-of-title reports (see
 * docs/TELEMETRY.md). Every number is checked and clamped to a sane range,
 * every string is cut short, and every field not listed here is dropped: the
 * body is the browser's, and it is only ever written down, never trusted.
 *
 * Pure, so the limits and the reason classes are tested directly.
 */

import { PLAYER_DELIVERIES, SESSION_END_REASONS, type PlayerDelivery, type SessionEndReason } from "./qoe";

const DAY_MS = 86_400_000;
const MAX_BYTES = 1e12;
const MAX_BITRATE_BPS = 1e9;
const MAX_FRAMES = 1e7;
const MAX_HEIGHT = 4320;
const MAX_WIDTH = 7680;

export const PLAYER_ENGINES = ["hlsjs", "native_hls", "native_file", "dash"] as const;
export type PlayerEngine = (typeof PLAYER_ENGINES)[number];

/** Why a start failed, reduced to a small fixed set so the metric's labels stay bounded. */
export const START_FAILURE_REASONS = [
  "timeout",
  "remux_502",
  "remux_415",
  "remux_other",
  "hls_network",
  "hls_media",
  "media_error",
  "wrong_language",
  "other",
] as const;
export type StartFailureReason = (typeof START_FAILURE_REASONS)[number];

/** The reason the player gives when a file is passed over for having no audio in the wanted language (use-player-controller.ts). */
const WRONG_LANGUAGE_REASON = "no audio in the wanted language";

/**
 * The class of a failed start, from the reason the player reported. Reasons
 * are the player's own: "timeout", "remux:<status>" or a remux's error text,
 * hls.js error details ("fragLoadTimeOut", "bufferAppendError"), and the
 * element's error codes ("media:3").
 */
export function startFailureReason(reason: string | null | undefined): StartFailureReason {
  const text = (reason ?? "").trim();
  if (text === "timeout") return "timeout";
  if (/^remux:502$|remux open failed \(502\)/.test(text)) return "remux_502";
  if (/^remux:415$|remux open failed \(415\)/.test(text)) return "remux_415";
  if (/^remux:|remux open failed/.test(text)) return "remux_other";
  if (text === WRONG_LANGUAGE_REASON) return "wrong_language";
  // hls.js names a fetch that failed or ran out of time "...LoadError" or "...LoadTimeOut".
  if (/^hls:\w*(LoadError|LoadTimeOut)$/.test(text)) return "hls_network";
  if (/^hls:/.test(text)) return "hls_media";
  if (/^media:/.test(text)) return "media_error";
  return "other";
}

/** A number the browser sent, clamped into [min, max]; null when it is not a finite number at all. */
export function clampNumber(value: unknown, max: number, min = 0): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

/** A whole number, clamped into [0, max]. */
export function clampCount(value: unknown, max: number): number | null {
  const clamped = clampNumber(value, max);
  return clamped === null ? null : Math.round(clamped);
}

/** A short piece of text, trimmed and cut to `max` characters; null when empty or not a string. */
export function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function parseDelivery(value: unknown): PlayerDelivery | null {
  return (PLAYER_DELIVERIES as readonly unknown[]).includes(value) ? (value as PlayerDelivery) : null;
}

export function parseEngine(value: unknown): PlayerEngine | null {
  return (PLAYER_ENGINES as readonly unknown[]).includes(value) ? (value as PlayerEngine) : null;
}

export function parseEndReason(value: unknown): SessionEndReason | null {
  return (SESSION_END_REASONS as readonly unknown[]).includes(value) ? (value as SessionEndReason) : null;
}

/** The fields every report of one file carries. */
interface FileFields {
  sourceId: string;
  provider: string;
  engine: PlayerEngine | null;
  delivery: PlayerDelivery | null;
}

function fileFields(body: Record<string, unknown>): FileFields | null {
  const sourceId = shortText(body.sourceId, 200);
  const provider = shortText(body.provider, 80);
  if (!sourceId || !provider) return null;
  return { sourceId, provider, engine: parseEngine(body.engine), delivery: parseDelivery(body.delivery) };
}

export interface HeartbeatReport extends FileFields {
  positionS: number | null;
  durationS: number | null;
  playing: boolean;
  paused: boolean;
  buffering: boolean;
  bufferAheadS: number | null;
  decodedWidth: number | null;
  decodedHeight: number | null;
  levelBitrateBps: number | null;
  bandwidthBps: number | null;
  bytesLoaded: number | null;
  loadMs: number | null;
  droppedFrames: number | null;
  decodedFrames: number | null;
  stalls: number | null;
  stalledMs: number | null;
  watchedMs: number | null;
  audioLanguage: string | null;
  subtitleLanguage: string | null;
}

/** A heartbeat as the player sent it, checked. Null when the file it names is missing. */
export function parseHeartbeat(body: Record<string, unknown>): HeartbeatReport | null {
  const file = fileFields(body);
  if (!file) return null;
  return {
    ...file,
    positionS: clampNumber(body.positionS, DAY_MS / 1000),
    durationS: clampNumber(body.durationS, DAY_MS / 1000),
    playing: body.playing === true,
    paused: body.paused === true,
    buffering: body.buffering === true,
    bufferAheadS: clampNumber(body.bufferAheadS, 3600),
    decodedWidth: clampCount(body.decodedWidth, MAX_WIDTH),
    decodedHeight: clampCount(body.decodedHeight, MAX_HEIGHT),
    levelBitrateBps: clampNumber(body.levelBitrateBps, MAX_BITRATE_BPS),
    bandwidthBps: clampNumber(body.bandwidthBps, MAX_BITRATE_BPS),
    bytesLoaded: clampNumber(body.bytesLoaded, MAX_BYTES),
    loadMs: clampNumber(body.loadMs, DAY_MS),
    droppedFrames: clampCount(body.droppedFrames, MAX_FRAMES),
    decodedFrames: clampCount(body.decodedFrames, MAX_FRAMES),
    stalls: clampCount(body.stalls, 1e6),
    stalledMs: clampNumber(body.stalledMs, DAY_MS),
    watchedMs: clampNumber(body.watchedMs, DAY_MS),
    audioLanguage: shortText(body.audioLanguage, 16),
    subtitleLanguage: shortText(body.subtitleLanguage, 16),
  };
}

export interface SessionEndReport extends FileFields {
  endReason: SessionEndReason;
  watchedMs: number | null;
  stalledMs: number | null;
  stalls: number | null;
  seeks: number | null;
  startupMs: number | null;
  maxHeight: number | null;
  avgBitrateBps: number | null;
  bytesLoaded: number | null;
  sourcesTried: number | null;
}

/** An end-of-title summary as the player sent it, checked. Null when the file or the reason is missing or unknown. */
export function parseSessionEnd(body: Record<string, unknown>): SessionEndReport | null {
  const file = fileFields(body);
  const endReason = parseEndReason(body.endReason);
  if (!file || !endReason) return null;
  return {
    ...file,
    endReason,
    watchedMs: clampNumber(body.watchedMs, DAY_MS),
    stalledMs: clampNumber(body.stalledMs, DAY_MS),
    stalls: clampCount(body.stalls, 1e6),
    seeks: clampCount(body.seeks, 1e6),
    startupMs: clampNumber(body.startupMs, DAY_MS),
    maxHeight: clampCount(body.maxHeight, MAX_HEIGHT),
    avgBitrateBps: clampNumber(body.avgBitrateBps, MAX_BITRATE_BPS),
    bytesLoaded: clampNumber(body.bytesLoaded, MAX_BYTES),
    sourcesTried: clampCount(body.sourcesTried, 1000),
  };
}

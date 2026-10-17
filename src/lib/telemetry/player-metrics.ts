/**
 * Turns the players' reports into the live metrics (docs/TELEMETRY.md, "Web
 * app"). Called by the feedback route after a report is checked and logged.
 *
 * Labels are the fixed sets of web-metrics.ts and metrics.ts: never a title,
 * a viewer or a link. The one thing kept per viewer is an in-memory entry per
 * (viewer tag, file) so the active-players gauge can count who was heard from
 * in the last minute; it holds no title and is never written anywhere.
 */

import { metrics, qualityBucket } from "../metrics";
import { bitrateBps } from "./qoe";
import { startFailureReason } from "./player-report";
import {
  deviceLabel,
  playerActiveSessions,
  playerBandwidth,
  playerBitrate,
  playerBufferAhead,
  playerDecodedFrames,
  playerDroppedFrames,
  playerFirstFrameSeconds,
  playerOpenToFrameSeconds,
  playerSeekSeconds,
  playerStallSeconds,
  playerStalls,
  playerStartFailures,
  playerWatchSeconds,
  serviceLabel,
} from "./web-metrics";

/** The labels every player metric is cut by, as the report describes the player. */
export type PlayerLabels = {
  device: string;
  delivery: string;
  service: string;
  quality: string;
};

/** Who and what a report is about. `deviceClass` is the platform's own class, `delivery` the route. */
export function playerLabels(input: {
  deviceClass?: unknown;
  delivery?: string | null;
  provider: string;
  decodedWidth?: number | null;
  decodedHeight?: number | null;
}): PlayerLabels {
  return {
    device: deviceLabel(input.deviceClass),
    delivery: input.delivery ?? "unknown",
    service: serviceLabel(input.provider),
    quality: qualityBucket(input.decodedHeight ?? null, input.decodedWidth ?? null),
  };
}

export interface FirstFrameTimes {
  timeToFirstFrameMs?: number | null;
  sinceOpenMs?: number | null;
}

/** A player's first picture: from choosing the file, and (for a title's first) from opening it. */
export function recordFirstFrame(labels: PlayerLabels, times: FirstFrameTimes): void {
  if (times.timeToFirstFrameMs != null) {
    playerFirstFrameSeconds.observe(
      { device: labels.device, delivery: labels.delivery, service: labels.service, quality: labels.quality },
      times.timeToFirstFrameMs / 1000
    );
  }
  if (times.sinceOpenMs != null) {
    playerOpenToFrameSeconds.observe({ device: labels.device, delivery: labels.delivery, quality: labels.quality }, times.sinceOpenMs / 1000);
  }
}

/** A start that failed (handoff_failed, decode_error), by the class of its reason. */
export function recordStartFailure(labels: PlayerLabels, reason: string | null | undefined): void {
  playerStartFailures.inc({
    device: labels.device,
    delivery: labels.delivery,
    service: labels.service,
    reason: startFailureReason(reason),
  });
}

/** A stall after the first picture, as the player reported it. */
export function recordStall(labels: PlayerLabels): void {
  playerStalls.inc({ device: labels.device, delivery: labels.delivery, service: labels.service });
}

/** A jump, from the moment it was made to the picture moving again. */
export function recordSeek(labels: PlayerLabels, seekMs: number | null | undefined): void {
  if (seekMs == null) return;
  playerSeekSeconds.observe({ device: labels.device, delivery: labels.delivery }, seekMs / 1000);
}

export interface HeartbeatFigures {
  watchedMs: number | null;
  stalledMs: number | null;
  bytesLoaded: number | null;
  loadMs: number | null;
  bandwidthBps: number | null;
  bufferAheadS: number | null;
  droppedFrames: number | null;
  decodedFrames: number | null;
}

/** One heartbeat: the time watched and stalled since the last one, the delivered bit rate, and the picture's health. */
export function recordHeartbeat(labels: PlayerLabels, figures: HeartbeatFigures): void {
  if (figures.watchedMs != null && figures.watchedMs > 0) {
    playerWatchSeconds.inc({ device: labels.device, delivery: labels.delivery, quality: labels.quality }, figures.watchedMs / 1000);
  }
  if (figures.stalledMs != null && figures.stalledMs > 0) {
    playerStallSeconds.inc({ device: labels.device, delivery: labels.delivery, service: labels.service }, figures.stalledMs / 1000);
  }
  const bps = bitrateBps(figures.bytesLoaded, figures.loadMs);
  if (bps !== null) playerBitrate.observe({ delivery: labels.delivery }, bps);
  if (figures.bandwidthBps != null && figures.bandwidthBps > 0) playerBandwidth.observe({ device: labels.device }, figures.bandwidthBps);
  if (figures.bufferAheadS != null) playerBufferAhead.observe({ device: labels.device, delivery: labels.delivery }, figures.bufferAheadS);
  if (figures.droppedFrames != null && figures.droppedFrames > 0) {
    playerDroppedFrames.inc({ device: labels.device, quality: labels.quality }, figures.droppedFrames);
  }
  if (figures.decodedFrames != null && figures.decodedFrames > 0) {
    playerDecodedFrames.inc({ device: labels.device, quality: labels.quality }, figures.decodedFrames);
  }
}

/* Players heard from in the last minute. Kept on globalThis, like the registry, so a module
 * bundled twice by Next shares one map and the gauge sees every heartbeat. */

const ACTIVE_WINDOW_MS = 60_000;
const ACTIVE_KEY = "__absoluteCinemaActivePlayers";

interface ActivePlayer {
  seenAt: number;
  device: string;
  delivery: string;
}

interface ActivePlayers {
  entries: Map<string, ActivePlayer>;
  collecting: boolean;
}

function activePlayers(): ActivePlayers {
  const holder = globalThis as unknown as Record<string, ActivePlayers | undefined>;
  const state = (holder[ACTIVE_KEY] ??= { entries: new Map(), collecting: false });
  if (!state.collecting) {
    state.collecting = true;
    // Set at each scrape from the map, so the gauge drops a player the moment they are not heard from.
    metrics().onCollect(() => setActiveGauge(Date.now()));
  }
  return state;
}

function pruneActive(entries: Map<string, ActivePlayer>, now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.seenAt > ACTIVE_WINDOW_MS) entries.delete(key);
  }
}

function setActiveGauge(now: number): void {
  const { entries } = activePlayers();
  pruneActive(entries, now);
  const counts = new Map<string, { device: string; delivery: string; count: number }>();
  for (const entry of entries.values()) {
    const key = `${entry.device}\u0000${entry.delivery}`;
    const found = counts.get(key) ?? { device: entry.device, delivery: entry.delivery, count: 0 };
    found.count += 1;
    counts.set(key, found);
  }
  playerActiveSessions.reset();
  for (const { device, delivery, count } of counts.values()) {
    playerActiveSessions.set({ device, delivery }, count);
  }
}

/** A heartbeat from one viewer's file: they are playing it now. `viewer` is the viewer's tag, never the account. */
export function noteActivePlayer(viewer: string, sourceId: string, labels: Pick<PlayerLabels, "device" | "delivery">, now = Date.now()): void {
  const { entries } = activePlayers();
  pruneActive(entries, now);
  entries.set(`${viewer}\u0000${sourceId}`, { seenAt: now, device: labels.device, delivery: labels.delivery });
}

/** A viewer's file has ended: they stop counting as playing it now, not a minute later. */
export function forgetActivePlayer(viewer: string, sourceId: string): void {
  activePlayers().entries.delete(`${viewer}\u0000${sourceId}`);
}

// Registered once when this module loads, so the gauge is part of every scrape from then on.
activePlayers();

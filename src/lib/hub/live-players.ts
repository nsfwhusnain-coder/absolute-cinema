/**
 * Who is watching what right now, for the live dashboard (/hub): the latest
 * report of every open player, as the player sends it (every 30 s, and at its
 * first picture, a stall and its end). In memory only, and on globalThis like
 * the metrics registry, so a module Next bundles twice still shares one map.
 * The event log is the record; this is the window onto now.
 */

import type { HeartbeatReport } from "@/lib/telemetry/player-report";

/** A player not heard from for this long has gone (a closed tab that sent no goodbye). */
const LIVE_WINDOW_MS = 75_000;
/** Players kept at most; reports from made-up sources cannot grow the map without bound. */
const MAX_PLAYERS = 500;
const KEY = "__absoluteCinemaLivePlayers";

export interface LiveTitle {
  tmdbId: string;
  mediaType: "movie" | "tv";
  season: number;
  episode: number;
}

export interface LivePlayer {
  userId: string;
  sourceId: string;
  provider: string;
  delivery: string | null;
  engine: string | null;
  title: LiveTitle | null;
  deviceClass: string | null;
  /** The browser family the page named ("simulator" for the load simulator's viewers). */
  uaPlatform: string | null;
  startedAt: number;
  firstFrameAt: number | null;
  lastSeenAt: number;
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
  /** Totals since the player opened this file. */
  stalls: number;
  stalledMs: number;
  droppedFrames: number | null;
  audioLanguage: string | null;
  subtitleLanguage: string | null;
}

interface LiveState {
  players: Map<string, LivePlayer>;
}

function state(): LiveState {
  const holder = globalThis as unknown as Record<string, LiveState | undefined>;
  return (holder[KEY] ??= { players: new Map() });
}

const keyOf = (userId: string, sourceId: string) => `${userId}\u0000${sourceId}`;

function prune(players: Map<string, LivePlayer>, now: number): void {
  for (const [key, player] of players) {
    if (now - player.lastSeenAt <= LIVE_WINDOW_MS) continue;
    players.delete(key);
    // Gone without a goodbye (a closed tab, a lost connection): they stopped when last heard from.
    if (player.firstFrameAt !== null) {
      noteLiveActivity({
        at: player.lastSeenAt,
        kind: "stopped",
        userId: player.userId,
        sourceId: player.sourceId,
        title: player.title,
        watchedS: Math.round((player.lastSeenAt - player.firstFrameAt) / 1000),
        simulated: player.uaPlatform === "simulator",
      });
    }
  }
  while (players.size > MAX_PLAYERS) players.delete(players.keys().next().value as string);
}

export interface LiveContext {
  title: LiveTitle | null;
  deviceClass: string | null;
  uaPlatform: string | null;
}

function entry(userId: string, sourceId: string, provider: string, context: LiveContext, now: number): LivePlayer {
  const { players } = state();
  prune(players, now);
  const key = keyOf(userId, sourceId);
  let player = players.get(key);
  if (!player) {
    player = {
      userId,
      sourceId,
      provider,
      delivery: null,
      engine: null,
      title: context.title,
      deviceClass: context.deviceClass,
      uaPlatform: context.uaPlatform,
      startedAt: now,
      firstFrameAt: null,
      lastSeenAt: now,
      positionS: null,
      durationS: null,
      playing: false,
      paused: false,
      buffering: true,
      bufferAheadS: null,
      decodedWidth: null,
      decodedHeight: null,
      levelBitrateBps: null,
      bandwidthBps: null,
      stalls: 0,
      stalledMs: 0,
      droppedFrames: null,
      audioLanguage: null,
      subtitleLanguage: null,
    };
    players.set(key, player);
  }
  player.lastSeenAt = now;
  player.provider = provider || player.provider;
  if (context.title) player.title = context.title;
  if (context.deviceClass) player.deviceClass = context.deviceClass;
  if (context.uaPlatform) player.uaPlatform = context.uaPlatform;
  return player;
}

/** A player's heartbeat: where it is, what it shows, how it is coping. */
export function noteLiveHeartbeat(userId: string, report: HeartbeatReport, context: LiveContext, now = Date.now()): void {
  const player = entry(userId, report.sourceId, report.provider, context, now);
  player.delivery = report.delivery ?? player.delivery;
  player.engine = report.engine ?? player.engine;
  player.positionS = report.positionS;
  player.durationS = report.durationS;
  player.playing = report.playing;
  player.paused = report.paused;
  player.buffering = report.buffering;
  player.bufferAheadS = report.bufferAheadS;
  if (report.decodedHeight) {
    player.decodedWidth = report.decodedWidth;
    player.decodedHeight = report.decodedHeight;
  }
  player.levelBitrateBps = report.levelBitrateBps ?? player.levelBitrateBps;
  player.bandwidthBps = report.bandwidthBps ?? player.bandwidthBps;
  player.stalls += report.stalls ?? 0;
  player.stalledMs += report.stalledMs ?? 0;
  player.droppedFrames = report.droppedFrames ?? player.droppedFrames;
  player.audioLanguage = report.audioLanguage ?? player.audioLanguage;
  player.subtitleLanguage = report.subtitleLanguage ?? player.subtitleLanguage;
  if (player.playing && player.firstFrameAt === null) started(player, now);
}

function started(player: LivePlayer, now: number): void {
  player.firstFrameAt = now;
  noteLiveActivity({ at: now, kind: "started", userId: player.userId, sourceId: player.sourceId, title: player.title, simulated: player.uaPlatform === "simulator" });
}

/** A player's own event (its first picture, a stall): it is alive, and what it says is kept. */
export function noteLiveEvent(
  userId: string,
  event: { event: string; sourceId: string; provider: string; delivery?: string; engine?: string; decodedHeight?: number; decodedWidth?: number },
  context: LiveContext,
  now = Date.now()
): void {
  // An outcome that ends the attempt (a failed start, a capacity stop) is not someone watching.
  if (event.event === "handoff_failed" || event.event === "decode_error" || event.event === "capacity_stopped") {
    forgetLivePlayer(userId, event.sourceId);
    return;
  }
  if (event.event !== "first_frame" && event.event !== "stall" && event.event !== "decoded_resolution") return;
  const player = entry(userId, event.sourceId, event.provider, context, now);
  if (event.delivery) player.delivery = event.delivery;
  if (event.engine) player.engine = event.engine;
  if (event.decodedHeight) {
    player.decodedHeight = event.decodedHeight;
    player.decodedWidth = event.decodedWidth ?? player.decodedWidth;
  }
  if (event.event === "first_frame") {
    if (player.firstFrameAt === null) started(player, now);
    player.playing = true;
    player.buffering = false;
  }
  if (event.event === "stall") player.buffering = true;
}

/** The player closed this file. */
export function forgetLivePlayer(userId: string, sourceId: string, now = Date.now()): void {
  const { players } = state();
  const key = keyOf(userId, sourceId);
  const player = players.get(key);
  if (!player) return;
  players.delete(key);
  if (player.firstFrameAt !== null) {
    noteLiveActivity({
      at: now,
      kind: "stopped",
      userId,
      sourceId,
      title: player.title,
      watchedS: Math.round((now - player.firstFrameAt) / 1000),
      simulated: player.uaPlatform === "simulator",
    });
  }
}

/** Everyone heard from lately, newest first. */
export function livePlayers(now = Date.now()): LivePlayer[] {
  const { players } = state();
  prune(players, now);
  return [...players.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** A moment the dashboard's activity feed shows: someone started or stopped watching. */
export interface LiveActivity {
  at: number;
  kind: "started" | "stopped";
  userId: string;
  sourceId: string;
  title: LiveTitle | null;
  /** How long they had watched, when they stopped. */
  watchedS?: number;
  simulated: boolean;
}

const ACTIVITY_KEY = "__absoluteCinemaLiveActivity";
const ACTIVITY_KEPT = 60;

function activity(): LiveActivity[] {
  const holder = globalThis as unknown as Record<string, LiveActivity[] | undefined>;
  return (holder[ACTIVITY_KEY] ??= []);
}

export function noteLiveActivity(item: LiveActivity): void {
  const list = activity();
  list.push(item);
  if (list.length > ACTIVITY_KEPT) list.shift();
}

/** Newest first. */
export function liveActivity(): LiveActivity[] {
  return [...activity()].reverse();
}

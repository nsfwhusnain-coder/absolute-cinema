/**
 * The live dashboard's picture of right now (/hub, docs/HUB.md): every viewer
 * with what they watch, at what quality, how it plays and what it costs the
 * server; the machine's load and the capacity governor's state; the last hour
 * of readings; the latest moments. Joined here from the players' own reports
 * (live-players.ts), the remuxer's sessions, seats and readings
 * (GET /capacity/live), the profiles, and the catalogue.
 */

import { db } from "@/lib/db";
import { tmdb } from "@/lib/tmdb";
import { remuxSessionOrigin } from "@/lib/playback/remux-sessions";
import { REMUXER_URL, watcherOf } from "@/lib/playback/remuxer";
import { liveActivity, livePlayers, type LivePlayer, type LiveTitle } from "./live-players";

// ---------------------------------------------------------------- what the remuxer answers (GET /capacity/live)

interface RemuxRun {
  id: number;
  watcher: string;
  paused: boolean;
  aheadS: number;
  servedAgoMs: number;
  /** Fraction of one core its ffmpeg took over the last 5 s. */
  cpu: number | null;
}

interface RemuxSession {
  id: string;
  identity: string;
  cdn: string;
  bitrateBps: number | null;
  durationS: number;
  videoCodec: string | null;
  dynamicRange: string;
  audioDelivery: string;
  demanded: boolean;
  idleMs: number;
  lanes: number;
  servedBps: number;
  upstreamBps: number;
  runs: RemuxRun[];
  watchers: Array<{ watcher: string; agoMs: number }>;
}

interface RemuxSeat {
  watcher: string;
  priority: number;
  sessionId: string | null;
  delivery: string;
  class: string;
  bitrateBps: number;
  cpuCores: number;
  share: number;
  playing: boolean;
  paused: boolean;
  admittedAgoMs: number;
  activeAgoMs: number;
  evicted: string | null;
}

interface RemuxLive {
  snapshot: {
    enabled: boolean;
    level: "ok" | "busy" | "critical";
    reasons: string[];
    seats: number;
    queue: number;
    use: { cpu: number; remuxer: number; memory: number; downlink: number; uplink: number };
    measured: {
      cpuCores: number;
      cpuLimitCores: number;
      remuxerCores: number;
      throttledShare: number;
      memoryBytes: number;
      memoryLimitBytes: number;
      temperatureC: number | null;
      loopLagMs: number;
      loopFreezeMs?: number;
      downBps: number;
      stallShare: number | null;
    };
  };
  seats: RemuxSeat[];
  queue: Array<{ position: number; watcher: string; priority: number; delivery: string; class: string; waitedMs: number }>;
  sessions: RemuxSession[];
  history: HubPoint[];
  events: Array<{ at: number; kind: string; watcher?: string; [field: string]: unknown }>;
  viewers: number;
}

// ---------------------------------------------------------------- what the dashboard is sent

export interface HubPoint {
  at: number;
  level: number;
  seats: number;
  queue: number;
  viewers: number;
  cpuCores: number;
  cpuLimitCores: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  temperatureC: number | null;
  loopLagMs: number;
  rxBps: number;
  txBps: number;
}

export interface HubPerson {
  name: string;
  color: string | null;
  owner: boolean;
  /** One of the load simulator's viewers, or a test stream. */
  simulated: boolean;
}

export interface HubTitle {
  tmdbId: string;
  mediaType: "movie" | "tv";
  name: string;
  year: string | null;
  poster: string | null;
  season: number | null;
  episode: number | null;
}

export interface HubServerLoad {
  sessionId: string;
  cdn: string;
  /** Cores its ffmpeg runs take now. */
  cpuCores: number;
  runs: number;
  pausedRuns: number;
  /** How far ahead of the viewer it has made the stream. */
  aheadS: number;
  servedBps: number;
  upstreamBps: number;
  audio: string;
  videoCodec: string | null;
  dynamicRange: string;
  fileBitrateBps: number | null;
}

export interface HubViewer {
  key: string;
  person: HubPerson;
  title: HubTitle | null;
  /** For a stream with no title (a load test's file). */
  label: string | null;
  provider: string | null;
  delivery: string | null;
  engine: string | null;
  device: string | null;
  quality: { label: string; width: number | null; height: number | null; bitrateBps: number | null };
  state: "playing" | "paused" | "buffering" | "starting";
  positionS: number | null;
  durationS: number | null;
  bufferAheadS: number | null;
  bandwidthBps: number | null;
  stalls: number;
  stalledS: number;
  watchingS: number;
  seat: { class: string; share: number; cpuCores: number; owner: boolean } | null;
  server: HubServerLoad | null;
}

export interface HubEvent {
  at: number;
  kind: string;
  text: string;
  tone: "info" | "good" | "warn" | "bad";
}

export interface HubSnapshot {
  at: number;
  label: string | null;
  version: string | null;
  remuxer: boolean;
  gate: { enabled: boolean; level: "ok" | "busy" | "critical"; reasons: string[] };
  machine: {
    cpuCores: number;
    cpuLimitCores: number;
    /** The remuxer's own thread, in cores: one thread, so 1 is its ceiling. */
    remuxerCores: number;
    throttledShare: number;
    memoryBytes: number;
    memoryLimitBytes: number;
    temperatureC: number | null;
    loopLagMs: number;
    /** The remuxer's longest pause in the last 10 s. */
    loopFreezeMs: number;
    downBps: number;
    upBps: number;
  };
  budgets: { cpu: number; remuxer: number; memory: number; downlink: number; uplink: number };
  totals: {
    watching: number;
    playing: number;
    paused: number;
    buffering: number;
    simulated: number;
    queue: number;
    servedBps: number;
    upstreamBps: number;
    byQuality: Record<string, number>;
  };
  viewers: HubViewer[];
  queue: Array<{ position: number; name: string; owner: boolean; class: string; waitedS: number }>;
  history: HubPoint[];
  events: HubEvent[];
}

// ---------------------------------------------------------------- lookups

interface Profile {
  id: string;
  name: string;
  isAdmin: boolean;
  avatarColor: string | null;
}

const PROFILES_TTL_MS = 30_000;
let profiles: { at: number; byId: Map<string, Profile>; byWatcher: Map<string, Profile> } | null = null;

async function profileDirectory(): Promise<{ byId: Map<string, Profile>; byWatcher: Map<string, Profile> }> {
  if (profiles && Date.now() - profiles.at < PROFILES_TTL_MS) return profiles;
  const users = await db.user.findMany({ select: { id: true, name: true, isAdmin: true, avatarColor: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  const byWatcher = new Map(users.map((u) => [watcherOf(u.id), u]));
  profiles = { at: Date.now(), byId, byWatcher };
  return profiles;
}

const TITLE_TTL_MS = 6 * 60 * 60 * 1000;
const titles = new Map<string, { at: number; title: Omit<HubTitle, "season" | "episode"> | null }>();

async function titleInfo(mediaType: "movie" | "tv", tmdbId: string): Promise<Omit<HubTitle, "season" | "episode"> | null> {
  const key = `${mediaType}:${tmdbId}`;
  const cached = titles.get(key);
  if (cached && Date.now() - cached.at < TITLE_TTL_MS) return cached.title;
  const id = Number(tmdbId);
  if (!Number.isInteger(id) || id <= 0) return null;
  let title: Omit<HubTitle, "season" | "episode"> | null = null;
  try {
    const raw = (await tmdb.animeSignals(mediaType, id)) as {
      title?: string;
      name?: string;
      release_date?: string;
      first_air_date?: string;
      poster_path?: string | null;
    } | null;
    if (raw) {
      const date = raw.release_date || raw.first_air_date || "";
      title = { tmdbId, mediaType, name: raw.title || raw.name || `${mediaType} ${tmdbId}`, year: date ? date.slice(0, 4) : null, poster: raw.poster_path ?? null };
    }
  } catch {
    // The catalogue is out of reach: the viewer still shows, by number.
  }
  titles.set(key, { at: Date.now(), title });
  while (titles.size > 500) titles.delete(titles.keys().next().value as string);
  return title;
}

// ---------------------------------------------------------------- the snapshot

export function qualityLabel(width: number | null, height: number | null): string {
  const h = Math.max(height ?? 0, ((width ?? 0) * 9) / 16);
  if (h >= 1500) return "4K";
  if (h >= 1300) return "1440p";
  if (h >= 900) return "1080p";
  if (h >= 650) return "720p";
  if (h > 0) return "SD";
  return "—";
}

const PERSON_GONE: HubPerson = { name: "Viewer", color: null, owner: false, simulated: false };

function personOf(profile: Profile | undefined, simulated: boolean): HubPerson {
  if (!profile) return { ...PERSON_GONE, simulated };
  return { name: profile.name, color: profile.avatarColor, owner: profile.isAdmin, simulated: simulated || /^sim[ \-_]/i.test(profile.name) };
}

function loadOf(session: RemuxSession, watcher: string): HubServerLoad {
  const mine = session.runs.filter((run) => run.watcher === watcher);
  const runs = mine.length ? mine : session.runs;
  return {
    sessionId: session.id,
    cdn: session.cdn,
    cpuCores: runs.reduce((sum, run) => sum + (run.cpu ?? 0), 0),
    runs: runs.length,
    pausedRuns: runs.filter((run) => run.paused).length,
    aheadS: Math.max(0, ...runs.map((run) => run.aheadS)),
    servedBps: session.servedBps,
    upstreamBps: session.upstreamBps,
    audio: session.audioDelivery,
    videoCodec: session.videoCodec,
    dynamicRange: session.dynamicRange,
    fileBitrateBps: session.bitrateBps,
  };
}

function stateOf(player: LivePlayer): HubViewer["state"] {
  if (player.firstFrameAt === null) return "starting";
  if (player.buffering) return "buffering";
  if (player.paused || !player.playing) return "paused";
  return "playing";
}

async function remuxerLive(): Promise<RemuxLive | null> {
  try {
    const res = await fetch(`${REMUXER_URL}/capacity/live?minutes=60`, { signal: AbortSignal.timeout(3000), cache: "no-store" });
    return res.ok ? ((await res.json()) as RemuxLive) : null;
  } catch {
    return null;
  }
}

const ACTIVE_STREAM_MS = 30_000;

export async function hubSnapshot(now = Date.now()): Promise<HubSnapshot> {
  const [remux, directory] = await Promise.all([remuxerLive(), profileDirectory()]);
  const sessions = remux?.sessions ?? [];
  const seats = (remux?.seats ?? []).filter((seat) => !seat.evicted);
  const claimed = new Set<string>();
  const usedSeats = new Set<RemuxSeat>();
  const titleKeys = new Map<string, LiveTitle>();

  const seatFor = (watcher: string, sessionId: string | null): RemuxSeat | null => {
    const found =
      seats.find((seat) => !usedSeats.has(seat) && seat.watcher === watcher && sessionId !== null && seat.sessionId === sessionId) ??
      seats.find((seat) => !usedSeats.has(seat) && seat.watcher === watcher && seat.sessionId === null);
    if (found) usedSeats.add(found);
    return found ?? null;
  };

  // Players that report (real viewers, and the simulator's).
  const fromPlayers = livePlayers(now).map((player) => {
    const watcher = watcherOf(player.userId);
    const session = sessions.find(
      (s) => !claimed.has(`${s.id}:${watcher}`) && remuxSessionOrigin(s.id)?.sourceId === player.sourceId && s.watchers.some((w) => w.watcher === watcher)
    );
    if (session) claimed.add(`${session.id}:${watcher}`);
    if (player.title) titleKeys.set(`${player.title.mediaType}:${player.title.tmdbId}`, player.title);
    const seat = seatFor(watcher, session?.id ?? null);
    return { player, watcher, session, seat };
  });

  // Streams nobody reports for: a load test's, or a page from before the reports.
  const fromStreams: Array<{ session: RemuxSession; watcher: string; seat: RemuxSeat | null }> = [];
  for (const session of sessions) {
    if (!session.demanded) continue;
    for (const { watcher, agoMs } of session.watchers) {
      if (agoMs > ACTIVE_STREAM_MS || claimed.has(`${session.id}:${watcher}`)) continue;
      claimed.add(`${session.id}:${watcher}`);
      const origin = remuxSessionOrigin(session.id);
      if (origin) titleKeys.set(`${origin.title.mediaType}:${origin.title.tmdbId}`, { tmdbId: String(origin.title.tmdbId), mediaType: origin.title.mediaType, season: origin.title.season ?? 0, episode: origin.title.episode ?? 0 });
      fromStreams.push({ session, watcher, seat: seatFor(watcher, session.id) });
    }
  }

  const info = new Map<string, Omit<HubTitle, "season" | "episode"> | null>();
  await Promise.all([...titleKeys].map(async ([key, t]) => info.set(key, await titleInfo(t.mediaType, t.tmdbId))));
  const titleOf = (t: LiveTitle | null): HubTitle | null => {
    if (!t) return null;
    const known = info.get(`${t.mediaType}:${t.tmdbId}`);
    return {
      tmdbId: t.tmdbId,
      mediaType: t.mediaType,
      name: known?.name ?? `${t.mediaType === "tv" ? "Series" : "Film"} ${t.tmdbId}`,
      year: known?.year ?? null,
      poster: known?.poster ?? null,
      season: t.mediaType === "tv" && t.season ? t.season : null,
      episode: t.mediaType === "tv" && t.episode ? t.episode : null,
    };
  };
  const seatView = (seat: RemuxSeat | null) => (seat ? { class: seat.class, share: seat.share, cpuCores: seat.cpuCores, owner: seat.priority > 0 } : null);

  const viewers: HubViewer[] = [
    ...fromPlayers.map(({ player, watcher, session, seat }) => {
      const simulated = player.uaPlatform === "simulator";
      return {
        key: `${player.userId}:${player.sourceId}`,
        person: personOf(directory.byId.get(player.userId), simulated),
        title: titleOf(player.title),
        label: null,
        provider: player.provider,
        delivery: player.delivery,
        engine: player.engine,
        device: player.deviceClass,
        quality: { label: qualityLabel(player.decodedWidth, player.decodedHeight), width: player.decodedWidth, height: player.decodedHeight, bitrateBps: player.levelBitrateBps },
        state: stateOf(player),
        positionS: player.positionS,
        durationS: player.durationS,
        bufferAheadS: player.bufferAheadS,
        bandwidthBps: player.bandwidthBps,
        stalls: player.stalls,
        stalledS: Math.round(player.stalledMs / 100) / 10,
        watchingS: Math.round((now - player.startedAt) / 1000),
        seat: seatView(seat),
        server: session ? loadOf(session, watcher) : null,
      } satisfies HubViewer;
    }),
    ...fromStreams.map(({ session, watcher, seat }) => {
      const origin = remuxSessionOrigin(session.id);
      const profile = directory.byWatcher.get(watcher);
      const test = !origin;
      const load = loadOf(session, watcher);
      return {
        key: `${session.id}:${watcher}`,
        person: test ? { name: profile ? `${profile.name} (load test)` : "Load test viewer", color: null, owner: false, simulated: true } : personOf(profile, false),
        title: origin ? titleOf({ tmdbId: String(origin.title.tmdbId), mediaType: origin.title.mediaType, season: origin.title.season ?? 0, episode: origin.title.episode ?? 0 }) : null,
        label: test ? `Test file stream${session.identity ? ` · ${session.identity.replace(/^load-/, "")}` : ""}` : null,
        provider: test ? "Test server" : null,
        delivery: "remux",
        engine: null,
        device: null,
        quality: { label: seat ? (seat.class === "4k" ? "4K" : seat.class) : "—", width: null, height: null, bitrateBps: session.bitrateBps },
        state: load.runs === 0 ? "paused" : "playing",
        positionS: null,
        durationS: session.durationS,
        bufferAheadS: null,
        bandwidthBps: null,
        stalls: 0,
        stalledS: 0,
        watchingS: seat ? Math.round(seat.admittedAgoMs / 1000) : 0,
        seat: seatView(seat),
        server: load,
      } satisfies HubViewer;
    }),
  ];

  const byQuality: Record<string, number> = {};
  for (const viewer of viewers) byQuality[viewer.quality.label] = (byQuality[viewer.quality.label] ?? 0) + 1;
  const nameOfWatcher = (watcher: string | undefined) => (watcher ? (directory.byWatcher.get(watcher)?.name ?? "A viewer") : "A viewer");

  const events: HubEvent[] = [
    ...liveActivity().map((a) => {
      const who = directory.byId.get(a.userId)?.name ?? "A viewer";
      const what = titleOf(a.title)?.name ?? "a title";
      return a.kind === "started"
        ? { at: a.at, kind: "started", text: `${who} started ${what}`, tone: "good" as const }
        : { at: a.at, kind: "stopped", text: `${who} stopped ${what}${a.watchedS ? ` after ${Math.round(a.watchedS / 60)} min` : ""}`, tone: "info" as const };
    }),
    ...(remux?.events ?? []).map((e): HubEvent => {
      const who = nameOfWatcher(e.watcher as string | undefined);
      switch (e.kind) {
        case "evicted":
          return { at: e.at, kind: e.kind, text: `${who}'s ${String(e.class)} stream was stopped to protect the server (${String(e.reason)})`, tone: "bad" };
        case "queued":
          return { at: e.at, kind: e.kind, text: `Someone joined the queue for ${String(e.class)} (#${String(e.position)}, ${String(e.reason)})`, tone: "warn" };
        case "admitted":
          return { at: e.at, kind: e.kind, text: `Someone was let in after waiting ${String(e.waitedS)} s`, tone: "good" };
        case "full":
          return { at: e.at, kind: e.kind, text: `Someone was turned away: the queue is full (${String(e.reason)})`, tone: "bad" };
        case "level":
          return { at: e.at, kind: e.kind, text: `Server ${String(e.from)} → ${String(e.to)}${e.reasons ? ` (${String(e.reasons)})` : ""}`, tone: e.to === "ok" ? "good" : e.to === "critical" ? "bad" : "warn" };
        default:
          return { at: e.at, kind: e.kind, text: e.kind, tone: "info" };
      }
    }),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 40);

  const measured = remux?.snapshot.measured;
  const lastPoint = remux?.history.at(-1);
  return {
    at: now,
    label: process.env.HUB_LABEL || null,
    version: process.env.NEXT_PUBLIC_APP_VERSION || null,
    remuxer: Boolean(remux),
    gate: { enabled: remux?.snapshot.enabled ?? false, level: remux?.snapshot.level ?? "ok", reasons: remux?.snapshot.reasons ?? [] },
    machine: {
      cpuCores: measured?.cpuCores ?? 0,
      cpuLimitCores: measured?.cpuLimitCores ?? 0,
      remuxerCores: measured?.remuxerCores ?? 0,
      throttledShare: measured?.throttledShare ?? 0,
      memoryBytes: measured?.memoryBytes ?? 0,
      memoryLimitBytes: measured && Number.isFinite(measured.memoryLimitBytes) ? measured.memoryLimitBytes : 0,
      temperatureC: measured?.temperatureC ?? null,
      loopLagMs: measured?.loopLagMs ?? 0,
      loopFreezeMs: measured?.loopFreezeMs ?? 0,
      downBps: lastPoint?.rxBps ?? measured?.downBps ?? 0,
      upBps: lastPoint?.txBps ?? 0,
    },
    budgets: remux?.snapshot.use ?? { cpu: 0, remuxer: 0, memory: 0, downlink: 0, uplink: 0 },
    totals: {
      watching: viewers.length,
      playing: viewers.filter((v) => v.state === "playing").length,
      paused: viewers.filter((v) => v.state === "paused").length,
      buffering: viewers.filter((v) => v.state === "buffering" || v.state === "starting").length,
      simulated: viewers.filter((v) => v.person.simulated).length,
      queue: remux?.snapshot.queue ?? 0,
      servedBps: sessions.reduce((sum, s) => sum + s.servedBps, 0),
      upstreamBps: sessions.reduce((sum, s) => sum + s.upstreamBps, 0),
      byQuality,
    },
    viewers,
    queue: (remux?.queue ?? []).map((q) => {
      const profile = directory.byWatcher.get(q.watcher);
      return { position: q.position, name: profile?.name ?? "A viewer", owner: q.priority > 0, class: q.class, waitedS: Math.round(q.waitedMs / 1000) };
    }),
    history: remux?.history ?? [],
    events,
  };
}

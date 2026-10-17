/**
 * Absolute Cinema remuxer — serves MKV releases (where nearly all 4K lives)
 * as seekable HLS video-on-demand without re-encoding video.
 *
 * Internal only (127.0.0.1:3040); the Next.js app authenticates viewers and
 * proxies these routes.
 *
 *   GET /vod/open?u=<url>&audioPreference=&originalLanguage=&audioLanguage=&audioIndex=&startAt=&dolbyVision=&audioCaps=&prewarm=
 *        → { id, durationS, segments, videoCodecId, dynamicRange, audio, audioIndex, audioTracks, subtitles }
 *   GET /vod/<id>/index.m3u8   complete VOD playlist, one entry per segment (keyframe to keyframe)
 *   GET /vod/<id>/slices.m3u8  the same timeline in slices of about two seconds, for MSE players
 *   GET /vod/<id>/init.mp4     initialisation segment
 *   GET /vod/<id>/<n>.m4s      media segment n (produced on demand)
 *   GET /vod/<id>/s<n>.m4s     slice n
 *   GET /vod/<id>/sub-<k>.json text subtitle track k: cues produced so far
 *   GET /health
 *
 * The capacity governor (governor.ts, docs/CAPACITY.md):
 *   GET  /capacity                    its level, seats, line and readings
 *   POST /capacity/seat               { watcher, priority, delivery, height, bitrateBps, remote, ticket? }
 *                                     → a seat, a place in line, or "full"
 *   POST /capacity/seat/<id>/renew    { watcher, stalls, playing } → still seated, or why the stream was stopped
 *   POST /capacity/seat/<id>/release  { watcher }
 *   GET  /capacity/live               all of the above with the last hour, the open sessions and their runs, for /hub
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import type { AudioPreference } from "../../src/lib/profile-preferences";
import { CAPACITY_HEADER, UNUSABLE_HEADER } from "../../src/lib/playback/remuxer";
import { parseAudioCaps } from "../../src/lib/playback/decode-capability";
import { recordEvent } from "../../src/lib/event-log";
import { metrics } from "../../src/lib/metrics";
import { writeRollups } from "../../src/lib/telemetry/rollups";
import { onClientGone, serveRange } from "./source-proxy";
import { removeCacheLeftovers } from "./cache-leftovers";
import {
  bitsPerSecond,
  capacityRates,
  capacitySnapshotFields,
  readContainerNetwork,
  ViewerTracker,
  type CapacitySample,
} from "./capacity";
import { LoopLag, MachineReader, mainThreadCpuSeconds, type MachineReading } from "./capacity-signals";
import { CpuRates, HISTORY_EVERY_MS, LiveEvents, LiveHistory } from "./live";
import { Governor, governorConfigFromEnv, streamClass, type CapacityReason, type SeatAnswer, type StreamDescription } from "./governor";
import {
  capacityCpuCores,
  capacityEvictions,
  capacityLevel,
  capacityLoopLag,
  capacityMemoryBytes,
  capacityQueue,
  capacityQueueWaitSeconds,
  capacityReasons,
  capacityRequests,
  capacitySeats,
  capacityTemperature,
  capacityThrottled,
  capacityUse,
  containerNetworkBytes,
  processCpuSeconds,
  processResidentBytes,
  proxyLanes,
  remuxCacheBytes,
  remuxDiskFreeBytes,
  remuxRuns,
  remuxSessions,
  remuxViewers,
} from "./remux-metrics";
import { telemetry, totals } from "./remux-stats";
import {
  UNUSABLE_ENTRY,
  VodError,
  cacheStorage,
  configureVod,
  isLiveVodDir,
  leaveVodSession,
  noteServed,
  openVodSession,
  readFragment,
  sessionId as vodSessionId,
  startVodJanitor,
  stopAllVodRuns,
  stopViewerRuns,
  VodCapacityError,
  vodSessionsDetail,
  vodWarmingCount,
  watcherActiveSessions,
  vodInit,
  vodLiveState,
  vodPlaylist,
  vodSubtitleCues,
  type VodAudioRequest,
  vodSegment,
  vodSlice,
  vodSource,
  vodStats,
} from "./vod";

const PORT = Number(process.env.REMUXER_PORT || 3040);
const CACHE_DIR = process.env.REMUX_CACHE_DIR || "/app/transcode-cache";
const MAX_START_AT_S = 24 * 60 * 60;
const SESSION_ID = /^[a-f0-9]{24}$/;

function parseAudio(url: URL): VodAudioRequest {
  const pref = url.searchParams.get("audioPreference");
  const preference: AudioPreference = pref === "english" || pref === "preferred" ? pref : "original";
  const lang = (name: string): string | null => {
    const value = (url.searchParams.get(name) ?? "").trim().toLowerCase();
    return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(value) ? value : null;
  };
  const index = Number(url.searchParams.get("audioIndex"));
  return {
    preference,
    originalLanguage: lang("originalLanguage"),
    preferredLanguage: lang("audioLanguage") ?? "en",
    ...(url.searchParams.has("audioIndex") && Number.isInteger(index) && index >= 0 ? { audioIndex: index } : {}),
  };
}

const MAX_IDENTITY_LENGTH = 200;

/** Who is asking, as the app names them (`w`): their seeks replace their own runs, no one else's. */
function watcherOf(url: URL): string {
  const value = url.searchParams.get("w") ?? "";
  return /^[a-f0-9]{1,32}$/.test(value) ? value : "";
}

/** The source the app means (`k`), whatever link it holds for it just now. */
function identityOf(url: URL): string {
  const value = url.searchParams.get("k") ?? "";
  return value.length <= MAX_IDENTITY_LENGTH ? value : "";
}

function send(res: ServerResponse, status: number, body: string | Uint8Array, type: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(body);
}

/**
 * A refusal for capacity: the app shows the line, or why the stream stopped,
 * and never takes it for a fault of the file or its server.
 */
function sendCapacity(res: ServerResponse, capacity: "full" | "evicted" | "prewarm", reason: CapacityReason): void {
  send(res, 503, JSON.stringify({ error: "The server is at capacity", capacity, reason }), "application/json", { [CAPACITY_HEADER]: capacity, "Retry-After": "15" });
}

const MAX_BODY_BYTES = 4096;

/** A small JSON body (the capacity routes take nothing larger). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new VodError("request too large", 413);
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    throw new VodError("bad request body", 400);
  }
}

const SEAT_ID = /^[a-f0-9]{24}$/;
const MAX_HEIGHT = 4320;
const MAX_BITRATE_BPS = 400e6;

function bodyWatcher(body: Record<string, unknown>): string {
  return typeof body.watcher === "string" && /^[a-f0-9]{1,32}$/.test(body.watcher) ? body.watcher : "";
}

/** The stream a seat is asked for, as the app described it; what is missing is assumed (see streamCost). */
function bodyStream(body: Record<string, unknown>): StreamDescription {
  const height = Number(body.height);
  const bitrate = Number(body.bitrateBps);
  return {
    delivery: body.delivery === "web" || body.delivery === "direct" ? body.delivery : "remux",
    height: Number.isFinite(height) && height > 0 ? Math.min(MAX_HEIGHT, Math.round(height)) : 0,
    bitrateBps: Number.isFinite(bitrate) && bitrate > 0 ? Math.min(MAX_BITRATE_BPS, bitrate) : 0,
    remote: body.remote === true,
  };
}

function sendError(res: ServerResponse, err: unknown): void {
  // Every run taken by someone watching: a full server, never the file's fault.
  if (err instanceof VodCapacityError) return sendCapacity(res, "full", "seats");
  const status = err instanceof VodError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  // Said apart from the body, so the app can tell a file that will never play from a request that failed.
  send(res, status, JSON.stringify({ error: message }), "application/json", message === UNUSABLE_ENTRY || (err instanceof VodError && err.permanent) ? { [UNUSABLE_HEADER]: "1" } : {});
}

mkdirSync(CACHE_DIR, { recursive: true });
configureVod({ proxyBase: `http://127.0.0.1:${PORT}`, cacheRoot: CACHE_DIR });
// Nothing can reach what the process before this one made.
void removeCacheLeftovers(CACHE_DIR, isLiveVodDir).then((removed) => {
  if (removed) console.log(`[vod] removed ${removed} folder(s) left in the cache by an earlier run`);
});
startVodJanitor();

/**
 * Viewers heard from lately: any request that names its watcher. Kept here,
 * not in a session, since a viewer can ask for a file before it has a session.
 */
const viewers = new ViewerTracker();

/**
 * The capacity governor (governor.ts, docs/CAPACITY.md): reads the machine
 * every second, judges its level, and while it is in danger stops streams one
 * at a time, so a crowd costs a few viewers their stream, not everyone theirs.
 */
const governor = new Governor(governorConfigFromEnv());
const machine = new MachineReader();
const loopLag = new LoopLag();
loopLag.start();
if (!machine.hasTemperature) console.log("[capacity] no CPU temperature sensor is readable: the governor judges by CPU, memory and playback");
const GOVERNOR_TICK_MS = 1000;

/** Readings a drill pretends (CAPACITY_DRILL_FILE holds them), so the line and the stops can be tried on purpose. */
interface Drill {
  temperatureC?: number;
  memoryCommittedBytes?: number;
  loopLagMs?: number;
}

function readDrill(): Drill | null {
  const path = process.env.CAPACITY_DRILL_FILE;
  if (!path || !existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? (value as Drill) : null;
  } catch {
    return null;
  }
}

/** The governor's readings, rounded, for the events that name them. */
function capacityReadings(): Record<string, number | string | null> {
  const s = governor.snapshot();
  return {
    level: s.level,
    seats: s.seats,
    queue: s.queue,
    cpuCores: Math.round(s.measured.cpuCores * 100) / 100,
    cpuLimitCores: s.measured.cpuLimitCores,
    throttled: Math.round(s.measured.throttledShare * 100) / 100,
    memoryCommittedBytes: Math.round(s.measured.memoryBytes),
    temperatureC: s.measured.temperatureC === null ? null : Math.round(s.measured.temperatureC * 10) / 10,
    loopLagMs: Math.round(s.measured.loopLagMs),
    downBps: Math.round(s.measured.downBps),
  };
}

let networkBefore = readContainerNetwork();
let networkBeforeAt = Date.now();
let levelBefore = governor.currentLevel;

/**
 * The live dashboard's window (live.ts): an hour of readings every 5 s, the
 * moments worth showing, and the CPU and bandwidth of each run and session
 * measured between those readings.
 */
const liveHistory = new LiveHistory();
const liveEvents = new LiveEvents();
const runCpu = new CpuRates();
/** CPU share of each run's ffmpeg (fraction of a core), and each session's rates, as of the last reading. */
let runCpuNow = new Map<number, number>();
let sessionRatesNow = new Map<string, { servedBps: number; upstreamBps: number }>();
let sessionBytesBefore = new Map<string, { at: number; served: number; upstream: number }>();
let liveNetworkBefore = readContainerNetwork();
let liveNetworkBeforeAt = Date.now();
let liveAt = 0;

function liveSample(now: number): void {
  const s = governor.snapshot();
  const network = readContainerNetwork();
  const seconds = (now - liveNetworkBeforeAt) / 1000;
  const rx = network && liveNetworkBefore ? bitsPerSecond(liveNetworkBefore.rxBytes, network.rxBytes, seconds) : null;
  const tx = network && liveNetworkBefore ? bitsPerSecond(liveNetworkBefore.txBytes, network.txBytes, seconds) : null;
  liveNetworkBefore = network;
  liveNetworkBeforeAt = now;
  liveHistory.push({
    at: now,
    level: s.level === "ok" ? 0 : s.level === "busy" ? 1 : 2,
    seats: s.seats,
    queue: s.queue,
    viewers: viewers.count(now),
    cpuCores: Math.round(s.measured.cpuCores * 100) / 100,
    cpuLimitCores: s.measured.cpuLimitCores,
    memoryBytes: Math.round(s.measured.memoryBytes),
    memoryLimitBytes: Number.isFinite(s.measured.memoryLimitBytes) ? s.measured.memoryLimitBytes : 0,
    temperatureC: s.measured.temperatureC === null ? null : Math.round(s.measured.temperatureC * 10) / 10,
    loopLagMs: Math.round(s.measured.loopLagMs),
    rxBps: Math.round(rx ?? 0),
    txBps: Math.round(tx ?? 0),
  });
  const detail = vodSessionsDetail(now);
  const pids = new Set<number>();
  const cpu = new Map<number, number>();
  const rates = new Map<string, { servedBps: number; upstreamBps: number }>();
  const bytes = new Map<string, { at: number; served: number; upstream: number }>();
  for (const session of detail) {
    for (const run of session.runs) {
      if (!run.pid) continue;
      pids.add(run.pid);
      const rate = runCpu.rate(run.pid, now);
      if (rate !== null) cpu.set(run.pid, rate);
    }
    const before = sessionBytesBefore.get(session.id);
    bytes.set(session.id, { at: now, served: session.bytesServed, upstream: session.bytesUpstream });
    if (before && now > before.at) {
      const dt = (now - before.at) / 1000;
      rates.set(session.id, {
        servedBps: Math.max(0, ((session.bytesServed - before.served) * 8) / dt),
        upstreamBps: Math.max(0, ((session.bytesUpstream - before.upstream) * 8) / dt),
      });
    }
  }
  runCpu.keepOnly(pids);
  runCpuNow = cpu;
  sessionRatesNow = rates;
  sessionBytesBefore = bytes;
}

function governorTick(): void {
  const now = Date.now();
  const drill = readDrill();
  const reading: MachineReading = {
    ...machine.read(now),
    // The main thread alone: the process's figure adds its networking and garbage-collection threads.
    processCpuSeconds: mainThreadCpuSeconds() ?? cpuSecondsUsed(),
    ...(typeof drill?.temperatureC === "number" ? { temperatureC: drill.temperatureC } : {}),
    ...(typeof drill?.memoryCommittedBytes === "number" ? { memoryCommittedBytes: drill.memoryCommittedBytes } : {}),
  };
  const network = readContainerNetwork();
  const downBps = network && networkBefore ? bitsPerSecond(networkBefore.rxBytes, network.rxBytes, (now - networkBeforeAt) / 1000) : null;
  networkBefore = network;
  networkBeforeAt = now;
  governor.setWarming(vodWarmingCount(now));
  governor.observe(reading, typeof drill?.loopLagMs === "number" ? drill.loopLagMs : loopLag.reading(), downBps);
  if (now - liveAt >= HISTORY_EVERY_MS) {
    liveAt = now;
    liveSample(now);
  }
  for (const eviction of governor.housekeeping()) {
    const runs = eviction.sessionId ? stopViewerRuns(eviction.sessionId, eviction.watcher, `capacity: ${eviction.reason}`) : 0;
    const kind = streamClass(eviction.stream.height);
    console.log(`[capacity] stopped a ${kind} ${eviction.stream.delivery} stream to protect the machine (${eviction.reason}); ${runs} run(s) ended`);
    liveEvents.add("evicted", { watcher: eviction.watcher, sessionId: eviction.sessionId, reason: eviction.reason, class: kind, heldS: Math.round(eviction.heldMs / 1000) });
    telemetry(() => {
      capacityEvictions.inc({ reason: eviction.reason });
      recordEvent("remux", "capacity_evict", {
        reason: eviction.reason,
        class: kind,
        delivery: eviction.stream.delivery,
        bitrateBps: Math.round(eviction.stream.bitrateBps),
        heldS: Math.round(eviction.heldMs / 1000),
        runsStopped: runs,
        ...capacityReadings(),
      });
    });
  }
  const level = governor.currentLevel;
  if (level !== levelBefore) {
    const reasons = governor.snapshot().reasons.join(",");
    const from = levelBefore;
    console.log(`[capacity] ${from} -> ${level}${reasons ? ` (${reasons})` : ""}`);
    liveEvents.add("level", { from, to: level, reasons });
    telemetry(() => recordEvent("remux", "capacity_level", { from, to: level, reasons, ...capacityReadings() }));
    levelBefore = level;
  }
}

setInterval(() => {
  try {
    governorTick();
  } catch (err) {
    console.log(`[capacity] tick failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}, GOVERNOR_TICK_MS).unref();

/** Counts a seat answer, and writes the moments worth keeping: joining the line, being let in after waiting, a full line. */
function noteSeatAnswer(answer: SeatAnswer, stream: StreamDescription): void {
  telemetry(() => {
    const kind = streamClass(stream.height);
    if (answer.status === "admitted") {
      capacityRequests.inc({ answer: "admitted" });
      if (answer.waitedMs > 0) {
        liveEvents.add("admitted", { class: kind, delivery: stream.delivery, waitedS: Math.round(answer.waitedMs / 1000) });
        capacityQueueWaitSeconds.observe(undefined, answer.waitedMs / 1000);
        recordEvent("remux", "capacity_admit", { class: kind, delivery: stream.delivery, waitedS: Math.round(answer.waitedMs / 1000), level: answer.level });
      }
    } else if (answer.status === "queued") {
      if (!answer.joined) return;
      capacityRequests.inc({ answer: "queued" });
      liveEvents.add("queued", { class: kind, delivery: stream.delivery, position: answer.position, reason: answer.reason });
      recordEvent("remux", "capacity_queue", { class: kind, delivery: stream.delivery, position: answer.position, reason: answer.reason, ...capacityReadings() });
    } else {
      capacityRequests.inc({ answer: "full" });
      liveEvents.add("full", { class: kind, delivery: stream.delivery, reason: answer.reason });
      recordEvent("remux", "capacity_full", { class: kind, delivery: stream.delivery, reason: answer.reason, ...capacityReadings() });
    }
  });
}

/** Why this request's viewer had their stream of this session stopped, or null (it was not, or it is not a session request). */
function evictionOf(url: URL): CapacityReason | null {
  const id = url.pathname.match(/^\/vod\/([a-f0-9]{24})\//)?.[1];
  const watcher = watcherOf(url);
  return id && watcher ? governor.evictedFrom(id, watcher) : null;
}

metrics().onCollect(() => {
  const s = governor.snapshot();
  capacityLevel.set(undefined, s.level === "ok" ? 0 : s.level === "busy" ? 1 : 2);
  capacityReasons.reset();
  for (const reason of s.reasons) capacityReasons.set({ reason }, 1);
  for (const [kind, count] of Object.entries(s.seatsByClass)) capacitySeats.set({ class: kind }, count);
  capacityQueue.set(undefined, s.queue);
  for (const [resource, use] of Object.entries(s.use)) capacityUse.set({ resource }, use);
  capacityCpuCores.set({ kind: "used" }, s.measured.cpuCores);
  capacityCpuCores.set({ kind: "limit" }, s.measured.cpuLimitCores);
  capacityCpuCores.set({ kind: "remuxer" }, s.measured.remuxerCores);
  capacityThrottled.set(undefined, s.measured.throttledShare);
  capacityMemoryBytes.set({ kind: "committed" }, s.measured.memoryBytes);
  capacityMemoryBytes.set({ kind: "limit" }, s.measured.memoryLimitBytes);
  if (s.measured.temperatureC !== null) capacityTemperature.set(undefined, s.measured.temperatureC);
  capacityLoopLag.set(undefined, s.measured.loopLagMs / 1000);
});

// The gauges of a scrape, set from the state at the moment of the scrape. Each
// collector stands alone, so one that fails leaves the others to report.
metrics().onCollect(() => {
  const live = vodLiveState();
  remuxSessions.set(undefined, live.sessions);
  // Rebuilt each time, so a CDN that has no connections in use any more is not left reporting its last count.
  remuxRuns.reset();
  remuxRuns.set({ paused: "true" }, live.pausedRuns);
  remuxRuns.set({ paused: "false" }, live.runningRuns);
  proxyLanes.reset();
  for (const [cdn, lanes] of live.lanesByCdn) proxyLanes.set({ cdn }, lanes);
});
metrics().onCollect(() => remuxViewers.set(undefined, viewers.count(Date.now())));
metrics().onCollect(() => {
  const storage = cacheStorage();
  remuxCacheBytes.set(undefined, storage.cacheBytes);
  remuxDiskFreeBytes.set(undefined, storage.diskFreeBytes);
});
metrics().onCollect(() => {
  const net = readContainerNetwork();
  if (!net) return;
  containerNetworkBytes.set({ direction: "rx" }, net.rxBytes);
  containerNetworkBytes.set({ direction: "tx" }, net.txBytes);
});
metrics().onCollect(() => {
  processResidentBytes.set({ process: "remuxer" }, process.memoryUsage().rss);
  processCpuSeconds.set({ process: "remuxer" }, cpuSecondsUsed());
});

/** The process's CPU time so far, user and system together, in seconds. */
function cpuSecondsUsed(): number {
  const cpu = process.cpuUsage();
  return (cpu.user + cpu.system) / 1_000_000;
}

function capacitySample(at: number): CapacitySample {
  const net = readContainerNetwork();
  return {
    at,
    rxBytes: net?.rxBytes ?? null,
    txBytes: net?.txBytes ?? null,
    upstreamBytes: totals.upstreamBytes,
    servedBytes: totals.servedBytes,
    cpuSeconds: cpuSecondsUsed(),
  };
}

/** Once a minute, the capacity snapshot: how busy the process and its container were over the minute before. */
const CAPACITY_INTERVAL_MS = 60_000;
let capacityBefore = capacitySample(Date.now());
const capacityTimer = setInterval(() => {
  telemetry(() => {
    const now = capacitySample(Date.now());
    const rates = capacityRates(capacityBefore, now);
    capacityBefore = now;
    const live = vodLiveState();
    const storage = cacheStorage(now.at);
    recordEvent("remux", "capacity_snapshot", {
      ...capacitySnapshotFields({
        sessions: live.sessions,
        runs: live.pausedRuns + live.runningRuns,
        pausedRuns: live.pausedRuns,
        viewers: viewers.count(now.at),
        rates,
        loadAvg1: loadavg()[0] ?? 0,
        rssBytes: process.memoryUsage().rss,
        cacheBytes: storage.cacheBytes,
        diskFreeBytes: storage.diskFreeBytes,
      }),
      // The governor's view at the same minute: how near the machine was to its limit.
      ...capacityReadings(),
    });
  });
}, CAPACITY_INTERVAL_MS);
capacityTimer.unref();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  telemetry(() => viewers.touch(watcherOf(url), Date.now()));
  try {
    if (url.pathname === "/health") {
      return send(res, 200, JSON.stringify({ ok: true, ...vodStats() }), "application/json");
    }
    if (url.pathname === "/metrics") {
      return send(res, 200, metrics().render(), "text/plain; version=0.0.4; charset=utf-8");
    }
    if (url.pathname === "/capacity") {
      return send(res, 200, JSON.stringify(governor.snapshot()), "application/json");
    }
    if (url.pathname === "/capacity/live") {
      const minutes = Math.min(60, Math.max(1, Number(url.searchParams.get("minutes")) || 60));
      const sessions = vodSessionsDetail().map((session) => ({
        ...session,
        ...(sessionRatesNow.get(session.id) ?? { servedBps: 0, upstreamBps: 0 }),
        runs: session.runs.map((run) => ({ ...run, cpu: run.pid ? (runCpuNow.get(run.pid) ?? null) : null })),
      }));
      return send(
        res,
        200,
        JSON.stringify({
          snapshot: governor.snapshot(),
          seats: governor.seatsDetail(),
          queue: governor.queueDetail(),
          sessions,
          history: liveHistory.since(minutes * 60_000),
          events: liveEvents.recent(),
          viewers: viewers.count(Date.now()),
          remuxerCpuSeconds: cpuSecondsUsed(),
        }),
        "application/json"
      );
    }
    if (url.pathname === "/capacity/seat" && req.method === "POST") {
      const body = await readJsonBody(req);
      const watcher = bodyWatcher(body);
      if (!watcher) return send(res, 400, JSON.stringify({ error: "watcher required" }), "application/json");
      const stream = bodyStream(body);
      const ticket = typeof body.ticket === "string" && SEAT_ID.test(body.ticket) ? body.ticket : undefined;
      // Taking a lapsed seat back is for a stream playing here now that holds no seat, not a way past the line:
      // never more seats than streams this viewer has playing.
      const playing = body.resume === true ? watcherActiveSessions(watcher) : [];
      const resume = playing.length > governor.activeSeatCount(watcher);
      const answer = governor.request({ watcher, priority: body.priority === 1 ? 1 : 0, stream, ticket, resume });
      if (resume && answer.status === "admitted" && answer.seat) {
        const unseated = playing.find((id) => !governor.seated(id, watcher));
        if (unseated) governor.attach(answer.seat, watcher, unseated);
      }
      noteSeatAnswer(answer, stream);
      return send(res, 200, JSON.stringify(answer), "application/json");
    }
    const seatAction = url.pathname.match(/^\/capacity\/seat\/([a-f0-9]{24})\/(renew|release)$/);
    if (seatAction && req.method === "POST") {
      const body = await readJsonBody(req);
      const watcher = bodyWatcher(body);
      if (seatAction[2] === "release") {
        governor.release(seatAction[1]!, watcher);
        return send(res, 204, "", "text/plain");
      }
      const described = body.stream && typeof body.stream === "object" ? bodyStream(body.stream as Record<string, unknown>) : undefined;
      const answer = governor.renew(seatAction[1]!, watcher, { stalls: Number(body.stalls) || 0, playing: body.playing === true, stream: described });
      return send(res, 200, JSON.stringify(answer), "application/json");
    }
    if (url.pathname === "/vod/open") {
      const input = url.searchParams.get("u") ?? "";
      if (!/^https?:\/\//.test(input)) return send(res, 400, JSON.stringify({ error: "bad url" }), "application/json");
      const startAt = Math.min(MAX_START_AT_S, Math.max(0, Number(url.searchParams.get("startAt")) || 0));
      const viewer = { decodesDolbyVision: url.searchParams.get("dolbyVision") === "1", audio: parseAudioCaps(url.searchParams.get("audioCaps")) };
      const prewarm = url.searchParams.get("prewarm") === "1";
      // The file's size as the debrid service gave it, when the app knew it (see httpRangeFetcher).
      const size = Number(url.searchParams.get("size"));
      const sizeHint = Number.isSafeInteger(size) && size > 0 ? size : undefined;
      const audio = parseAudio(url);
      const watcher = watcherOf(url);
      const identity = identityOf(url);
      // The seat this stream plays under (governor.ts). A prewarm needs room to spare; a stream opened without a
      // seat (a page from before the governor) is let in on the spot only when it fits.
      let seat = url.searchParams.get("seat") ?? "";
      let unasked = false;
      if (prewarm) {
        if (!governor.prewarmAllowed()) {
          telemetry(() => capacityRequests.inc({ answer: "prewarm_refused" }));
          return sendCapacity(res, "prewarm", governor.snapshot().reasons[0] ?? "seats");
        }
        seat = "";
      } else {
        const id = vodSessionId(input, audio, viewer, identity);
        const given = SEAT_ID.test(seat) ? governor.seatState(seat, watcher) : { state: "unknown" as const };
        // Stopped to protect the machine: the page shows why, and its stream does not come back by another way.
        if (given.state === "evicted") return sendCapacity(res, "evicted", given.reason);
        const seated = given.state === "active" && governor.attach(seat, watcher, id);
        if (!seated) seat = "";
        if (!seated && !governor.seated(id, watcher)) {
          const asked = governor.admitUnasked(watcher, { delivery: "remux", height: Number(url.searchParams.get("height")) || 2160, bitrateBps: 0, remote: false });
          if ("refused" in asked) {
            telemetry(() => capacityRequests.inc({ answer: "unasked_refused" }));
            return sendCapacity(res, "full", asked.refused);
          }
          telemetry(() => capacityRequests.inc({ answer: "unasked_admitted" }));
          seat = asked.seat;
          unasked = true;
          governor.attach(seat, watcher, id);
        }
      }
      try {
        const info = await openVodSession(CACHE_DIR, input, audio, startAt, viewer, prewarm, watcher, identity, sizeHint);
        // The file's own bitrate, and whether its sound is re-encoded, replace what the page guessed.
        if (seat) governor.attach(seat, watcher, info.id, info.bitrateBps, info.audio ? info.audio.delivery !== "copy" : undefined);
        return send(res, 200, JSON.stringify(info), "application/json");
      } catch (err) {
        // A seat given out here for a file that would not open is nobody's; one the page asked for stays theirs for the next source.
        if (unasked) governor.release(seat, watcher);
        throw err;
      }
    }
    const src = url.pathname.match(/^\/src\/([a-f0-9]{24})$/);
    if (src) {
      const source = vodSource(src[1]!);
      if (!source) return send(res, 404, "not found", "text/plain");
      return await serveRange(req, res, source);
    }
    const left = url.pathname.match(/^\/vod\/([a-f0-9]{24})\/leave$/);
    if (left) {
      leaveVodSession(left[1]!);
      return send(res, 204, "", "text/plain");
    }
    const subs = url.pathname.match(/^\/vod\/([a-f0-9]{24})\/sub-(\d{1,2})\.json$/);
    if (subs) return send(res, 200, JSON.stringify({ cues: vodSubtitleCues(subs[1]!, Number(subs[2])) }), "application/json");
    const match = url.pathname.match(/^\/vod\/([a-f0-9]+)\/(index\.m3u8|slices\.m3u8|init\.mp4|(s?)(\d+)\.m4s)$/);
    if (!match || !SESSION_ID.test(match[1]!)) return send(res, 404, "not found", "text/plain");
    const [, id, file, sliced, number] = match;
    const watcher = watcherOf(url);
    // A stream stopped to protect the machine gets nothing more, so no run is started again for it.
    const evicted = watcher ? governor.evictedFrom(id!, watcher) : null;
    if (evicted) return sendCapacity(res, "evicted", evicted);
    if (watcher) governor.touch(id!, watcher);
    if (file === "index.m3u8") return send(res, 200, vodPlaylist(id!), "application/vnd.apple.mpegurl");
    if (file === "slices.m3u8") return send(res, 200, vodPlaylist(id!, true), "application/vnd.apple.mpegurl");
    if (file === "init.mp4") {
      const init = await vodInit(id!, watcher);
      send(res, 200, init, "video/mp4");
      noteServed(id!, "init", init.length);
      return;
    }
    // Streamed: each keyframe group is sent as soon as it exists, so the
    // player can start decoding before the whole segment has been produced.
    let started = false;
    let gone = false;
    let resume = (): void => {};
    const stopWatching = onClientGone(req, res, () => {
      gone = true;
      resume();
    });
    try {
      // A stream stopped to protect the machine mid-request stops here too: no run is started again for it.
      const stop = () => gone || (watcher !== "" && governor.evictedFrom(id!, watcher) !== null);
      const fragments = sliced ? vodSlice(id!, Number(number), stop, watcher) : vodSegment(id!, Number(number), stop, watcher);
      for await (const path of fragments) {
        if (gone) break;
        if (!started) {
          res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
          started = true;
        }
        // Wait for the socket to drain, or for the player to hang up (a closed
        // socket never drains, and the loop would have waited forever).
        const fragment = readFragment(path);
        const drained = res.write(fragment);
        noteServed(id!, "fragment", fragment.length);
        if (!drained && !gone) {
          await new Promise<void>((resolve) => {
            resume = resolve;
            res.once("drain", resolve);
          });
        }
      }
    } finally {
      stopWatching();
    }
    if (gone) return;
    if (!started) res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
    res.end();
  } catch (err) {
    if (res.headersSent) res.destroy();
    else {
      // A slice cut short because its viewer's stream was stopped: they hear why, not that the file failed.
      const evicted = evictionOf(url);
      if (evicted) sendCapacity(res, "evicted", evicted);
      else sendError(res, err);
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[remuxer] listening on 127.0.0.1:${PORT}, cache ${CACHE_DIR}`);
});

function shutdown(): void {
  stopAllVodRuns();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// The daily rollups of the event log (docs/TELEMETRY.md): two minutes after start, then hourly. A failure is logged and tried again within the hour.
const rollupsRun = (): void => void writeRollups().catch((err: unknown) => console.log(`[rollups] ${err instanceof Error ? err.message : String(err)}`));
setTimeout(rollupsRun, 2 * 60_000).unref();
setInterval(rollupsRun, 60 * 60_000).unref();

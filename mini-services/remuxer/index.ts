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
 */

import { createServer, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { loadavg } from "node:os";
import type { AudioPreference } from "../../src/lib/profile-preferences";
import { UNUSABLE_HEADER } from "../../src/lib/playback/remuxer";
import { parseAudioCaps } from "../../src/lib/playback/decode-capability";
import { recordEvent } from "../../src/lib/event-log";
import { metrics } from "../../src/lib/metrics";
import { writeRollups } from "../../src/lib/telemetry/rollups";
import { onClientGone, serveRange } from "./source-proxy";
import { removeCacheLeftovers } from "./cache-leftovers";
import {
  capacityRates,
  capacitySnapshotFields,
  readContainerNetwork,
  ViewerTracker,
  type CapacitySample,
} from "./capacity";
import {
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
  startVodJanitor,
  stopAllVodRuns,
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

function sendError(res: ServerResponse, err: unknown): void {
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
    recordEvent(
      "remux",
      "capacity_snapshot",
      capacitySnapshotFields({
        sessions: live.sessions,
        runs: live.pausedRuns + live.runningRuns,
        pausedRuns: live.pausedRuns,
        viewers: viewers.count(now.at),
        rates,
        loadAvg1: loadavg()[0] ?? 0,
        rssBytes: process.memoryUsage().rss,
        cacheBytes: storage.cacheBytes,
        diskFreeBytes: storage.diskFreeBytes,
      })
    );
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
    if (url.pathname === "/vod/open") {
      const input = url.searchParams.get("u") ?? "";
      if (!/^https?:\/\//.test(input)) return send(res, 400, JSON.stringify({ error: "bad url" }), "application/json");
      const startAt = Math.min(MAX_START_AT_S, Math.max(0, Number(url.searchParams.get("startAt")) || 0));
      const viewer = { decodesDolbyVision: url.searchParams.get("dolbyVision") === "1", audio: parseAudioCaps(url.searchParams.get("audioCaps")) };
      const prewarm = url.searchParams.get("prewarm") === "1";
      // The file's size as the debrid service gave it, when the app knew it (see httpRangeFetcher).
      const size = Number(url.searchParams.get("size"));
      const sizeHint = Number.isSafeInteger(size) && size > 0 ? size : undefined;
      const info = await openVodSession(CACHE_DIR, input, parseAudio(url), startAt, viewer, prewarm, watcherOf(url), identityOf(url), sizeHint);
      return send(res, 200, JSON.stringify(info), "application/json");
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
    if (file === "index.m3u8") return send(res, 200, vodPlaylist(id!), "application/vnd.apple.mpegurl");
    if (file === "slices.m3u8") return send(res, 200, vodPlaylist(id!, true), "application/vnd.apple.mpegurl");
    const watcher = watcherOf(url);
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
      const fragments = sliced ? vodSlice(id!, Number(number), () => gone, watcher) : vodSegment(id!, Number(number), () => gone, watcher);
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
    if (!res.headersSent) sendError(res, err);
    else res.destroy();
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

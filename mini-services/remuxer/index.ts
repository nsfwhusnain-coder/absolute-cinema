/**
 * Absolute Cinema remuxer — serves MKV releases (where nearly all 4K lives)
 * as seekable HLS video-on-demand without re-encoding video.
 *
 * Internal only (127.0.0.1:3040); the Next.js app authenticates viewers and
 * proxies these routes.
 *
 *   GET /vod/open?u=<url>&audioPreference=&originalLanguage=&audioLanguage=&audioIndex=&startAt=
 *        → { id, durationS, segments, videoCodecId, audio, audioIndex, audioTracks, subtitles }
 *   GET /vod/<id>/index.m3u8   complete VOD playlist
 *   GET /vod/<id>/init.mp4     initialisation segment
 *   GET /vod/<id>/<n>.m4s      media segment n (produced on demand)
 *   GET /vod/<id>/sub-<k>.json text subtitle track k: cues produced so far
 *   GET /health
 */

import { createServer, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import type { AudioPreference } from "../../src/lib/profile-preferences";
import { serveRange } from "./source-proxy";
import {
  VodError,
  configureVod,
  openVodSession,
  readFragment,
  startVodJanitor,
  stopAllVodRuns,
  vodInit,
  vodPlaylist,
  vodSubtitleCues,
  type VodAudioRequest,
  vodSegment,
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

function send(res: ServerResponse, status: number, body: string | Uint8Array, type: string): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendError(res: ServerResponse, err: unknown): void {
  const status = err instanceof VodError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  send(res, status, JSON.stringify({ error: message }), "application/json");
}

mkdirSync(CACHE_DIR, { recursive: true });
configureVod({ proxyBase: `http://127.0.0.1:${PORT}` });
startVodJanitor();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/health") {
      return send(res, 200, JSON.stringify({ ok: true, ...vodStats() }), "application/json");
    }
    if (url.pathname === "/vod/open") {
      const input = url.searchParams.get("u") ?? "";
      if (!/^https?:\/\//.test(input)) return send(res, 400, JSON.stringify({ error: "bad url" }), "application/json");
      const startAt = Math.min(MAX_START_AT_S, Math.max(0, Number(url.searchParams.get("startAt")) || 0));
      const info = await openVodSession(CACHE_DIR, input, parseAudio(url), startAt);
      return send(res, 200, JSON.stringify(info), "application/json");
    }
    const src = url.pathname.match(/^\/src\/([a-f0-9]{24})$/);
    if (src) {
      const source = vodSource(src[1]!);
      if (!source) return send(res, 404, "not found", "text/plain");
      return await serveRange(req, res, source);
    }
    const subs = url.pathname.match(/^\/vod\/([a-f0-9]{24})\/sub-(\d{1,2})\.json$/);
    if (subs) return send(res, 200, JSON.stringify({ cues: vodSubtitleCues(subs[1]!, Number(subs[2])) }), "application/json");
    const match = url.pathname.match(/^\/vod\/([a-f0-9]+)\/(index\.m3u8|init\.mp4|(\d+)\.m4s)$/);
    if (!match || !SESSION_ID.test(match[1]!)) return send(res, 404, "not found", "text/plain");
    const [, id, file, segment] = match;
    if (file === "index.m3u8") return send(res, 200, vodPlaylist(id!), "application/vnd.apple.mpegurl");
    if (file === "init.mp4") return send(res, 200, await vodInit(id!), "video/mp4");
    // Streamed: each keyframe group is sent as soon as it exists, so the
    // player can start decoding before the whole segment has been produced.
    let started = false;
    for await (const path of vodSegment(id!, Number(segment))) {
      if (!started) {
        res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
        started = true;
      }
      if (!res.write(readFragment(path))) await new Promise((resolve) => res.once("drain", resolve));
    }
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

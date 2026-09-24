/**
 * Keyframe-exact video-on-demand remux sessions.
 *
 * Opening a title reads its Matroska keyframe index and builds a complete
 * segment plan (see vod-plan.ts), so the player gets the full timeline and
 * can seek anywhere immediately. Segments are produced on demand by ffmpeg
 * "runs" that stream-copy video (no re-encode) and convert audio to AAC.
 * A request for a segment no run will reach soon starts a new run right
 * there; runs that race too far ahead of the viewer are paused, and idle
 * sessions are cleaned up.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  selectAudioTrack,
  type AudioTrackSelection,
  type SelectableMediaTrack,
} from "../../src/lib/playback/track-selection";
import { httpRangeFetcher, readMkvKeyframes, type MkvAudioTrack } from "./mkv-cues";
import type { ProxySource } from "./source-proxy";
import { firstVideoDecodeTime, readVideoTrackInfo, stripEditLists, type VideoTrackInfo } from "./mp4-boxes";
import {
  Fmp4StreamSplitter,
  KEYFRAME_MATCH_TOLERANCE_S,
  buildVodPlaylist,
  computeSegmentBounds,
  fragmentsForSegment,
  segmentForTime,
  type FragmentRecord,
} from "./vod-plan";

const VOD_VERSION = "vod-v1";
const RANGE_TIMEOUT_MS = 15_000;
/** How far ahead of the newest requested segment a run may produce before pausing. */
const AHEAD_PAUSE_S = 240;
const AHEAD_RESUME_S = 120;
/** A run within this distance (behind the requested segment) will get there soon. */
const REACH_S = 40;
/** Runs of a session nobody has requested from recently are stopped. */
const RUN_IDLE_MS = 3 * 60 * 1000;
/** Whole sessions (and their files) are removed after this long unused. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const SEGMENT_WAIT_MS = 45_000;
const INIT_WAIT_MS = 30_000;
const POLL_MS = 100;
const MAX_RUNS_PER_SESSION = 2;
const MAX_FAILED_RUNS_PER_SEGMENT = 2;
const AUDIO_BITRATE = "192k";
const FRAGMENT_MAX_US = 1_000_000;
const JANITOR_INTERVAL_MS = 30_000;

const MAX_RUNS_TOTAL = Number(process.env.VOD_MAX_RUNS || 4);
const CACHE_MAX_BYTES = Number(process.env.REMUX_CACHE_MAX_BYTES || 50 * 1024 ** 3);
/** Refuse to start new work below this much free disk (after trying to reclaim space). */
const MIN_FREE_BYTES = Number(process.env.REMUX_MIN_FREE_BYTES || 5 * 1024 ** 3);

function freeBytes(dir: string): number {
  try {
    const fs = statfsSync(dir);
    return fs.bavail * fs.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export class VodError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

interface Run {
  id: number;
  startSegment: number;
  proc: ChildProcess;
  startTime: number;
  fragments: FragmentRecord[];
  finished: boolean;
  failed: boolean;
  paused: boolean;
  dir: string;
}

interface Session {
  id: string;
  url: string;
  source: ProxySource;
  dir: string;
  bounds: number[];
  keyframes: number[];
  durationS: number;
  audioIndex: number | null;
  hevc: boolean;
  init: Uint8Array | null;
  video: VideoTrackInfo | null;
  runs: Run[];
  nextRunId: number;
  lastRequestAt: number;
  wantedTime: number;
  info: VodSessionInfo;
}

export interface VodSessionInfo {
  id: string;
  durationS: number;
  segments: number;
  videoCodecId: string | null;
  dynamicRange: "SDR" | "PQ" | "HLG";
  audio: { language: string | null; name: string | null; channels: number | null; codecId: string } | null;
}

const sessions = new Map<string, Session>();
/** Base URL of this process's /src proxy; ffmpeg reads sources through it. */
let proxyBase = "";

export function configureVod(options: { proxyBase: string }): void {
  proxyBase = options.proxyBase;
}

export function vodSource(id: string): ProxySource | null {
  return sessions.get(id)?.source ?? null;
}
const opening = new Map<string, Promise<Session>>();

function log(message: string): void {
  console.log(`[vod] ${message}`);
}

function sessionId(url: string, audio: AudioTrackSelection): string {
  return createHash("sha256")
    .update([VOD_VERSION, url, audio.preference, audio.originalLanguage ?? "", audio.preferredLanguage ?? ""].join("|"))
    .digest("hex")
    .slice(0, 24);
}

function chooseAudio(tracks: MkvAudioTrack[], selection: AudioTrackSelection): MkvAudioTrack | null {
  if (!tracks.length) return null;
  const selectable: SelectableMediaTrack[] = tracks.map((t) => ({
    id: t.audioIndex,
    name: t.name ?? undefined,
    lang: t.language ?? undefined,
    default: t.isDefault,
    forced: t.isForced,
  }));
  const picked = selectAudioTrack(selectable, selection);
  return tracks.find((t) => t.audioIndex === picked?.id) ?? tracks[0]!;
}

/** Opens (or reuses) a session for a remote MKV. Throws VodError(415) when it cannot be indexed. */
export async function openVodSession(
  cacheRoot: string,
  url: string,
  audio: AudioTrackSelection,
  startAtS = 0
): Promise<VodSessionInfo> {
  const id = sessionId(url, audio);
  let session = sessions.get(id);
  if (!session) {
    let pending = opening.get(id);
    if (!pending) {
      pending = createSession(cacheRoot, id, url, audio).finally(() => opening.delete(id));
      opening.set(id, pending);
    }
    session = await pending;
  }
  session.lastRequestAt = Date.now();
  // Prewarm where the viewer will start, so the init and first segment are
  // already being produced when the player asks.
  const startSegment = segmentForTime(session.bounds, startAtS);
  session.wantedTime = session.bounds[startSegment]!;
  if (!runReaching(session, startSegment)) startRun(session, startSegment);
  return session.info;
}

async function createSession(cacheRoot: string, id: string, url: string, audio: AudioTrackSelection): Promise<Session> {
  const fetcher = httpRangeFetcher(url, RANGE_TIMEOUT_MS);
  const index = await readMkvKeyframes(fetcher).catch((err: unknown) => {
    throw new VodError(`index read failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  });
  if (!index) throw new VodError("source has no keyframe index", 415);
  const totalSize = fetcher.size();
  if (!totalSize) throw new VodError("source size unknown", 502);
  const audioTrack = chooseAudio(index.audioTracks, audio);
  const bounds = computeSegmentBounds(index.keyframes, index.durationS);
  const dir = join(cacheRoot, `vod-${id}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const session: Session = {
    id,
    url,
    source: { url, totalSize, cached: index.fetched },
    dir,
    bounds,
    keyframes: index.keyframes,
    durationS: index.durationS,
    audioIndex: audioTrack?.audioIndex ?? null,
    hevc: /HEVC/i.test(index.videoCodecId ?? ""),
    init: null,
    video: null,
    runs: [],
    nextRunId: 0,
    lastRequestAt: Date.now(),
    wantedTime: 0,
    info: {
      id,
      durationS: index.durationS,
      segments: bounds.length - 1,
      videoCodecId: index.videoCodecId,
      dynamicRange: index.dynamicRange,
      audio: audioTrack
        ? { language: audioTrack.language, name: audioTrack.name, channels: audioTrack.channels, codecId: audioTrack.codecId }
        : null,
    },
  };
  sessions.set(id, session);
  log(`open ${id}: ${index.durationS.toFixed(0)}s, ${bounds.length - 1} segments, ${index.keyframes.length} keyframes, audio #${session.audioIndex}`);
  return session;
}

function ffmpegArgs(session: Session, startTime: number): string[] {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
  ];
  // ffmpeg backs off slightly before the target and lands on the previous
  // keyframe; a small margin makes it land on the segment's own keyframe.
  if (startTime > 0) args.push("-ss", (startTime + 0.3).toFixed(3));
  args.push("-i", proxyBase ? `${proxyBase}/src/${session.id}` : session.url, "-map", "0:v:0");
  if (session.audioIndex !== null) {
    args.push("-map", `0:a:${session.audioIndex}`, "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "2");
  }
  args.push("-c:v", "copy");
  // Apple players and Safari MSE only accept HEVC tagged hvc1.
  if (session.hevc) args.push("-tag:v", "hvc1");
  args.push(
    "-copyts",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    // frag_discont + an explicit edit list make ffmpeg write absolute decode
    // times into every fragment (the default writes run-relative times).
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof+frag_discont",
    "-use_editlist", "1",
    // Also cut mid-GOP every second so the first bytes after a seek reach the
    // player without waiting for the next keyframe. Mid-GOP fragments simply
    // continue the segment their keyframe started.
    "-frag_duration", String(FRAGMENT_MAX_US),
    "-f", "mp4",
    "pipe:1"
  );
  return args;
}

function aliveRuns(session: Session): Run[] {
  return session.runs.filter((r) => !r.finished && !r.failed);
}

function lastTime(run: Run): number {
  return run.fragments.length ? run.fragments[run.fragments.length - 1]!.time : run.startTime;
}

/** An alive run that already covers, or will soon reach, the segment. */
function runReaching(session: Session, segment: number): Run | null {
  const target = session.bounds[segment]!;
  const candidates = aliveRuns(session).filter(
    (run) => run.startTime <= target + KEYFRAME_MATCH_TOLERANCE_S && lastTime(run) >= target - REACH_S
  );
  return candidates.sort((a, b) => lastTime(b) - lastTime(a))[0] ?? null;
}

function totalAliveRuns(): number {
  let count = 0;
  for (const session of sessions.values()) count += aliveRuns(session).length;
  return count;
}

function stopRun(run: Run, reason: string): void {
  if (run.finished || run.failed) return;
  run.finished = true;
  if (run.paused) run.proc.kill("SIGCONT");
  run.proc.kill("SIGKILL");
  log(`run ${run.id} stopped: ${reason}`);
}

function makeRoom(session: Session): void {
  const own = aliveRuns(session).sort((a, b) => lastTime(a) - lastTime(b));
  while (own.length >= MAX_RUNS_PER_SESSION) stopRun(own.shift()!, "session run limit");
  if (totalAliveRuns() < MAX_RUNS_TOTAL) return;
  const idleOthers = [...sessions.values()]
    .filter((s) => s !== session)
    .sort((a, b) => a.lastRequestAt - b.lastRequestAt);
  for (const other of idleOthers) {
    for (const run of aliveRuns(other)) stopRun(run, "global run limit");
    if (totalAliveRuns() < MAX_RUNS_TOTAL) return;
  }
  throw new VodError("remux capacity reached", 503);
}

function startRun(session: Session, segment: number): Run {
  if (freeBytes(session.dir) < MIN_FREE_BYTES) {
    reclaimDisk(session);
    if (freeBytes(session.dir) < MIN_FREE_BYTES) throw new VodError("not enough free disk space to remux", 507);
  }
  makeRoom(session);
  const startTime = session.bounds[segment]!;
  const id = session.nextRunId++;
  const dir = join(session.dir, `run-${id}`);
  mkdirSync(dir, { recursive: true });
  const proc = spawn("ffmpeg", ffmpegArgs(session, startTime), { stdio: ["ignore", "pipe", "pipe"] });
  const run: Run = { id, startSegment: segment, proc, startTime, fragments: [], finished: false, failed: false, paused: false, dir };
  session.runs.push(run);
  const splitter = new Fmp4StreamSplitter();
  let stderr = "";
  let seq = 0;
  proc.stdout!.on("data", (chunk: Buffer) => {
    let parts;
    try {
      parts = splitter.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (err) {
      stopRun(run, `bad stream: ${err instanceof Error ? err.message : String(err)}`);
      run.failed = true;
      return;
    }
    for (const part of parts) {
      if (part.kind === "init") {
        if (!session.init) {
          session.init = stripEditLists(part.bytes);
          session.video = readVideoTrackInfo(session.init);
        }
        continue;
      }
      if (!session.video) continue;
      const raw = firstVideoDecodeTime(part.bytes, session.video);
      if (raw === null) continue;
      const time = snapToKeyframe(session.keyframes, raw);
      const path = join(dir, `${seq++}.m4s`);
      writeFileSync(path, part.bytes);
      run.fragments.push({ time, path, bytes: part.bytes.length });
      throttle(session, run);
    }
  });
  proc.stderr!.on("data", (chunk: Buffer) => {
    if (stderr.length < 2000) stderr += chunk.toString();
  });
  proc.on("close", (code, signal) => {
    if (run.finished) return;
    if (code === 0) {
      run.finished = true;
    } else {
      run.failed = true;
      log(`run ${run.id} of ${session.id} failed (${code ?? signal}): ${stderr.trim().slice(0, 300)}`);
    }
  });
  proc.on("error", () => {
    run.failed = true;
  });
  log(`run ${id} of ${session.id} from segment ${segment} (${startTime.toFixed(1)}s)`);
  return run;
}

function snapToKeyframe(keyframes: readonly number[], t: number): number {
  let lo = 0;
  let hi = keyframes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  for (const i of [lo - 1, lo]) {
    const k = keyframes[i];
    if (k !== undefined && Math.abs(k - t) <= KEYFRAME_MATCH_TOLERANCE_S) return k;
  }
  return t;
}

/** Pause a run that has raced far ahead of the viewer; resume it as they catch up. */
function throttle(session: Session, run: Run): void {
  const lead = lastTime(run) - session.wantedTime;
  if (!run.paused && lead > AHEAD_PAUSE_S) {
    run.paused = true;
    run.proc.kill("SIGSTOP");
  } else if (run.paused && lead < AHEAD_RESUME_S) {
    run.paused = false;
    run.proc.kill("SIGCONT");
  }
}

function sessionOrThrow(id: string): Session {
  const session = sessions.get(id);
  if (!session) throw new VodError("unknown session", 404);
  session.lastRequestAt = Date.now();
  return session;
}

export function vodPlaylist(id: string): string {
  return buildVodPlaylist(sessionOrThrow(id).bounds);
}

export async function vodInit(id: string): Promise<Uint8Array> {
  const session = sessionOrThrow(id);
  const deadline = Date.now() + INIT_WAIT_MS;
  while (!session.init) {
    if (!aliveRuns(session).length) startRun(session, segmentForTime(session.bounds, session.wantedTime));
    if (Date.now() > deadline) throw new VodError("init not ready", 504);
    await sleep(POLL_MS);
  }
  return session.init;
}

/**
 * The fragments of segment `segment`, in order, as they become available.
 * A segment already complete in any run is yielded at once; otherwise the
 * run that will produce it is followed and each keyframe group is yielded
 * the moment it is written, so playback can begin before the segment ends.
 */
export async function* vodSegment(id: string, segment: number): AsyncGenerator<string> {
  const session = sessionOrThrow(id);
  if (!Number.isInteger(segment) || segment < 0 || segment >= session.bounds.length - 1) {
    throw new VodError("segment out of range", 404);
  }
  session.wantedTime = session.bounds[segment]!;
  for (const run of aliveRuns(session)) throttle(session, run);

  for (const run of [...session.runs].reverse()) {
    const complete = fragmentsForSegment(session.bounds, segment, run.fragments, run.finished);
    if (complete) {
      for (const fragment of complete) yield fragment.path;
      return;
    }
  }

  const start = session.bounds[segment]!;
  const end = session.bounds[segment + 1]!;
  const isLast = segment === session.bounds.length - 2;
  const deadline = Date.now() + SEGMENT_WAIT_MS;
  let run: Run | null = null;
  let cursor = -1;
  while (!run) {
    for (const candidate of [...session.runs].reverse()) {
      const first = candidate.fragments.findIndex((f) => f.time >= start - KEYFRAME_MATCH_TOLERANCE_S);
      if (first < 0) continue;
      if (first === 0 && candidate.fragments[0]!.time > start + KEYFRAME_MATCH_TOLERANCE_S) continue;
      run = candidate;
      cursor = first;
      break;
    }
    if (run) break;
    if (Date.now() > deadline) throw new VodError("segment not ready", 504);
    if (!runReaching(session, segment)) {
      const failed = session.runs.filter((r) => r.failed && r.startSegment === segment).length;
      if (failed >= MAX_FAILED_RUNS_PER_SEGMENT) throw new VodError("source failed to remux", 502);
      startRun(session, segment);
    }
    await sleep(POLL_MS);
  }

  for (;;) {
    while (cursor < run.fragments.length) {
      const fragment = run.fragments[cursor]!;
      if (!isLast && fragment.time >= end - KEYFRAME_MATCH_TOLERANCE_S) return;
      yield fragment.path;
      cursor++;
    }
    if (run.finished) return;
    if (run.failed) throw new VodError("remux run failed mid-segment", 502);
    if (Date.now() > deadline) throw new VodError("segment stalled", 504);
    session.lastRequestAt = Date.now();
    await sleep(POLL_MS);
  }
}

export function readFragment(path: string): Uint8Array {
  return readFileSync(path);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      total += entry.isDirectory() ? dirBytes(path) : statSync(path).size;
    }
  } catch {
    /* removed concurrently */
  }
  return total;
}

function removeSession(session: Session, reason: string): void {
  for (const run of session.runs) stopRun(run, reason);
  sessions.delete(session.id);
  rmSync(session.dir, { recursive: true, force: true });
  log(`session ${session.id} removed: ${reason}`);
}

/** Frees disk by removing other sessions, least recently used first. */
function reclaimDisk(keep: Session): void {
  const byAge = [...sessions.values()].filter((s) => s !== keep).sort((a, b) => a.lastRequestAt - b.lastRequestAt);
  for (const session of byAge) {
    if (freeBytes(keep.dir) >= MIN_FREE_BYTES) return;
    removeSession(session, "low disk");
  }
}

/** Stops idle runs, expires old sessions and keeps the cache under its byte cap. */
export function vodJanitor(): void {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    const idle = now - session.lastRequestAt;
    if (idle > SESSION_TTL_MS) {
      removeSession(session, "expired");
      continue;
    }
    if (idle > RUN_IDLE_MS) for (const run of aliveRuns(session)) stopRun(run, "idle");
  }
  let total = [...sessions.values()].reduce((sum, s) => sum + dirBytes(s.dir), 0);
  const byAge = [...sessions.values()].sort((a, b) => a.lastRequestAt - b.lastRequestAt);
  for (const session of byAge) {
    if (total <= CACHE_MAX_BYTES) break;
    if (now - session.lastRequestAt < RUN_IDLE_MS) continue;
    const bytes = dirBytes(session.dir);
    removeSession(session, "cache cap");
    total -= bytes;
  }
}

export function startVodJanitor(): void {
  setInterval(vodJanitor, JANITOR_INTERVAL_MS).unref();
}

export function stopAllVodRuns(): void {
  for (const session of sessions.values()) for (const run of session.runs) stopRun(run, "shutdown");
}

export function vodStats(): { sessions: number; runs: number } {
  return { sessions: sessions.size, runs: totalAliveRuns() };
}

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
import { httpRangeFetcher, readMkvKeyframes, type MkvAudioTrack, type MkvSubtitleTrack } from "./mkv-cues";
import { deliveredRange, dolbyVisionDelivery, type DeliveredRange } from "./dolby-vision";
import { VttStreamParser, type VttCue } from "./vtt-stream";
import type { ProxySource } from "./source-proxy";
import { firstVideoDecodeTime, readVideoTrackInfo, stripEditLists, type VideoTrackInfo } from "./mp4-boxes";
import {
  Fmp4StreamSplitter,
  KEYFRAME_MATCH_TOLERANCE_S,
  SLICE_PREFIX,
  buildVodPlaylist,
  computeSegmentBounds,
  computeSlicePlan,
  fragmentsInWindow,
  runCovers,
  segmentForTime,
  segmentWindow,
  sliceWindow,
  type FragmentRecord,
  type PlanWindow,
  type SlicePlan,
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
/**
 * A session opened ahead of Play (the viewer is on the title's page, or the
 * episode before is ending) gets this much made and then waits: enough to
 * start at once, little enough to throw away if Play never comes.
 */
const PREWARM_AHEAD_S = 12;
/** A prewarmed session nobody went on to play gives its run back after this long. */
const PREWARM_IDLE_MS = 75 * 1000;
/**
 * The source is read in pieces this size until someone plays: a piece keeps
 * arriving after its run is paused, and a full-size one is a lot to fetch for
 * a title that may only have been looked at.
 */
const PREWARM_WINDOW_BYTES = 24 * 1024 * 1024;
/** Whole sessions (and their files) are removed after this long unused. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const SEGMENT_WAIT_MS = 45_000;
const INIT_WAIT_MS = 20_000;
const POLL_MS = 100;
const MAX_RUNS_PER_SESSION = 2;
const MAX_FAILED_RUNS_PER_SEGMENT = 2;
const AUDIO_BITRATE = "192k";
/**
 * How much ffmpeg may read to identify the streams before it starts. A file
 * with image subtitles never satisfies it (those say nothing until a caption
 * appears), so it read the default 5 MB from the start of the file on every
 * start and every jump: one more request to the debrid CDN each time, three
 * seconds of it. Video and audio describe themselves in the header and their
 * first packets; this much holds those and fits in the indexed head.
 */
const FFMPEG_PROBE_BYTES = 1_500_000;
/** A run that has made nothing this long after starting is not going to. */
const FIRST_FRAGMENT_TIMEOUT_MS = 11_000;
/** Its first fragment may begin this far past the keyframe it was started at before the keyframe is called unusable. */
const ENTRY_TOLERANCE_S = 1;
/**
 * Fragments of sound alone a run may open with before its picture is given
 * up for lost. Some files (an AV1 stream with no header a copy can carry
 * over) yield their audio and never one frame of video: waiting out the
 * first-fragment timeout on those cost every viewer eleven seconds.
 */
const PICTURELESS_FRAGMENTS_MAX = 6;
/** Half a second: a slice (two seconds or so) then always holds several fragments, and never none. */
const FRAGMENT_MAX_US = 500_000;
const SEEK_POINT_DECIMALS = 3;
const JANITOR_INTERVAL_MS = 30_000;
/** Text subtitle tracks carried per session (each is one more ffmpeg output). */
const MAX_SUBTITLE_TRACKS = 6;
/** First ffmpeg output fd used for subtitles (0-2 are stdin/out/err). */
const SUBTITLE_FD_BASE = 3;

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

export const UNUSABLE_ENTRY = "source cannot be started at this position";

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
  /**
   * It could not begin at its keyframe: ffmpeg made nothing, or began later.
   * Some AV1 files index frames as keyframes that a decoder cannot start
   * from, and ffmpeg then reads on for minutes looking for one it can.
   */
  unusable: boolean;
  dir: string;
}

interface Session {
  id: string;
  url: string;
  source: ProxySource;
  dir: string;
  bounds: number[];
  slices: SlicePlan;
  keyframes: number[];
  durationS: number;
  audioIndex: number | null;
  subtitles: Array<{ track: MkvSubtitleTrack; cues: Map<string, VttCue> }>;
  hevc: boolean;
  /** Delivered as Dolby Vision (its configuration box written, sample entry dvh1). */
  dolbyVision: boolean;
  init: Uint8Array | null;
  video: VideoTrackInfo | null;
  runs: Run[];
  nextRunId: number;
  lastRequestAt: number;
  wantedTime: number;
  /** A player has asked for it (false while it is only prewarmed). */
  demanded: boolean;
  /** The file gives up no picture, wherever it is started: no run of it is worth starting or waiting on. */
  pictureless: boolean;
  info: VodSessionInfo;
}

export interface VodSessionInfo {
  id: string;
  durationS: number;
  segments: number;
  /** Where each segment starts: the times playback can begin from. */
  seekPoints: number[];
  videoCodecId: string | null;
  /** What the viewer receives: SDR, PQ (HDR10), HLG or DV (Dolby Vision). */
  dynamicRange: DeliveredRange;
  audio: { language: string | null; name: string | null; channels: number | null; codecId: string } | null;
  /** Position of `audio` in `audioTracks`. */
  audioIndex: number | null;
  audioTracks: Array<{ index: number; language: string | null; name: string | null; channels: number | null; codecId: string }>;
  subtitles: Array<{ index: number; language: string | null; name: string | null; isDefault: boolean; isForced: boolean }>;
}

/** What the viewer's browser and screen can do beyond the common baseline. */
export interface VodViewer {
  decodesDolbyVision: boolean;
}

const BASELINE_VIEWER: VodViewer = { decodesDolbyVision: false };

/** Automatic audio choice, or an explicit track the viewer picked. */
export interface VodAudioRequest extends AudioTrackSelection {
  audioIndex?: number;
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

function sessionId(url: string, audio: VodAudioRequest, viewer: VodViewer): string {
  return createHash("sha256")
    .update(
      [
        VOD_VERSION,
        url,
        audio.preference,
        audio.originalLanguage ?? "",
        audio.preferredLanguage ?? "",
        audio.audioIndex ?? "",
        viewer.decodesDolbyVision ? "dv" : "",
      ].join("|")
    )
    .digest("hex")
    .slice(0, 24);
}

function chooseAudio(tracks: MkvAudioTrack[], selection: VodAudioRequest): MkvAudioTrack | null {
  if (!tracks.length) return null;
  const explicit = tracks.find((t) => t.audioIndex === selection.audioIndex);
  if (explicit) return explicit;
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

/**
 * Opens (or reuses) a session for a remote MKV. Throws VodError(415) when it
 * cannot be indexed. With `prewarm`, nobody is watching yet: the session is
 * made ready and never takes a run from someone who is.
 */
export async function openVodSession(
  cacheRoot: string,
  url: string,
  audio: VodAudioRequest,
  startAtS = 0,
  viewer: VodViewer = BASELINE_VIEWER,
  prewarm = false
): Promise<VodSessionInfo> {
  const id = sessionId(url, audio, viewer);
  let session = sessions.get(id);
  if (!session) {
    let pending = opening.get(id);
    if (!pending) {
      pending = createSession(cacheRoot, id, url, audio, viewer).finally(() => opening.delete(id));
      opening.set(id, pending);
    }
    session = await pending;
  }
  session.lastRequestAt = Date.now();
  if (!prewarm) demand(session);
  // Start where the viewer will, so the init and first segment are already
  // being produced when the player asks.
  const startSegment = segmentForTime(session.bounds, startAtS);
  // A session someone is watching keeps its own position.
  if (prewarm && session.demanded) return session.info;
  session.wantedTime = session.bounds[startSegment]!;
  if (!runReaching(session, segmentWindow(session.bounds, startSegment))) {
    try {
      startRun(session, startSegment);
    } catch (err) {
      // No room or no disk: the session is indexed, which is most of the wait.
      if (!prewarm) throw err;
    }
  }
  return session.info;
}

async function createSession(cacheRoot: string, id: string, url: string, audio: VodAudioRequest, viewer: VodViewer): Promise<Session> {
  const fetcher = httpRangeFetcher(url, RANGE_TIMEOUT_MS);
  const index = await readMkvKeyframes(fetcher).catch((err: unknown) => {
    throw new VodError(`index read failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  });
  if (!index) throw new VodError("source has no keyframe index", 415);
  if (index.videoUndecodable) throw new VodError("10-bit H.264 video cannot play in browsers", 415);
  const delivery = dolbyVisionDelivery(index.dolbyVision, viewer.decodesDolbyVision);
  if (delivery === "unplayable") throw new VodError("Dolby Vision without an HDR10 layer needs a Dolby Vision screen", 415);
  const asDolbyVision = delivery === "dolby-vision";
  const totalSize = fetcher.size();
  if (!totalSize) throw new VodError("source size unknown", 502);
  const audioTrack = chooseAudio(index.audioTracks, audio);
  const textSubtitles = index.subtitleTracks.filter((t) => t.text).slice(0, MAX_SUBTITLE_TRACKS);
  const bounds = computeSegmentBounds(index.keyframes, index.durationS);
  const dir = join(cacheRoot, `vod-${id}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const session: Session = {
    id,
    url,
    source: { url, totalSize, cached: index.fetched, windowBytes: PREWARM_WINDOW_BYTES },
    dir,
    bounds,
    slices: computeSlicePlan(bounds),
    keyframes: index.keyframes,
    durationS: index.durationS,
    audioIndex: audioTrack?.audioIndex ?? null,
    subtitles: textSubtitles.map((track) => ({ track, cues: new Map<string, VttCue>() })),
    hevc: /HEVC/i.test(index.videoCodecId ?? ""),
    dolbyVision: asDolbyVision,
    init: null,
    video: null,
    runs: [],
    nextRunId: 0,
    lastRequestAt: Date.now(),
    wantedTime: 0,
    demanded: false,
    pictureless: false,
    info: {
      id,
      durationS: index.durationS,
      segments: bounds.length - 1,
      seekPoints: bounds.slice(0, -1).map((t) => Number(t.toFixed(SEEK_POINT_DECIMALS))),
      videoCodecId: index.videoCodecId,
      dynamicRange: deliveredRange(index.dynamicRange, index.dolbyVision, asDolbyVision),
      audio: audioTrack
        ? { language: audioTrack.language, name: audioTrack.name, channels: audioTrack.channels, codecId: audioTrack.codecId }
        : null,
      audioIndex: audioTrack?.audioIndex ?? null,
      audioTracks: index.audioTracks.map((t) => ({
        index: t.audioIndex,
        language: t.language,
        name: t.name,
        channels: t.channels,
        codecId: t.codecId,
      })),
      subtitles: textSubtitles.map((t, index) => ({
        index,
        language: t.language,
        name: t.name,
        isDefault: t.isDefault,
        isForced: t.isForced,
      })),
    },
  };
  sessions.set(id, session);
  const range = index.dolbyVision ? `Dolby Vision profile ${index.dolbyVision.profile} as ${session.info.dynamicRange}` : session.info.dynamicRange;
  log(`open ${id}: ${index.durationS.toFixed(0)}s, ${bounds.length - 1} segments, ${index.keyframes.length} keyframes, audio #${session.audioIndex}, ${range}`);
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
    "-probesize", String(FFMPEG_PROBE_BYTES),
  ];
  // ffmpeg backs off slightly before the target and lands on the previous
  // keyframe; a small margin makes it land on the segment's own keyframe.
  if (startTime > 0) args.push("-ss", (startTime + 0.3).toFixed(3));
  args.push("-i", proxyBase ? `${proxyBase}/src/${session.id}` : session.url, "-map", "0:v:0");
  if (session.audioIndex !== null) {
    args.push("-map", `0:a:${session.audioIndex}`, "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "2");
  }
  args.push("-c:v", "copy");
  // Dolby Vision is only recognised with its configuration box, which ffmpeg
  // writes under -strict unofficial, and a dvh1 sample entry. Without them
  // the stream is treated as plain HEVC, right for a file with an HDR10
  // layer and badly wrong (green and purple) for one without.
  if (session.dolbyVision) args.push("-strict", "unofficial", "-tag:v", "dvh1");
  // Apple players and Safari MSE only accept HEVC tagged hvc1.
  else if (session.hevc) args.push("-tag:v", "hvc1");
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
  // Text subtitles ride along as WebVTT on extra pipes: the run already reads
  // the whole file sequentially, so they cost nothing extra to download.
  session.subtitles.forEach(({ track }, i) => {
    args.push("-map", `0:s:${track.subtitleIndex}`, "-c:s", "webvtt", "-f", "webvtt", `pipe:${SUBTITLE_FD_BASE + i}`);
  });
  return args;
}

function aliveRuns(session: Session): Run[] {
  return session.runs.filter((r) => !r.finished && !r.failed);
}

function lastTime(run: Run): number {
  return run.fragments.length ? run.fragments[run.fragments.length - 1]!.time : run.startTime;
}

/** An alive run that already covers, or will soon reach, the window. */
function runReaching(session: Session, window: PlanWindow): Run | null {
  const candidates = aliveRuns(session).filter(
    (run) => run.startTime <= window.anchor + KEYFRAME_MATCH_TOLERANCE_S && lastTime(run) >= window.start - REACH_S
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

/** A session that asked for a segment this recently is someone watching right now. */
const ACTIVE_VIEWER_MS = 20_000;

function makeRoom(session: Session): void {
  const own = aliveRuns(session).sort((a, b) => lastTime(a) - lastTime(b));
  while (own.length >= MAX_RUNS_PER_SESSION) stopRun(own.shift()!, "session run limit");
  if (totalAliveRuns() < MAX_RUNS_TOTAL) return;
  // Only other viewers who have gone quiet give up their runs. Taking runs
  // from someone mid-film just moved the stall to them, and with a few
  // viewers at once they took turns stalling each other.
  // A prewarm takes nothing from anyone: it only uses a free run.
  if (!session.demanded) throw new VodError("remux capacity reached", 503);
  const now = Date.now();
  const idleOthers = [...sessions.values()]
    .filter((s) => s !== session && (!s.demanded || now - s.lastRequestAt > ACTIVE_VIEWER_MS))
    .sort((a, b) => Number(a.demanded) - Number(b.demanded) || a.lastRequestAt - b.lastRequestAt);
  for (const other of idleOthers) {
    for (const run of aliveRuns(other)) stopRun(run, "global run limit");
    if (totalAliveRuns() < MAX_RUNS_TOTAL) return;
  }
  throw new VodError("remux capacity reached", 503);
}

/** A player wants this session: it reads the source at full size from here on. */
function demand(session: Session): void {
  session.demanded = true;
  delete session.source.windowBytes;
}

function startRun(session: Session, segment: number): Run {
  if (session.pictureless) throw new VodError(UNUSABLE_ENTRY, 502);
  if (freeBytes(session.dir) < MIN_FREE_BYTES) {
    // A prewarm does not clear anyone's cache to make its own.
    if (!session.demanded) throw new VodError("not enough free disk space to remux", 507);
    reclaimDisk(session);
    if (freeBytes(session.dir) < MIN_FREE_BYTES) throw new VodError("not enough free disk space to remux", 507);
  }
  makeRoom(session);
  const startTime = session.bounds[segment]!;
  const id = session.nextRunId++;
  const dir = join(session.dir, `run-${id}`);
  mkdirSync(dir, { recursive: true });
  const proc = spawn("ffmpeg", ffmpegArgs(session, startTime), {
    stdio: ["ignore", "pipe", "pipe", ...session.subtitles.map(() => "pipe" as const)],
  });
  const run: Run = { id, startSegment: segment, proc, startTime, fragments: [], finished: false, failed: false, paused: false, unusable: false, dir };
  session.runs.push(run);
  const giveUp = (reason: string) => {
    run.unusable = true;
    stopRun(run, reason);
    run.failed = true;
  };
  const firstFragment = setTimeout(() => {
    if (!run.fragments.length && !run.finished && !run.failed) giveUp("made nothing");
  }, FIRST_FRAGMENT_TIMEOUT_MS);
  const splitter = new Fmp4StreamSplitter();
  let stderr = "";
  let seq = 0;
  let pictureless = 0;
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
      const raw = session.video ? firstVideoDecodeTime(part.bytes, session.video) : null;
      if (raw === null) {
        if (run.fragments.length || ++pictureless < PICTURELESS_FRAGMENTS_MAX) continue;
        clearTimeout(firstFragment);
        // True of the file, not of where it was started: the runs beside this one end the same way.
        session.pictureless = true;
        for (const other of aliveRuns(session)) if (other !== run) stopRun(other, "sound and no picture");
        giveUp("sound and no picture");
        return;
      }
      const time = snapToKeyframe(session.keyframes, raw);
      if (!run.fragments.length) {
        clearTimeout(firstFragment);
        if (time > startTime + ENTRY_TOLERANCE_S) {
          giveUp(`began at ${time.toFixed(1)}s, not ${startTime.toFixed(1)}s`);
          return;
        }
      }
      const path = join(dir, `${seq++}.m4s`);
      writeFileSync(path, part.bytes);
      run.fragments.push({ time, path, bytes: part.bytes.length });
      throttle(session, run);
    }
  });
  proc.stderr!.on("data", (chunk: Buffer) => {
    if (stderr.length < 2000) stderr += chunk.toString();
  });
  session.subtitles.forEach(({ cues }, i) => {
    const stream = proc.stdio[SUBTITLE_FD_BASE + i] as NodeJS.ReadableStream | null;
    if (!stream) return;
    const parser = new VttStreamParser();
    const keep = (found: VttCue[]) => {
      for (const cue of found) cues.set(`${cue.start.toFixed(3)}|${cue.text}`, cue);
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => keep(parser.push(chunk)));
    stream.on("end", () => keep(parser.flush()));
    stream.on("error", () => undefined);
  });
  proc.on("close", (code, signal) => {
    clearTimeout(firstFragment);
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
  const pauseAt = session.demanded ? AHEAD_PAUSE_S : PREWARM_AHEAD_S;
  if (!run.paused && lead > pauseAt) {
    run.paused = true;
    run.proc.kill("SIGSTOP");
  } else if (run.paused && session.demanded && lead < AHEAD_RESUME_S) {
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

/** Subtitle cues of text track `index` produced so far, in time order. */
export function vodSubtitleCues(id: string, index: number): VttCue[] {
  const track = sessionOrThrow(id).subtitles[index];
  if (!track) throw new VodError("unknown subtitle track", 404);
  return [...track.cues.values()].sort((a, b) => a.start - b.start);
}

/** The playlist of whole segments, or of slices for players that can start between keyframes. */
export function vodPlaylist(id: string, sliced = false): string {
  const session = sessionOrThrow(id);
  return sliced ? buildVodPlaylist(session.slices.bounds, SLICE_PREFIX, false) : buildVodPlaylist(session.bounds);
}

export async function vodInit(id: string): Promise<Uint8Array> {
  const session = sessionOrThrow(id);
  const deadline = Date.now() + INIT_WAIT_MS;
  while (!session.init) {
    if (session.runs.some((run) => run.unusable)) throw new VodError(UNUSABLE_ENTRY, 502);
    if (!aliveRuns(session).length) startRun(session, segmentForTime(session.bounds, session.wantedTime));
    if (Date.now() > deadline) throw new VodError("init not ready", 504);
    await sleep(POLL_MS);
  }
  return session.init;
}

/**
 * Yields the fragment files of one segment as they appear. `gone` reports that
 * the player hung up: the wait then ends instead of polling (and starting new
 * ffmpeg runs) for a segment nobody will receive.
 */
export function vodSegment(id: string, segment: number, gone: () => boolean = () => false): AsyncGenerator<string> {
  const session = sessionOrThrow(id);
  if (!Number.isInteger(segment) || segment < 0 || segment >= session.bounds.length - 1) {
    throw new VodError("segment out of range", 404);
  }
  return windowFragments(session, segmentWindow(session.bounds, segment), segment, gone);
}

/** The same for one slice of a segment (see `computeSlicePlan`). */
export function vodSlice(id: string, slice: number, gone: () => boolean = () => false): AsyncGenerator<string> {
  const session = sessionOrThrow(id);
  if (!Number.isInteger(slice) || slice < 0 || slice >= session.slices.segmentOf.length) {
    throw new VodError("slice out of range", 404);
  }
  return windowFragments(session, sliceWindow(session.bounds, session.slices, slice), session.slices.segmentOf[slice]!, gone);
}

/**
 * The fragments of a window, in order, as they become available. A window
 * already complete in any run is yielded at once; otherwise the run that will
 * produce it is followed (started at `segment`, the keyframe it depends on,
 * when none will reach it) and each fragment is yielded the moment it is
 * written, so playback can begin before the window ends.
 */
async function* windowFragments(session: Session, window: PlanWindow, segment: number, gone: () => boolean): AsyncGenerator<string> {
  demand(session);
  session.wantedTime = window.start;
  for (const run of aliveRuns(session)) throttle(session, run);

  for (const run of [...session.runs].reverse()) {
    const complete = fragmentsInWindow(window, run.fragments, run.finished);
    if (complete) {
      for (const fragment of complete) yield fragment.path;
      return;
    }
  }

  const deadline = Date.now() + SEGMENT_WAIT_MS;
  let run: Run | null = null;
  let cursor = -1;
  while (!run) {
    for (const candidate of [...session.runs].reverse()) {
      if (!runCovers(candidate.fragments, window.anchor)) continue;
      const first = candidate.fragments.findIndex((f) => f.time >= window.start - KEYFRAME_MATCH_TOLERANCE_S);
      if (first < 0) continue;
      run = candidate;
      cursor = first;
      break;
    }
    if (run) break;
    if (gone()) return;
    // Waiting longer, or starting again, would end the same way.
    if (session.pictureless || session.runs.some((r) => r.unusable && r.startSegment === segment)) throw new VodError(UNUSABLE_ENTRY, 502);
    if (Date.now() > deadline) throw new VodError("segment not ready", 504);
    if (!runReaching(session, window)) {
      const failed = session.runs.filter((r) => r.failed && r.startSegment === segment).length;
      if (failed >= MAX_FAILED_RUNS_PER_SEGMENT) throw new VodError("source failed to remux", 502);
      startRun(session, segment);
    }
    await sleep(POLL_MS);
  }

  for (;;) {
    while (cursor < run.fragments.length) {
      const fragment = run.fragments[cursor]!;
      if (!window.last && fragment.time >= window.end - KEYFRAME_MATCH_TOLERANCE_S) return;
      yield fragment.path;
      cursor++;
    }
    if (run.finished || gone()) return;
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
    if (idle > (session.demanded ? RUN_IDLE_MS : PREWARM_IDLE_MS)) for (const run of aliveRuns(session)) stopRun(run, "idle");
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

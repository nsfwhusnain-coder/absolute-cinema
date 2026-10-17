/**
 * The capacity governor (docs/CAPACITY.md): who may start a stream, the line
 * of those waiting for one, and which streams stop when the machine is in
 * danger.
 *
 * Every stream holds a seat, and a seat costs what its stream is expected to
 * take of the machine: CPU, memory and the internet link, from its delivery
 * and bitrate, so a 4K remux costs several 1080p ones. A viewer is let in when
 * their stream fits beside the others within the budgets and the machine's own
 * readings agree it is coping. Otherwise they wait in line, first come first
 * served (the owner's profiles ahead of the rest), and are let in as seats free.
 *
 * The machine's state is a level, judged every second from its readings, with
 * a margin to leave it by and a time to hold it, so it does not flicker:
 *   ok        streams are let in while they fit;
 *   busy      nobody new is let in: the CPU, memory, temperature or the
 *             viewers' own playback say the machine is at its limit, whatever
 *             the estimates said;
 *   critical  streams stop, one at a time, the newest and heaviest first and
 *             the owner's last, until the machine is out of danger. A stopped
 *             stream is a viewer told why, not a machine that overheats, runs
 *             out of memory or reboots under everyone.
 *
 * Pure: readings, requests and the clock come in from outside, so every rule
 * is tested with made-up readings at made-up times (governor.test.ts).
 */

import { randomBytes } from "node:crypto";
import type { LagReading, MachineReading } from "./capacity-signals";

export type Level = "ok" | "busy" | "critical";

/** How a stream reaches the viewer: remuxed here, relayed through the web app, or straight from its CDN. */
export type Delivery = "remux" | "web" | "direct";

export type StreamClass = "4k" | "1080p" | "720p" | "sd";

export interface StreamDescription {
  delivery: Delivery;
  /** Nominal picture height (2160 for 4K); 0 when unknown. */
  height: number;
  /** Average bitrate in bits per second; 0 when unknown. */
  bitrateBps: number;
  /** The viewer is outside the home network, so the stream crosses the upload link. */
  remote: boolean;
  /** Its sound is re-encoded for the viewer (a TrueHD or DTS track for a browser that cannot play it), once known. */
  audioTranscode?: boolean;
}

export interface Cost {
  cpuCores: number;
  /** Of the remuxer's own thread, which every remuxed byte passes through, in and out. */
  remuxerCores: number;
  memoryBytes: number;
  /** Of the internet link: the download side (from the CDN) and the upload side (to a viewer outside). */
  downBps: number;
  upBps: number;
}

const MB = 1024 * 1024;
const MBPS = 1_000_000;

export function streamClass(height: number): StreamClass {
  if (height >= 1500) return "4k";
  if (height >= 780) return "1080p";
  if (height >= 520) return "720p";
  return "sd";
}

/** A bitrate to assume when the source did not say: a remux of each class is a disc's worth, a web stream far less. */
const TYPICAL_MBPS: Record<Delivery, Record<StreamClass, number>> = {
  remux: { "4k": 50, "1080p": 20, "720p": 8, sd: 4 },
  direct: { "4k": 50, "1080p": 20, "720p": 8, sd: 4 },
  web: { "4k": 16, "1080p": 6, "720p": 3, sd: 1.5 },
};

/** What a stream costs, by delivery: measured on this machine (docs/CAPACITY.md, "Calibration"). */
export interface CostModel {
  /** Cores a remux takes whatever its bitrate: its ffmpeg, its audio, its bookkeeping. */
  remuxCpuBase: number;
  /** Cores per Mbit/s that pass through the remuxer and the web app on their way to the viewer. */
  remuxCpuPerMbps: number;
  /** Of that, what falls on the remuxer's one thread, per Mbit/s. */
  remuxThreadPerMbps: number;
  /** Re-encoding its sound (decoding TrueHD or DTS above all) adds this much. */
  audioTranscodeCores: number;
  remuxMemoryBytes: number;
  webCpuBase: number;
  webCpuPerMbps: number;
  webMemoryBytes: number;
  /** A stream takes this much more of a link than its average bitrate: it reads ahead in bursts. */
  linkHeadroom: number;
}

export const DEFAULT_COST_MODEL: CostModel = {
  remuxCpuBase: 0.1,
  remuxCpuPerMbps: 0.006,
  // Nine real viewers with about 270 Mbit/s of streams between them kept the main thread at about 0.9 core,
  // read-ahead included, and played without a stall (reference server, 2026-10-17): 0.003 core per Mbit/s.
  remuxThreadPerMbps: 0.003,
  // 16 1080p streams of 6.4 Mbit/s with their TrueHD re-encoded took 3.6 cores: 0.22 each, 0.08 above the
  // bitrate's share (reference server, 2026-10-17).
  audioTranscodeCores: 0.1,
  // 7.5 GB held at 16 heavy streams, 5.2 at 12: about 450 MB each while they race ahead.
  remuxMemoryBytes: 450 * MB,
  webCpuBase: 0.03,
  webCpuPerMbps: 0.004,
  webMemoryBytes: 60 * MB,
  linkHeadroom: 1.2,
};

/**
 * A page's word on its stream's bitrate, kept from being far below what its
 * picture plausibly needs: a 4K remux is never planned below 20 Mbit/s on the
 * page's say-so. The file's own bitrate, once the remuxer has read it, is
 * taken as it is (see Governor.attach).
 */
export function declaredStream(stream: StreamDescription): StreamDescription {
  if (!(stream.bitrateBps > 0)) return stream;
  const floor = 0.4 * TYPICAL_MBPS[stream.delivery][streamClass(stream.height)] * MBPS;
  return stream.bitrateBps >= floor ? stream : { ...stream, bitrateBps: floor };
}

export function streamCost(stream: StreamDescription, model: CostModel = DEFAULT_COST_MODEL): Cost {
  const mbps = stream.bitrateBps > 0 ? stream.bitrateBps / MBPS : TYPICAL_MBPS[stream.delivery][streamClass(stream.height)];
  const linkBps = mbps * MBPS * model.linkHeadroom;
  if (stream.delivery === "direct") {
    // The viewer's player reads the CDN itself: nothing of this machine, but a viewer at home shares its link.
    return { cpuCores: 0, remuxerCores: 0, memoryBytes: 0, downBps: stream.remote ? 0 : linkBps, upBps: 0 };
  }
  const remux = stream.delivery === "remux";
  return {
    cpuCores: remux
      ? model.remuxCpuBase + model.remuxCpuPerMbps * mbps + (stream.audioTranscode ? model.audioTranscodeCores : 0)
      : model.webCpuBase + model.webCpuPerMbps * mbps,
    remuxerCores: remux ? model.remuxThreadPerMbps * mbps : 0,
    memoryBytes: remux ? model.remuxMemoryBytes : model.webMemoryBytes,
    downBps: linkBps,
    upBps: stream.remote ? linkBps : 0,
  };
}

/** Each reading has a level to enter at and a lower one to leave by. */
interface Band {
  enter: number;
  leave: number;
}

export interface Thresholds {
  busyTempC: Band;
  criticalTempC: Band;
  /** Share of the container's CPU periods its quota ran out in, over the last ten seconds. */
  busyThrottled: Band;
  /** Share of the memory ceiling held and not droppable (see committedMemoryBytes). */
  busyMemory: Band;
  criticalMemory: Band;
  /** The remuxer's event loop: 95th percentile of the last ten seconds, in ms (busy), and its second longest stall (critical). */
  busyLagMs: Band;
  criticalLagMs: Band;
  /** One stall this long in the last ten seconds is enough: busy, critical. */
  busyFreezeMs: Band;
  criticalFreezeMs: Band;
  /** Share of the viewers playing who stalled in the last minute (with at least `stallQuorum` playing). */
  busyStalls: Band;
  /** Share of the download budget in use. */
  busyDownlink: Band;
  /** The remuxer's own thread, in cores (smoothed): past this, every viewer's next slice waits on it. */
  busyRemuxerCores: Band;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  busyTempC: { enter: 85, leave: 80 },
  criticalTempC: { enter: 92, leave: 88 },
  busyThrottled: { enter: 0.25, leave: 0.1 },
  busyMemory: { enter: 0.88, leave: 0.82 },
  criticalMemory: { enter: 0.95, leave: 0.9 },
  // A player holds 30 s: the loop pausing up to 0.8 s at nine viewers cost none of them a stall, so these lines
  // are where slices start to arrive late, not where the loop is merely busy (2026-10-17).
  busyLagMs: { enter: 1000, leave: 500 },
  criticalLagMs: { enter: 3000, leave: 1500 },
  busyFreezeMs: { enter: 3000, leave: 1500 },
  criticalFreezeMs: { enter: 8000, leave: 3000 },
  busyStalls: { enter: 0.5, leave: 0.25 },
  busyDownlink: { enter: 0.95, leave: 0.8 },
  // Only a thread that is pegged: much of its work is read-ahead, which slows down unnoticed.
  busyRemuxerCores: { enter: 0.97, leave: 0.9 },
};

export interface GovernorConfig {
  /** Off: everyone is let in and nothing is stopped (the readings are still taken, for the metrics). */
  enabled: boolean;
  /** Shares of the container's CPU and memory that streams may be planned into. */
  cpuShare: number;
  memoryShare: number;
  /** Cores of the remuxer's one thread that streams may be planned into. */
  remuxerCores: number;
  /** The internet link's budget for streams, each way; 0 for no limit. */
  downlinkBps: number;
  uplinkBps: number;
  /** What the site takes with nobody watching: the web app, the scraper and its browser. */
  idleCpuCores: number;
  idleMemoryBytes: number;
  thresholds: Thresholds;
  /** Viewers playing before their stalls count as a reading. */
  stallQuorum: number;
  /** How long a level is held after its readings clear. */
  busyHoldMs: number;
  criticalHoldMs: number;
  /** People who may wait in line; past that they are asked to come back later. */
  queueMax: number;
  /** Streams started at most per window, so a line let in at once does not start them all in the same second. */
  startsPerWindow: number;
  startWindowMs: number;
  /**
   * Streams that may be building their first minute at full speed at once (the remuxer reads a new stream as
   * fast as its CDN goes until it is a minute ahead of its viewer, then at a pace). A queue let in faster than
   * this raced them all at once and filled the internet link.
   */
  maxWarming: number;
  /** A seat nobody renews or streams from for this long is given up (the viewer closed the page). */
  seatTtlMs: number;
  /** A place in line nobody asks about for this long is given up. */
  ticketTtlMs: number;
  /** Time between two stops while critical; longer when it is the heat, which falls slowly. */
  evictEveryMs: number;
  evictEveryHotMs: number;
  costModel: CostModel;
  /** Remux streams at most (the remuxer's run limit, VOD_MAX_RUNS): each needs a run of its own. */
  maxRemuxSeats: number;
  /** A seat paused this long counts for `pausedShare` of its cost: its stream rests (the remuxer stops its runs after 3 minutes). */
  pausedAfterMs: number;
  pausedShare: number;
}

export const DEFAULT_CONFIG: GovernorConfig = {
  enabled: true,
  // 16 1080p streams with their TrueHD re-encoded ran smooth at 3.6 of 8 cores, 24 broke at 5.7 with every start
  // racing ahead at once (reference server, 2026-10-17): planning into 70% leaves the starts their room.
  cpuShare: 0.7,
  memoryShare: 0.85,
  remuxerCores: 0.9,
  downlinkBps: 450 * MBPS,
  uplinkBps: 0,
  idleCpuCores: 0.3,
  idleMemoryBytes: 1200 * MB,
  thresholds: DEFAULT_THRESHOLDS,
  stallQuorum: 4,
  busyHoldMs: 20_000,
  criticalHoldMs: 15_000,
  queueMax: 25,
  startsPerWindow: 4,
  startWindowMs: 10_000,
  maxWarming: 2,
  seatTtlMs: 75_000,
  ticketTtlMs: 20_000,
  evictEveryMs: 8_000,
  evictEveryHotMs: 20_000,
  costModel: DEFAULT_COST_MODEL,
  maxRemuxSeats: Number.POSITIVE_INFINITY,
  pausedAfterMs: 120_000,
  pausedShare: 0.3,
};

/**
 * The governor's settings from the environment (docs/CAPACITY.md lists them).
 * Anything unset or unreadable keeps its default.
 */
export function governorConfigFromEnv(env: Record<string, string | undefined> = process.env): Partial<GovernorConfig> {
  const number = (name: string, min: number, max: number): number | undefined => {
    const raw = env[name];
    const value = Number(raw);
    return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
  };
  const config: Partial<GovernorConfig> = { enabled: env.CAPACITY_GATE !== "0" };
  // A remux stream takes a run, and a second one for a moment when its viewer seeks: a quarter of the runs is
  // kept free for that, or a seek on a full server would be refused.
  const runs = Math.floor(number("VOD_MAX_RUNS", 1, 10_000) ?? 4);
  config.maxRemuxSeats = Math.max(1, runs - Math.max(1, Math.round(runs / 4)));
  const cpuShare = number("CAPACITY_CPU_SHARE", 0.1, 1);
  if (cpuShare !== undefined) config.cpuShare = cpuShare;
  const memoryShare = number("CAPACITY_MEMORY_SHARE", 0.1, 1);
  if (memoryShare !== undefined) config.memoryShare = memoryShare;
  const remuxer = number("CAPACITY_REMUXER_CORES", 0.1, 1);
  if (remuxer !== undefined) config.remuxerCores = remuxer;
  const down = number("CAPACITY_DOWNLINK_MBPS", 0, 100_000);
  if (down !== undefined) config.downlinkBps = down * MBPS;
  const up = number("CAPACITY_UPLINK_MBPS", 0, 100_000);
  if (up !== undefined) config.uplinkBps = up * MBPS;
  const queueMax = number("CAPACITY_QUEUE_MAX", 0, 1000);
  if (queueMax !== undefined) config.queueMax = Math.round(queueMax);
  const starts = number("CAPACITY_STARTS_PER_10S", 1, 1000);
  if (starts !== undefined) config.startsPerWindow = Math.round(starts);
  const busyTemp = number("CAPACITY_BUSY_TEMP_C", 40, 110);
  const criticalTemp = number("CAPACITY_CRITICAL_TEMP_C", 40, 110);
  if (busyTemp !== undefined || criticalTemp !== undefined) {
    config.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...(busyTemp !== undefined ? { busyTempC: { enter: busyTemp, leave: busyTemp - 5 } } : {}),
      ...(criticalTemp !== undefined ? { criticalTempC: { enter: criticalTemp, leave: criticalTemp - 4 } } : {}),
    };
  }
  return config;
}

/** Why someone is waiting, or was stopped: what the page tells them. */
export type CapacityReason = "seats" | "starts" | "temperature" | "cpu" | "memory" | "network" | "playback";

interface Seat {
  id: string;
  watcher: string;
  priority: number;
  stream: StreamDescription;
  cost: Cost;
  admittedAt: number;
  renewedAt: number;
  sessionId: string | null;
  evicted: CapacityReason | null;
  playing: boolean;
  /** Since when its viewer has said they are not playing (null while playing, or before they said anything). */
  pausedSince: number | null;
  /** When its stream last asked for a slice. */
  activeAt: number;
  lastStallAt: number;
}

interface Ticket {
  id: string;
  watcher: string;
  priority: number;
  stream: StreamDescription;
  cost: Cost;
  queuedAt: number;
  polledAt: number;
}

export type SeatAnswer =
  | { status: "admitted"; seat: string; level: Level; /** How long they waited in line, 0 when they did not. */ waitedMs: number }
  | {
      status: "queued";
      ticket: string;
      /** This request put them in line (the ones after only ask about their place). */
      joined: boolean;
      /** 1 is next. */
      position: number;
      waiting: number;
      reason: CapacityReason;
      level: Level;
      /** A 4K stream that does not fit while a 1080p one would: the page may offer that instead. */
      lighterFits: boolean;
    }
  | { status: "full"; retryAfterS: number; reason: CapacityReason; level: Level };

export type RenewAnswer = { status: "active"; level: Level } | { status: "evicted"; reason: CapacityReason } | { status: "unknown" };

export interface Eviction {
  seat: string;
  watcher: string;
  sessionId: string | null;
  reason: CapacityReason;
  stream: StreamDescription;
  heldMs: number;
}

export interface CapacitySnapshot {
  enabled: boolean;
  level: Level;
  reasons: CapacityReason[];
  seats: number;
  seatsByClass: Record<StreamClass, number>;
  queue: number;
  /** Planned use of each budget, 0-1 (what is held, or what is measured when that is more). */
  use: { cpu: number; remuxer: number; memory: number; downlink: number; uplink: number };
  measured: {
    cpuCores: number;
    cpuLimitCores: number;
    /** The remuxer's own thread, smoothed. */
    remuxerCores: number;
    throttledShare: number;
    memoryBytes: number;
    memoryLimitBytes: number;
    temperatureC: number | null;
    loopLagMs: number;
    /** The event loop's longest pause in the last 10 s. */
    loopFreezeMs: number;
    downBps: number;
    stallShare: number | null;
  };
}

export interface SeatDetail {
  watcher: string;
  priority: number;
  sessionId: string | null;
  delivery: Delivery;
  class: StreamClass;
  bitrateBps: number;
  remote: boolean;
  /** Cores it is planned to take now (less while paused a while). */
  cpuCores: number;
  /** Its share of the fullest budget, 0-1. */
  share: number;
  playing: boolean;
  paused: boolean;
  admittedAgoMs: number;
  activeAgoMs: number;
  evicted: CapacityReason | null;
}

export interface QueueDetail {
  position: number;
  watcher: string;
  priority: number;
  delivery: Delivery;
  class: StreamClass;
  waitedMs: number;
}

/** Recent temperature readings averaged for a level: one hot second is not a hot CPU. */
const TEMPERATURE_SAMPLES = 5;
/** The CPU rate is smoothed over about this long: a stream's start races ahead for a few seconds, then rests. */
const CPU_SMOOTHING_MS = 20_000;
/** And the download rate over this long. */
const DOWNLINK_SMOOTHING_MS = 10_000;
/** Throttling is judged over this long. */
const THROTTLE_WINDOW_MS = 10_000;
/** A stall this recent counts against the level. */
const STALL_WINDOW_MS = 60_000;
/** A viewer counts as playing while they have renewed this recently. */
const PLAYING_WINDOW_MS = 30_000;
/** An evicted seat is remembered this long, so its viewer's next renewal hears why rather than "unknown". */
const EVICTED_MEMORY_MS = 3 * 60_000;
/** Asked to come back after this long when the line is full. */
const FULL_RETRY_S = 60;
/**
 * A stream let in this recently counts as warming up even before the remuxer has seen it (its search and
 * open come first): without it, two admissions in the same second both found a free slot.
 */
const WARMING_GRACE_MS = 15_000;

const newId = (): string => randomBytes(12).toString("hex");

export class Governor {
  private readonly config: GovernorConfig;
  private readonly now: () => number;
  private level: Level = "ok";
  private reasons: CapacityReason[] = [];
  private busyClearSince: number | null = null;
  private criticalClearSince: number | null = null;
  private readonly seats = new Map<string, Seat>();
  private readonly tickets = new Map<string, Ticket>();
  private starts: number[] = [];
  /** Streams building their first minute right now, as the remuxer last counted them. */
  private warming = 0;
  private lastEvictionAt = Number.NEGATIVE_INFINITY;
  private previous: MachineReading | null = null;
  private readonly throttleHistory: Array<{ at: number; periods: number; throttled: number }> = [];
  private readonly temperatures: number[] = [];
  private cpuCores = 0;
  private remuxerCores = 0;
  private cpuLimitCores = 1;
  private throttledShare = 0;
  private memoryBytes = 0;
  private memoryLimitBytes = Number.POSITIVE_INFINITY;
  private temperatureC: number | null = null;
  private loopLagMs = 0;
  private loopFreezeMs = 0;
  private loopSecondFreezeMs = 0;
  private downBps = 0;

  constructor(config: Partial<GovernorConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULT_CONFIG, ...config, thresholds: { ...DEFAULT_THRESHOLDS, ...config.thresholds } };
    this.now = now;
  }

  get currentLevel(): Level {
    return this.level;
  }

  /**
   * A reading of the machine (about once a second): the CPU rate since the
   * last one, its throttling, memory, temperature, the event loop's lateness
   * and the download rate. Judges the level from them.
   */
  observe(reading: MachineReading, lag: LagReading | number, downBps: number | null): void {
    const prev = this.previous;
    this.previous = reading;
    this.cpuLimitCores = reading.cpuLimitCores;
    if (prev && reading.cpuSeconds !== null && prev.cpuSeconds !== null && reading.at > prev.at) {
      const rate = Math.max(0, (reading.cpuSeconds - prev.cpuSeconds) / ((reading.at - prev.at) / 1000));
      const weight = 1 - Math.exp(-(reading.at - prev.at) / CPU_SMOOTHING_MS);
      this.cpuCores += (rate - this.cpuCores) * weight;
    }
    if (prev && typeof reading.processCpuSeconds === "number" && typeof prev.processCpuSeconds === "number" && reading.at > prev.at) {
      const rate = Math.max(0, (reading.processCpuSeconds - prev.processCpuSeconds) / ((reading.at - prev.at) / 1000));
      const weight = 1 - Math.exp(-(reading.at - prev.at) / CPU_SMOOTHING_MS);
      this.remuxerCores += (rate - this.remuxerCores) * weight;
    }
    if (reading.periods !== null && reading.throttledPeriods !== null) {
      this.throttleHistory.push({ at: reading.at, periods: reading.periods, throttled: reading.throttledPeriods });
      while (this.throttleHistory.length > 2 && reading.at - this.throttleHistory[0]!.at > THROTTLE_WINDOW_MS) this.throttleHistory.shift();
      const first = this.throttleHistory[0]!;
      const periods = reading.periods - first.periods;
      this.throttledShare = periods > 0 ? Math.max(0, reading.throttledPeriods - first.throttled) / periods : 0;
    }
    if (reading.memoryCommittedBytes !== null) this.memoryBytes = reading.memoryCommittedBytes;
    this.memoryLimitBytes = reading.memoryLimitBytes;
    if (reading.temperatureC !== null) {
      this.temperatures.push(reading.temperatureC);
      if (this.temperatures.length > TEMPERATURE_SAMPLES) this.temperatures.shift();
      this.temperatureC = this.temperatures.reduce((a, b) => a + b, 0) / this.temperatures.length;
    }
    const loop = typeof lag === "number" ? { p95Ms: lag, maxMs: lag, secondMs: lag } : lag;
    this.loopLagMs = loop.p95Ms;
    this.loopFreezeMs = loop.maxMs;
    this.loopSecondFreezeMs = loop.secondMs;
    if (downBps !== null) {
      // Smoothed like the CPU: a stream starting reads in bursts, and a one-second rate called them a full link.
      const weight = prev && reading.at > prev.at ? 1 - Math.exp(-(reading.at - prev.at) / DOWNLINK_SMOOTHING_MS) : 1;
      this.downBps += (downBps - this.downBps) * weight;
    }
    this.judge(reading.at);
  }

  /** The share of viewers playing who stalled lately, or null when too few are playing to say. */
  private stallShare(now: number): number | null {
    let playing = 0;
    let stalled = 0;
    for (const seat of this.seats.values()) {
      if (seat.evicted || !seat.playing || now - seat.renewedAt > PLAYING_WINDOW_MS) continue;
      playing++;
      if (now - seat.lastStallAt <= STALL_WINDOW_MS) stalled++;
    }
    return playing >= this.config.stallQuorum ? stalled / playing : null;
  }

  private judge(now: number): void {
    const t = this.config.thresholds;
    const over = (value: number | null, band: Band, inside: boolean): boolean => value !== null && value >= (inside ? band.leave : band.enter);
    const critical = this.level === "critical";
    const busy = this.level !== "ok";
    const memoryShare = Number.isFinite(this.memoryLimitBytes) ? this.memoryBytes / this.memoryLimitBytes : 0;
    const downShare = this.config.downlinkBps > 0 ? this.downBps / this.config.downlinkBps : 0;

    const criticalReasons: CapacityReason[] = [];
    if (over(this.temperatureC, t.criticalTempC, critical)) criticalReasons.push("temperature");
    if (over(memoryShare, t.criticalMemory, critical)) criticalReasons.push("memory");
    if (over(this.loopSecondFreezeMs, t.criticalLagMs, critical) || over(this.loopFreezeMs, t.criticalFreezeMs, critical)) criticalReasons.push("cpu");

    const busyReasons: CapacityReason[] = [];
    if (over(this.temperatureC, t.busyTempC, busy)) busyReasons.push("temperature");
    if (
      over(this.throttledShare, t.busyThrottled, busy) ||
      over(this.loopLagMs, t.busyLagMs, busy) ||
      over(this.loopFreezeMs, t.busyFreezeMs, busy) ||
      over(this.remuxerCores, t.busyRemuxerCores, busy)
    )
      busyReasons.push("cpu");
    if (over(memoryShare, t.busyMemory, busy)) busyReasons.push("memory");
    if (over(downShare, t.busyDownlink, busy)) busyReasons.push("network");
    if (over(this.stallShare(now), t.busyStalls, busy)) busyReasons.push("playback");

    if (criticalReasons.length) {
      this.level = "critical";
      this.criticalClearSince = null;
      this.busyClearSince = null;
    } else if (this.level === "critical") {
      this.criticalClearSince ??= now;
      if (now - this.criticalClearSince >= this.config.criticalHoldMs) {
        this.level = "busy";
        this.criticalClearSince = null;
      }
    }
    if (this.level !== "critical") {
      if (busyReasons.length) {
        this.level = "busy";
        this.busyClearSince = null;
      } else if (this.level === "busy") {
        this.busyClearSince ??= now;
        if (now - this.busyClearSince >= this.config.busyHoldMs) {
          this.level = "ok";
          this.busyClearSince = null;
        }
      }
    }
    this.reasons = [...new Set([...criticalReasons, ...busyReasons])];
    // Held after its readings cleared: the reasons it was entered for still explain the wait.
    if (!this.reasons.length && this.level !== "ok") this.reasons = this.lastReasons;
    else this.lastReasons = this.reasons;
  }

  private lastReasons: CapacityReason[] = [];

  private budgets(): Cost {
    return {
      cpuCores: this.cpuLimitCores * this.config.cpuShare,
      remuxerCores: this.config.remuxerCores,
      memoryBytes: Number.isFinite(this.memoryLimitBytes) ? this.memoryLimitBytes * this.config.memoryShare : Number.POSITIVE_INFINITY,
      downBps: this.config.downlinkBps > 0 ? this.config.downlinkBps : Number.POSITIVE_INFINITY,
      upBps: this.config.uplinkBps > 0 ? this.config.uplinkBps : Number.POSITIVE_INFINITY,
    };
  }

  /** What the site takes with nobody watching, never more than a fair part of a small machine. */
  private idle(): { cpuCores: number; memoryBytes: number } {
    return {
      cpuCores: Math.min(this.config.idleCpuCores, 0.25 * this.cpuLimitCores),
      memoryBytes: Number.isFinite(this.memoryLimitBytes) ? Math.min(this.config.idleMemoryBytes, 0.35 * this.memoryLimitBytes) : this.config.idleMemoryBytes,
    };
  }

  /** The share of its cost a seat counts for now: less while its viewer has been paused a while. */
  private weight(seat: Seat, now: number): number {
    return seat.pausedSince !== null && now - seat.pausedSince >= this.config.pausedAfterMs ? this.config.pausedShare : 1;
  }

  /** What the seats held are expected to take, or what is measured, whichever is more: a start not yet felt still counts. */
  private planned(): Cost {
    const now = this.now();
    const idle = this.idle();
    const held: Cost = { cpuCores: idle.cpuCores, remuxerCores: 0, memoryBytes: idle.memoryBytes, downBps: 0, upBps: 0 };
    for (const seat of this.seats.values()) {
      if (seat.evicted) continue;
      const w = this.weight(seat, now);
      held.cpuCores += seat.cost.cpuCores * w;
      held.remuxerCores += seat.cost.remuxerCores * w;
      held.memoryBytes += seat.cost.memoryBytes * w;
      held.downBps += seat.cost.downBps * w;
      held.upBps += seat.cost.upBps * w;
    }
    return {
      cpuCores: Math.max(held.cpuCores, this.cpuCores),
      // Planned from the seats alone: the thread's measured load is mostly read-ahead, which gives way to
      // playback by slowing down. A thread that is really full shows as busy (busyRemuxerCores, the loop's lag).
      remuxerCores: held.remuxerCores,
      memoryBytes: Math.max(held.memoryBytes, this.memoryBytes),
      downBps: Math.max(held.downBps, this.downBps),
      upBps: held.upBps,
    };
  }

  /** The first budget a stream of `cost` could not fit even on an idle machine: no wait would ever let it in. */
  private neverFits(cost: Cost): CapacityReason | null {
    const budget = this.budgets();
    const idle = this.idle();
    if (idle.memoryBytes + cost.memoryBytes > budget.memoryBytes) return "memory";
    if (idle.cpuCores + cost.cpuCores > budget.cpuCores || cost.remuxerCores > budget.remuxerCores) return "cpu";
    if (cost.downBps > budget.downBps || cost.upBps > budget.upBps) return "network";
    return null;
  }

  private remuxSeats(): number {
    let count = 0;
    for (const seat of this.seats.values()) if (!seat.evicted && seat.stream.delivery === "remux") count++;
    return count;
  }

  /** The first budget a stream of `cost` would overrun, or null when it fits. */
  private shortOf(cost: Cost): CapacityReason | null {
    const budget = this.budgets();
    const plan = this.planned();
    if (plan.memoryBytes + cost.memoryBytes > budget.memoryBytes) return "memory";
    if (plan.cpuCores + cost.cpuCores > budget.cpuCores || plan.remuxerCores + cost.remuxerCores > budget.remuxerCores) return "cpu";
    if (plan.downBps + cost.downBps > budget.downBps || plan.upBps + cost.upBps > budget.upBps) return "network";
    return null;
  }

  /** Starts in the last `withinMs` (the start window by default). */
  private recentStarts(now: number, withinMs = this.config.startWindowMs): number {
    this.starts = this.starts.filter((at) => now - at < Math.max(this.config.startWindowMs, WARMING_GRACE_MS));
    return this.starts.filter((at) => now - at < withinMs).length;
  }

  /** How many streams are building their first minute at full speed now (the remuxer counts them each second). */
  setWarming(count: number): void {
    this.warming = Math.max(0, count);
  }

  /** Tickets in the order they are let in: the owner's first, then by arrival. */
  private line(): Ticket[] {
    return [...this.tickets.values()].sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
  }

  /** Why a stream of `cost` cannot start now (the level, its budgets, the run limit, the start rate), or null when it can. */
  private refusal(cost: Cost, priority: number, now: number, delivery: Delivery = "remux"): CapacityReason | null {
    if (this.level !== "ok") return this.reasons[0] ?? "cpu";
    const short = this.shortOf(cost);
    if (short) return short;
    if (delivery === "remux" && this.remuxSeats() >= this.config.maxRemuxSeats) return "seats";
    if (priority === 0 && this.recentStarts(now) >= this.config.startsPerWindow) return "starts";
    // A stream let in now would warm up beside the ones still racing for their first minute.
    if (priority === 0 && delivery === "remux" && this.warming + this.recentStarts(now, WARMING_GRACE_MS) >= this.config.maxWarming) return "starts";
    return null;
  }

  private admit(watcher: string, priority: number, stream: StreamDescription, cost: Cost, now: number, waitedMs = 0): SeatAnswer {
    const seat: Seat = {
      id: newId(),
      watcher,
      priority,
      stream,
      cost,
      admittedAt: now,
      renewedAt: now,
      sessionId: null,
      evicted: null,
      playing: false,
      pausedSince: null,
      activeAt: now,
      lastStallAt: Number.NEGATIVE_INFINITY,
    };
    this.seats.set(seat.id, seat);
    this.starts.push(now);
    return { status: "admitted", seat: seat.id, level: this.level, waitedMs };
  }

  /**
   * A viewer asks to start a stream, or asks again about their place in line
   * (`ticket`). Let in when nobody is ahead of them and it fits; otherwise
   * kept in line, or told to come back later when the line is full.
   */
  request(input: { watcher: string; priority: number; stream: StreamDescription; ticket?: string; resume?: boolean }): SeatAnswer {
    const now = this.now();
    this.expire(now);
    input = { ...input, stream: declaredStream(input.stream) };
    const cost = streamCost(input.stream, this.config.costModel);
    // A stream already playing whose seat lapsed (a hidden tab renewed late) takes it back: refusing it would
    // not take its load off the machine, and an overload still has the stops.
    if (!this.config.enabled || input.resume) return this.admit(input.watcher, input.priority, input.stream, cost, now);

    let ticket = input.ticket ? this.tickets.get(input.ticket) : undefined;
    if (ticket && ticket.watcher !== input.watcher) ticket = undefined;
    if (ticket) {
      ticket.polledAt = now;
      // The stream asked for may have changed while waiting (a better source turned up): the line keeps the place.
      ticket.stream = input.stream;
      ticket.cost = cost;
    }
    // A stream that would not fit on an idle machine would wait for ever, and hold up everyone behind it.
    const never = this.neverFits(cost);
    if (never) {
      if (ticket) this.tickets.delete(ticket.id);
      return { status: "full", retryAfterS: FULL_RETRY_S, reason: never, level: this.level };
    }
    const line = this.line();
    const ahead = ticket ? line.indexOf(ticket) : line.filter((t) => t.priority >= input.priority).length;
    const refusal = ahead === 0 ? this.refusal(cost, input.priority, now, input.stream.delivery) : null;
    if (ahead === 0 && !refusal) {
      if (ticket) this.tickets.delete(ticket.id);
      return this.admit(input.watcher, input.priority, input.stream, cost, now, ticket ? now - ticket.queuedAt : 0);
    }
    const joined = !ticket;
    if (!ticket) {
      // The owner's profiles can always join, at the front.
      if (this.tickets.size >= this.config.queueMax && input.priority === 0) {
        return { status: "full", retryAfterS: FULL_RETRY_S, reason: refusal ?? "seats", level: this.level };
      }
      ticket = { id: newId(), watcher: input.watcher, priority: input.priority, stream: input.stream, cost, queuedAt: now, polledAt: now };
      this.tickets.set(ticket.id, ticket);
    }
    const position = this.line().indexOf(ticket) + 1;
    const lighter = streamClass(input.stream.height) === "4k" ? streamCost({ ...input.stream, height: 1080, bitrateBps: 0 }, this.config.costModel) : null;
    // Offered only when the lighter stream would start now on every count (the seats and warm-ups too), not
    // only within the budgets: a viewer who took it and still waited was offered nothing.
    const lighterNow = Boolean(lighter && position === 1 && !this.refusal(lighter, input.priority, now, input.stream.delivery));
    return {
      status: "queued",
      ticket: ticket.id,
      joined,
      position,
      waiting: this.tickets.size,
      reason: refusal ?? "seats",
      level: this.level,
      lighterFits: lighterNow,
    };
  }

  /** The viewer is still there: keeps their seat, and hears their stalls. Says so when the seat was stopped. */
  renew(seatId: string, watcher: string, report: { stalls?: number; playing?: boolean; stream?: StreamDescription } = {}): RenewAnswer {
    const now = this.now();
    this.expire(now);
    const seat = this.seats.get(seatId);
    if (!seat || seat.watcher !== watcher) return { status: "unknown" };
    if (seat.evicted) return { status: "evicted", reason: seat.evicted };
    seat.renewedAt = now;
    if (report.playing !== undefined) {
      seat.playing = report.playing;
      seat.pausedSince = report.playing ? null : (seat.pausedSince ?? now);
    }
    if ((report.stalls ?? 0) > 0) seat.lastStallAt = now;
    // The viewer moved to another kind of stream (another source, another quality): the seat costs what that one does.
    const next = report.stream ? declaredStream(report.stream) : null;
    if (next && (next.delivery !== seat.stream.delivery || streamClass(next.height) !== streamClass(seat.stream.height))) {
      seat.stream = next;
      seat.cost = streamCost(next, this.config.costModel);
    }
    return { status: "active", level: this.level };
  }

  /** Seats this viewer holds and has not had stopped. */
  activeSeatCount(watcher: string): number {
    let count = 0;
    for (const seat of this.seats.values()) if (seat.watcher === watcher && !seat.evicted) count++;
    return count;
  }

  release(seatId: string, watcher: string): void {
    const seat = this.seats.get(seatId);
    if (seat && seat.watcher === watcher) this.seats.delete(seatId);
    const ticket = this.tickets.get(seatId);
    if (ticket && ticket.watcher === watcher) this.tickets.delete(seatId);
  }

  /** Whether a seat is this viewer's and in use, was stopped (with why), or is not known (never given, or given up). */
  seatState(seatId: string, watcher: string): { state: "active" } | { state: "evicted"; reason: CapacityReason } | { state: "unknown" } {
    const seat = this.seats.get(seatId);
    if (!seat || seat.watcher !== watcher) return { state: "unknown" };
    return seat.evicted ? { state: "evicted", reason: seat.evicted } : { state: "active" };
  }

  /** The seat's stream is this remux session: its requests keep the seat, and its runs stop with it. */
  attach(seatId: string, watcher: string, sessionId: string, bitrateBps?: number | null, audioTranscode?: boolean): boolean {
    const seat = this.seats.get(seatId);
    if (!seat || seat.watcher !== watcher || seat.evicted) return false;
    seat.sessionId = sessionId;
    seat.renewedAt = this.now();
    // The file's own bitrate, once indexed, replaces the estimate the page made from its size.
    if ((bitrateBps && bitrateBps > 0) || audioTranscode !== undefined) {
      seat.stream = {
        ...seat.stream,
        delivery: "remux",
        ...(bitrateBps && bitrateBps > 0 ? { bitrateBps } : {}),
        ...(audioTranscode !== undefined ? { audioTranscode } : {}),
      };
      seat.cost = streamCost(seat.stream, this.config.costModel);
    }
    return true;
  }

  /** A request for a session's playlist, init or slices: its viewer is watching. */
  touch(sessionId: string, watcher: string): void {
    const now = this.now();
    for (const seat of this.seats.values()) {
      if (seat.sessionId !== sessionId || seat.watcher !== watcher || seat.evicted) continue;
      seat.renewedAt = now;
      seat.activeAt = now;
    }
  }

  /** Why this viewer's stream of this session was stopped, or null when it was not. */
  evictedFrom(sessionId: string, watcher: string): CapacityReason | null {
    let reason: CapacityReason | null = null;
    for (const seat of this.seats.values()) {
      if (seat.sessionId !== sessionId || seat.watcher !== watcher) continue;
      if (!seat.evicted) return null;
      reason = seat.evicted;
    }
    return reason;
  }

  /** True when this viewer holds a seat for this session already. */
  seated(sessionId: string, watcher: string): boolean {
    for (const seat of this.seats.values()) if (seat.sessionId === sessionId && seat.watcher === watcher && !seat.evicted) return true;
    return false;
  }

  /**
   * A stream opened without asking first (a page from before the governor, a
   * test): let in on the spot when it fits and nobody is waiting, else refused.
   * Never queued: whoever asks this way cannot wait in line.
   */
  admitUnasked(watcher: string, stream: StreamDescription): { seat: string } | { refused: CapacityReason } {
    const now = this.now();
    this.expire(now);
    const cost = streamCost(stream, this.config.costModel);
    if (this.config.enabled) {
      if (this.tickets.size) return { refused: "seats" };
      const refusal = this.refusal(cost, 0, now, stream.delivery);
      if (refusal) return { refused: refusal };
    }
    const answer = this.admit(watcher, 0, stream, cost, now);
    return { seat: (answer as { seat: string }).seat };
  }

  /** May a prewarm (a stream got ready before Play) run now? Only with room to spare: it is a guess, not a viewer. */
  prewarmAllowed(): boolean {
    if (!this.config.enabled) return true;
    return (
      this.level === "ok" &&
      !this.tickets.size &&
      this.remuxSeats() < this.config.maxRemuxSeats &&
      !this.shortOf(streamCost({ delivery: "remux", height: 2160, bitrateBps: 0, remote: false }, this.config.costModel))
    );
  }

  /** Gives up seats and places nobody asked about lately, and forgets stopped seats after a while. */
  private expire(now: number): void {
    for (const [id, seat] of this.seats) {
      if (seat.evicted ? now - seat.renewedAt > EVICTED_MEMORY_MS : now - seat.renewedAt > this.config.seatTtlMs) this.seats.delete(id);
    }
    for (const [id, ticket] of this.tickets) if (now - ticket.polledAt > this.config.ticketTtlMs) this.tickets.delete(id);
  }

  /**
   * Once a second: expires what was left, and while critical, picks the next
   * stream to stop (lowest priority, then a stream playing now before a resting
   * one, which gives nothing back, then the heaviest share of a budget, then the
   * newest). Returns the seats stopped now; the caller stops their runs.
   */
  housekeeping(): Eviction[] {
    const now = this.now();
    this.expire(now);
    if (!this.config.enabled || this.level !== "critical") return [];
    const hot = this.reasons.includes("temperature");
    if (now - this.lastEvictionAt < (hot ? this.config.evictEveryHotMs : this.config.evictEveryMs)) return [];
    const budget = this.budgets();
    const share = (cost: Cost): number =>
      Math.max(
        cost.cpuCores / budget.cpuCores,
        cost.remuxerCores / budget.remuxerCores,
        cost.memoryBytes / budget.memoryBytes,
        cost.downBps / budget.downBps,
        cost.upBps / budget.upBps
      );
    const busyNow = (seat: Seat): number => (now - seat.activeAt <= PLAYING_WINDOW_MS || (seat.playing && now - seat.renewedAt <= PLAYING_WINDOW_MS) ? 1 : 0);
    const victim = [...this.seats.values()]
      .filter((seat) => !seat.evicted)
      .sort((a, b) => a.priority - b.priority || busyNow(b) - busyNow(a) || share(b.cost) - share(a.cost) || b.admittedAt - a.admittedAt)[0];
    if (!victim) return [];
    const reason: CapacityReason = this.reasons[0] ?? "cpu";
    victim.evicted = reason;
    victim.renewedAt = now;
    this.lastEvictionAt = now;
    return [{ seat: victim.id, watcher: victim.watcher, sessionId: victim.sessionId, reason, stream: victim.stream, heldMs: now - victim.admittedAt }];
  }

  /** Every seat (stopped ones still remembered too), for the dashboard: what it is for, what it costs, how it is used. */
  seatsDetail(): SeatDetail[] {
    const now = this.now();
    this.expire(now);
    const budget = this.budgets();
    const share = (value: number, of: number) => (Number.isFinite(of) && of > 0 ? value / of : 0);
    return [...this.seats.values()].map((seat) => ({
      watcher: seat.watcher,
      priority: seat.priority,
      sessionId: seat.sessionId,
      delivery: seat.stream.delivery,
      class: streamClass(seat.stream.height),
      bitrateBps: seat.stream.bitrateBps,
      remote: seat.stream.remote,
      cpuCores: seat.cost.cpuCores * this.weight(seat, now),
      share: Math.max(
        share(seat.cost.cpuCores, budget.cpuCores),
        share(seat.cost.remuxerCores, budget.remuxerCores),
        share(seat.cost.memoryBytes, budget.memoryBytes),
        share(seat.cost.downBps, budget.downBps),
        share(seat.cost.upBps, budget.upBps)
      ) * this.weight(seat, now),
      playing: seat.playing,
      paused: seat.pausedSince !== null,
      admittedAgoMs: now - seat.admittedAt,
      activeAgoMs: now - seat.activeAt,
      evicted: seat.evicted,
    }));
  }

  /** The queue in the order it is let in. */
  queueDetail(): QueueDetail[] {
    const now = this.now();
    this.expire(now);
    return this.line().map((ticket, i) => ({
      position: i + 1,
      watcher: ticket.watcher,
      priority: ticket.priority,
      delivery: ticket.stream.delivery,
      class: streamClass(ticket.stream.height),
      waitedMs: now - ticket.queuedAt,
    }));
  }

  snapshot(): CapacitySnapshot {
    const now = this.now();
    this.expire(now);
    const seatsByClass: Record<StreamClass, number> = { "4k": 0, "1080p": 0, "720p": 0, sd: 0 };
    let seats = 0;
    for (const seat of this.seats.values()) {
      if (seat.evicted) continue;
      seats++;
      seatsByClass[streamClass(seat.stream.height)]++;
    }
    const budget = this.budgets();
    const plan = this.planned();
    const ratio = (a: number, b: number) => (Number.isFinite(b) && b > 0 ? a / b : 0);
    return {
      enabled: this.config.enabled,
      level: this.level,
      reasons: this.reasons,
      seats,
      seatsByClass,
      queue: this.tickets.size,
      use: {
        cpu: ratio(plan.cpuCores, budget.cpuCores),
        remuxer: ratio(plan.remuxerCores, budget.remuxerCores),
        memory: ratio(plan.memoryBytes, budget.memoryBytes),
        downlink: ratio(plan.downBps, budget.downBps),
        uplink: ratio(plan.upBps, budget.upBps),
      },
      measured: {
        cpuCores: this.cpuCores,
        cpuLimitCores: this.cpuLimitCores,
        remuxerCores: this.remuxerCores,
        throttledShare: this.throttledShare,
        memoryBytes: this.memoryBytes,
        memoryLimitBytes: this.memoryLimitBytes,
        temperatureC: this.temperatureC,
        loopLagMs: this.loopLagMs,
        loopFreezeMs: this.loopFreezeMs,
        downBps: this.downBps,
        stallShare: this.stallShare(now),
      },
    };
  }
}

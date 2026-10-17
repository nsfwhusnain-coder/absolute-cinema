/**
 * The remuxer's live numbers (see docs/TELEMETRY.md), served at GET /metrics
 * on its own port and passed on by the web app's /api/metrics.
 */

import { metrics } from "../../src/lib/metrics";

const registry = metrics();

/** Bit-rate buckets for one upstream connection, in bits per second. */
export const LANE_BUCKETS = [1e6, 2e6, 3e6, 5e6, 8e6, 12e6, 20e6, 35e6, 60e6, 100e6, 200e6, 400e6] as const;

// Sessions and runs.
export const remuxSessions = registry.gauge("ac_remux_sessions", "Remux sessions open.");
export const remuxRuns = registry.gauge("ac_remux_runs", "ffmpeg runs alive, by whether they are paused (far enough ahead of the viewer).", ["paused"]);
export const remuxViewers = registry.gauge("ac_remux_viewers", "Viewers who asked the remuxer for something in the last 30 seconds.");
export const remuxSessionOpens = registry.counter("ac_remux_session_opens_total", "Files indexed for a new session, by outcome (ok, or the error's HTTP status).", ["outcome", "cdn"]);
export const remuxIndexSeconds = registry.histogram("ac_remux_index_seconds", "Reading a file's head, end and Cues.", ["cdn"]);
export const remuxRunsStarted = registry.counter("ac_remux_runs_started_total", "ffmpeg runs started.", ["cdn"]);
export const remuxRunsEnded = registry.counter(
  "ac_remux_runs_ended_total",
  "ffmpeg runs ended, by reason: completed, idle, viewer_left, run_limit, made_nothing, bad_stream, unusable, failed, session_ended, capacity, other.",
  ["reason"]
);
export const remuxFirstFragmentSeconds = registry.histogram("ac_remux_first_fragment_seconds", "From a run's start to its first fragment.", ["cdn"]);
export const remuxBytesServed = registry.counter("ac_remux_bytes_served_total", "Bytes of fragments and init segments handed to players.", ["kind"]);
export const remuxCacheBytes = registry.gauge("ac_remux_cache_bytes", "Bytes in the remux cache on disk.");
export const remuxDiskFreeBytes = registry.gauge("ac_remux_disk_free_bytes", "Free bytes on the remux cache's disk.");

// The range proxy in front of the debrid CDNs.
export const proxyUpstreamBytes = registry.counter("ac_proxy_upstream_bytes_total", "Bytes read from a CDN.", ["cdn"]);
export const proxyUpstreamRequests = registry.counter(
  "ac_proxy_upstream_requests_total",
  "Range requests to a CDN, by outcome: ok, refused, error, silent, wrong_range.",
  ["cdn", "outcome"]
);
export const proxyOpenRequests = registry.gauge("ac_proxy_open_requests", "Range requests to a CDN in flight.", ["cdn"]);
export const proxyFirstByteSeconds = registry.histogram("ac_proxy_first_byte_seconds", "A CDN's time to first byte for a range.", ["cdn"]);
export const proxyLaneBits = registry.histogram("ac_proxy_lane_bits", "One connection's measured speed, each time it is sampled.", ["cdn"], LANE_BUCKETS);
export const proxyLanes = registry.gauge("ac_proxy_lanes", "Connections the files being read use, summed per CDN.", ["cdn"]);
export const proxyTurnWaitSeconds = registry.histogram("ac_proxy_turn_wait_seconds", "Time a request waited for its link's turn (paced CDNs).", ["cdn"]);

// The container's own network and this process.
export const containerNetworkBytes = registry.gauge(
  "ac_container_network_bytes",
  "Bytes received and sent by the container since it started (all its processes), from /proc/net/dev.",
  ["direction"]
);
export const processResidentBytes = registry.gauge("ac_process_resident_bytes", "Resident memory of a process.", ["process"]);
export const processCpuSeconds = registry.gauge("ac_process_cpu_seconds", "CPU seconds used by a process since it started.", ["process"]);

/** A run's stop reason (vod.ts stopRun) as the bounded label remuxRunsEnded uses. */
export function runEndReason(reason: string): string {
  if (/^idle/.test(reason)) return "idle";
  if (/viewer left/.test(reason)) return "viewer_left";
  if (/run limit/.test(reason)) return "run_limit";
  if (/made nothing/.test(reason)) return "made_nothing";
  if (/bad stream/.test(reason)) return "bad_stream";
  if (/began at|sound and no picture/.test(reason)) return "unusable";
  if (/^capacity/.test(reason)) return "capacity";
  if (/source changed|session/.test(reason)) return "session_ended";
  return "other";
}

// The capacity governor (governor.ts, docs/CAPACITY.md).
export const capacityLevel = registry.gauge("ac_capacity_level", "The machine's state as the governor judges it: 0 ok, 1 busy (nobody new is let in), 2 critical (streams are stopped).");
export const capacityReasons = registry.gauge("ac_capacity_reason", "1 for each reading that holds the level above ok: temperature, cpu, memory, network, playback.", ["reason"]);
export const capacitySeats = registry.gauge("ac_capacity_seats", "Streams holding a seat, by picture class.", ["class"]);
export const capacityQueue = registry.gauge("ac_capacity_queue", "Viewers waiting in line for a seat.");
export const capacityUse = registry.gauge("ac_capacity_use_ratio", "Planned use of each budget, 0-1 (seats held, or the measured use when that is more).", ["resource"]);
export const capacityCpuCores = registry.gauge("ac_capacity_cpu_cores", "The container's CPU use (used), smoothed over about 20 s, the cores it may use (limit), and the remuxer's own thread (remuxer).", ["kind"]);
export const capacityThrottled = registry.gauge("ac_capacity_throttled_ratio", "Share of the container's CPU periods its quota ran out in, over the last 10 s.");
export const capacityMemoryBytes = registry.gauge("ac_capacity_memory_bytes", "Memory the container holds and cannot drop (page cache left out), and its ceiling.", ["kind"]);
export const capacityTemperature = registry.gauge("ac_capacity_temperature_celsius", "The CPU's temperature, averaged over the last 5 s (absent when no sensor is readable).");
export const capacityLoopLag = registry.gauge("ac_capacity_loop_lag_seconds", "How late the remuxer's event loop runs, 95th percentile of the last 10 s.");
export const capacityRequests = registry.counter(
  "ac_capacity_requests_total",
  "Requests for a seat, by answer: admitted, queued, full, unasked_admitted, unasked_refused, prewarm_refused.",
  ["answer"]
);
export const capacityEvictions = registry.counter("ac_capacity_evictions_total", "Streams stopped to protect the machine, by reason.", ["reason"]);
export const capacityQueueWaitSeconds = registry.histogram("ac_capacity_queue_wait_seconds", "Time from joining the line to being let in.", [], [1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800]);

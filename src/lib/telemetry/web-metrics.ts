/**
 * The web app's live numbers (see docs/TELEMETRY.md). Scraped by Prometheus
 * through /api/metrics, together with the remuxer's and the scraper's.
 */

import { metrics } from "../metrics";

const registry = metrics();

/** Bit-rate buckets, in bits per second: from a phone's web stream to a 4K remux. */
export const BITRATE_BUCKETS = [1e6, 2e6, 4e6, 6e6, 8e6, 12e6, 16e6, 25e6, 40e6, 60e6, 100e6] as const;
/** Buffer-ahead buckets, in seconds. */
export const BUFFER_BUCKETS = [0.5, 1, 2, 4, 8, 15, 30, 60, 120, 240] as const;

// What each "what can play this" answer held, and how long it took.
export const playbackAnswers = registry.counter("ac_web_playback_answers_total", "Answers to 'what can play this title'.", ["mode", "cache", "status"]);
export const playbackAnswerSeconds = registry.histogram("ac_web_playback_answer_seconds", "Time to answer 'what can play this title'.", ["mode", "cache"]);

// What a title's search found, counted once per title when the debrid services have settled.
export const discoveryOutcomes = registry.counter(
  "ac_web_discovery_outcomes_total",
  "Titles by the best a search found: 2160, 1080, 720, sd (debrid files), web_only, nothing.",
  ["media", "outcome"]
);
export const discoverySources = registry.counter(
  "ac_web_discovery_sources_total",
  "Files and streams found per settled search, by service, origin (debrid/web) and quality bucket.",
  ["provider", "origin", "quality"]
);
export const discoveryUpscaled = registry.counter(
  "ac_web_discovery_judged_total",
  "Debrid files by what the release judge said of them (tier 3 normal, 2 heavy, 1 flagged; upscaled, starved).",
  ["provider", "verdict"]
);
export const debridResolveSeconds = registry.histogram(
  "ac_web_debrid_resolve_seconds",
  "Debrid searches: time to the first 1080p, the first 2160p, and the whole search.",
  ["service", "stage"]
);

// Opening a file to remux, from the web app's side (includes the remuxer's index read).
export const vodOpens = registry.counter("ac_web_vod_opens_total", "Remux opens by outcome.", ["outcome", "prewarm"]);
export const vodOpenSeconds = registry.histogram("ac_web_vod_open_seconds", "Time to open a file to remux.", ["prewarm"]);

// The players' own reports (POST /api/playback/feedback).
export const playerFirstFrameSeconds = registry.histogram(
  "ac_web_player_first_frame_seconds",
  "From choosing a file to its first picture.",
  ["device", "delivery", "service", "quality"]
);
export const playerOpenToFrameSeconds = registry.histogram(
  "ac_web_player_open_to_frame_seconds",
  "From opening a title to its first picture (the wait a viewer sees).",
  ["device", "delivery", "quality"]
);
export const playerStartFailures = registry.counter("ac_web_player_start_failures_total", "Starts that failed, by reason class.", ["device", "delivery", "service", "reason"]);
export const playerStalls = registry.counter("ac_web_player_stalls_total", "Stalls after the first picture.", ["device", "delivery", "service"]);
export const playerStallSeconds = registry.counter("ac_web_player_stall_seconds_total", "Seconds spent stalled after the first picture.", ["device", "delivery", "service"]);
export const playerWatchSeconds = registry.counter("ac_web_player_watch_seconds_total", "Seconds of playback.", ["device", "delivery", "quality"]);
export const playerSeekSeconds = registry.histogram("ac_web_player_seek_seconds", "From a jump to playing again.", ["device", "delivery"]);
export const playerBitrate = registry.histogram("ac_web_player_bitrate_bits", "Delivered bit rate per heartbeat (bytes loaded over time loaded).", ["delivery"], BITRATE_BUCKETS);
export const playerBandwidth = registry.histogram("ac_web_player_bandwidth_bits", "The player's own estimate of its download speed, per heartbeat.", ["device"], BITRATE_BUCKETS);
export const playerBufferAhead = registry.histogram("ac_web_player_buffer_ahead_seconds", "Seconds buffered ahead of the playhead, per heartbeat.", ["device", "delivery"], BUFFER_BUCKETS);
export const playerDroppedFrames = registry.counter("ac_web_player_dropped_frames_total", "Frames the browser dropped.", ["device", "quality"]);
export const playerDecodedFrames = registry.counter("ac_web_player_decoded_frames_total", "Frames the browser decoded.", ["device", "quality"]);
export const playerActiveSessions = registry.gauge("ac_web_player_active_sessions", "Players that sent a heartbeat in the last minute.", ["device", "delivery"]);

// The debrid CDNs' measured speed (cdn-rate.ts), one connection, best of the last 30 minutes.
export const cdnRateBits = registry.gauge("ac_web_cdn_rate_bits", "A debrid service's CDN as last measured, in bits per second over one connection.", ["service"]);
export const cdnMeasurements = registry.counter("ac_web_cdn_measurements_total", "CDN speed measurements made.", ["service", "outcome"]);

/** A device class as metrics are labelled: the player's own class, or "other". */
export function deviceLabel(deviceClass: unknown): string {
  return typeof deviceClass === "string" && /^(desktop|tablet|phone|tv)$/.test(deviceClass) ? deviceClass : "other";
}

/** A playback service as metrics are labelled: lower case, letters only, or "other". */
export function serviceLabel(provider: unknown): string {
  if (typeof provider !== "string" || !provider) return "unknown";
  const name = provider.toLowerCase().replace(/[^a-z]/g, "");
  if (name === "debrid" || name === "realdebrid") return "realdebrid";
  return name.slice(0, 24) || "other";
}

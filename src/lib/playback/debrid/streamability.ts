import type { DebridCandidate } from "./torrentio";

/**
 * Average bitrates the playback path sustains without rebuffering, per
 * resolution. A Real-Debrid download runs at roughly 12 MB/s (~96 Mbps) on
 * one connection, and a remuxed MKV is read through that single connection,
 * so a UHD REMUX averaging 70-80 Mbps (with scene peaks well above) drains
 * the buffer: it plays a little, loads a little, then trips the stall
 * watchdog. A good 4K encode at 15-40 Mbps looks the same on a TV and never
 * stalls.
 */
const STREAMABLE_MBPS: Record<720 | 1080 | 2160, number> = {
  720: 20,
  1080: 30,
  2160: 45,
};

/** Estimated average bitrate in Mbps, or null without a size or runtime. */
export function estimatedMbps(sizeBytes: number | undefined, runtimeMinutes: number | null): number | null {
  if (!sizeBytes || sizeBytes <= 0 || !runtimeMinutes || runtimeMinutes <= 0) return null;
  return (sizeBytes * 8) / (runtimeMinutes * 60) / 1_000_000;
}

/**
 * Keeps the existing quality order, but moves releases too heavy to stream
 * smoothly behind every release that is not, lightest first. Unknown sizes
 * stay with the streamable group: most are ordinary encodes.
 */
export function orderForStreaming(candidates: DebridCandidate[], runtimeMinutes: number | null): DebridCandidate[] {
  if (!runtimeMinutes) return candidates;
  const heavy: { candidate: DebridCandidate; mbps: number }[] = [];
  const smooth: DebridCandidate[] = [];
  for (const candidate of candidates) {
    const mbps = estimatedMbps(candidate.sizeBytes, runtimeMinutes);
    if (mbps != null && mbps > STREAMABLE_MBPS[candidate.resolutionHeight]) heavy.push({ candidate, mbps });
    else smooth.push(candidate);
  }
  heavy.sort((a, b) => a.mbps - b.mbps);
  return [...smooth, ...heavy.map((entry) => entry.candidate)];
}

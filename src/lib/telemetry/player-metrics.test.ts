/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { metrics } from "../metrics";
import {
  forgetActivePlayer,
  noteActivePlayer,
  playerLabels,
  recordFirstFrame,
  recordHeartbeat,
  recordSeek,
  recordStall,
  recordStartFailure,
} from "./player-metrics";

/** The value of one rendered series, or 0 when it has none yet. Tests read deltas, since the registry is shared. */
function sample(series: string): number {
  const line = metrics()
    .render()
    .split("\n")
    .find((row) => row.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

describe("playerLabels", () => {
  it("labels a report by its device class, route, service and picture", () => {
    expect(
      playerLabels({ deviceClass: "tv", delivery: "remux", provider: "Real-Debrid", decodedWidth: 3840, decodedHeight: 1600 })
    ).toEqual({ device: "tv", delivery: "remux", service: "realdebrid", quality: "2160" });
  });

  it("falls back to other, unknown and none for what it cannot tell", () => {
    expect(playerLabels({ provider: "" })).toEqual({ device: "other", delivery: "unknown", service: "unknown", quality: "unknown" });
  });
});

describe("recordStartFailure", () => {
  it("counts a failed start by its reason class", () => {
    const labels = playerLabels({ deviceClass: "desktop", delivery: "web", provider: "Alpha Start Test" });
    const series = (reason: string) => `ac_web_player_start_failures_total{device="desktop",delivery="web",service="alphastarttest",reason="${reason}"}`;
    const before = sample(series("hls_network"));
    recordStartFailure(labels, "hls:fragLoadTimeOut");
    recordStartFailure(labels, "hls:fragLoadTimeOut");
    expect(sample(series("hls_network")) - before).toBe(2);
    expect(sample(series("hls_media"))).toBe(0);
  });
});

describe("recordStall and recordSeek", () => {
  it("counts a stall, and times a jump", () => {
    const labels = playerLabels({ deviceClass: "tv", delivery: "native", provider: "Bravo Stall Test" });
    const stalls = 'ac_web_player_stalls_total{device="tv",delivery="native",service="bravostalltest"}';
    const before = sample(stalls);
    recordStall(labels);
    expect(sample(stalls) - before).toBe(1);

    const seekCount = 'ac_web_player_seek_seconds_count{device="tv",delivery="native"}';
    const seekBefore = sample(seekCount);
    recordSeek(labels, 2_500);
    recordSeek(labels, null);
    expect(sample(seekCount) - seekBefore).toBe(1);
  });
});

describe("recordFirstFrame", () => {
  it("times the first picture from the choice of file, and from opening the title when given", () => {
    const labels = playerLabels({ deviceClass: "desktop", delivery: "remux", provider: "Charlie Frame Test", decodedHeight: 1080 });
    const first = 'ac_web_player_first_frame_seconds_count{device="desktop",delivery="remux",service="charlieframetest",quality="1080"}';
    const open = 'ac_web_player_open_to_frame_seconds_sum{device="desktop",delivery="remux",quality="1080"}';
    const firstBefore = sample(first);
    const openBefore = sample(open);
    recordFirstFrame(labels, { timeToFirstFrameMs: 3_000, sinceOpenMs: 4_500 });
    recordFirstFrame(labels, { timeToFirstFrameMs: 1_000, sinceOpenMs: null });
    expect(sample(first) - firstBefore).toBe(2);
    expect(sample(open) - openBefore).toBeCloseTo(4.5, 9);
  });
});

describe("recordHeartbeat", () => {
  it("adds the watch and stall time, and records the delivered bit rate and the buffer", () => {
    const labels = playerLabels({ deviceClass: "desktop", delivery: "web", provider: "Delta Beat Test", decodedHeight: 720 });
    const watch = 'ac_web_player_watch_seconds_total{device="desktop",delivery="web",quality="720"}';
    const stalled = 'ac_web_player_stall_seconds_total{device="desktop",delivery="web",service="deltabeattest"}';
    const bitrate = 'ac_web_player_bitrate_bits_sum{delivery="web"}';
    const buffer = 'ac_web_player_buffer_ahead_seconds_count{device="desktop",delivery="web"}';
    const bandwidth = 'ac_web_player_bandwidth_bits_count{device="desktop"}';
    const dropped = 'ac_web_player_dropped_frames_total{device="desktop",quality="720"}';
    const decoded = 'ac_web_player_decoded_frames_total{device="desktop",quality="720"}';
    const before = { watch: sample(watch), stalled: sample(stalled), bitrate: sample(bitrate), buffer: sample(buffer), bandwidth: sample(bandwidth), dropped: sample(dropped), decoded: sample(decoded) };

    recordHeartbeat(labels, {
      watchedMs: 30_000,
      stalledMs: 1_500,
      bytesLoaded: 3_750_000,
      loadMs: 1_000,
      bandwidthBps: 8_000_000,
      bufferAheadS: 12,
      droppedFrames: 4,
      decodedFrames: 1_800,
    });

    expect(sample(watch) - before.watch).toBeCloseTo(30, 9);
    expect(sample(stalled) - before.stalled).toBeCloseTo(1.5, 9);
    // 3.75 MB over one second is 30 Mbit/s.
    expect(sample(bitrate) - before.bitrate).toBeCloseTo(30_000_000, 0);
    expect(sample(buffer) - before.buffer).toBe(1);
    expect(sample(bandwidth) - before.bandwidth).toBe(1);
    expect(sample(dropped) - before.dropped).toBe(4);
    expect(sample(decoded) - before.decoded).toBe(1_800);
  });

  it("skips what the browser did not say, rather than recording zeros", () => {
    const labels = playerLabels({ deviceClass: "tv", delivery: "native", provider: "Echo Skip Test" });
    const bitrate = 'ac_web_player_bitrate_bits_count{delivery="native"}';
    const before = sample(bitrate);
    recordHeartbeat(labels, {
      watchedMs: 0,
      stalledMs: null,
      bytesLoaded: null,
      loadMs: null,
      bandwidthBps: null,
      bufferAheadS: null,
      droppedFrames: null,
      decodedFrames: null,
    });
    expect(sample(bitrate)).toBe(before);
  });
});

describe("active players", () => {
  it("counts the files heard from in the last minute, by device and route", () => {
    const viewer = "test-viewer-active-1";
    const gauge = 'ac_web_player_active_sessions{device="phone",delivery="remux"}';
    noteActivePlayer(viewer, "file-one", { device: "phone", delivery: "remux" });
    noteActivePlayer(viewer, "file-two", { device: "phone", delivery: "remux" });
    expect(sample(gauge)).toBe(2);
    forgetActivePlayer(viewer, "file-one");
    expect(sample(gauge)).toBe(1);
    forgetActivePlayer(viewer, "file-two");
    expect(sample(gauge)).toBe(0);
  });

  it("drops a player not heard from for more than a minute", () => {
    const gauge = 'ac_web_player_active_sessions{device="phone",delivery="web"}';
    const viewer = "test-viewer-stale";
    noteActivePlayer(viewer, "old-file", { device: "phone", delivery: "web" }, Date.now() - 120_000);
    expect(sample(gauge)).toBe(0);
    noteActivePlayer(viewer, "new-file", { device: "phone", delivery: "web" });
    expect(sample(gauge)).toBe(1);
    forgetActivePlayer(viewer, "new-file");
  });
});

import { describe, expect, it } from "bun:test";
import { metrics } from "../../src/lib/metrics";
import { proxyLaneBits, remuxFirstFragmentSeconds, remuxRunsStarted, runEndReason } from "./remux-metrics";

describe("runEndReason", () => {
  it("names each stop reason vod.ts gives a run by its bounded label", () => {
    const cases: Array<[string, string]> = [
      ["idle", "idle"],
      ["idle run of another viewer", "idle"],
      ["viewer left", "viewer_left"],
      ["session run limit", "run_limit"],
      ["global run limit", "run_limit"],
      ["made nothing", "made_nothing"],
      ["bad stream: moov atom not found", "bad_stream"],
      ["began at 12.0s, not 10.0s", "unusable"],
      ["sound and no picture", "unusable"],
      ["source changed", "session_ended"],
      ["shutdown", "other"],
      ["expired", "other"],
      ["low disk", "other"],
      ["cache cap", "other"],
    ];
    for (const [reason, label] of cases) expect(runEndReason(reason)).toBe(label);
  });
});

/** The value of one series in the scrape text, or 0 before it has been written. */
function seriesValue(series: string): number {
  const line = metrics().render().split("\n").find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

describe("the scrape text", () => {
  it("names every remuxer and proxy metric, and holds the counts recorded", () => {
    remuxRunsStarted.inc({ cdn: "metrics-test.example" }, 2);
    remuxFirstFragmentSeconds.observe({ cdn: "metrics-test.example" }, 1.5);
    proxyLaneBits.observe({ cdn: "metrics-test.example" }, 9e6);
    const text = metrics().render();

    expect(text).toContain('ac_remux_runs_started_total{cdn="metrics-test.example"} 2');
    expect(text).toContain('ac_remux_first_fragment_seconds_count{cdn="metrics-test.example"} 1');
    expect(text).toContain('ac_proxy_lane_bits_bucket{cdn="metrics-test.example",le="+Inf"} 1');
    expect(seriesValue('ac_remux_runs_started_total{cdn="metrics-test.example"}')).toBe(2);

    const names = [
      "ac_remux_sessions",
      "ac_remux_runs",
      "ac_remux_viewers",
      "ac_remux_session_opens_total",
      "ac_remux_index_seconds",
      "ac_remux_runs_started_total",
      "ac_remux_runs_ended_total",
      "ac_remux_first_fragment_seconds",
      "ac_remux_bytes_served_total",
      "ac_remux_cache_bytes",
      "ac_remux_disk_free_bytes",
      "ac_proxy_upstream_bytes_total",
      "ac_proxy_upstream_requests_total",
      "ac_proxy_open_requests",
      "ac_proxy_first_byte_seconds",
      "ac_proxy_lane_bits",
      "ac_proxy_lanes",
      "ac_proxy_turn_wait_seconds",
      "ac_container_network_bytes",
      "ac_process_resident_bytes",
      "ac_process_cpu_seconds",
    ];
    for (const name of names) expect(text).toMatch(new RegExp(`^# TYPE ${name} (counter|gauge|histogram)$`, "m"));
    expect(text.endsWith("\n")).toBe(true);
  });
});

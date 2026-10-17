import { describe, expect, it } from "bun:test";
import { Registry, qualityBucket } from "./metrics";

describe("Registry", () => {
  it("writes counters, gauges and histograms in Prometheus' text format", () => {
    const registry = new Registry();
    const answers = registry.counter("ac_answers_total", "Answers given.", ["mode"]);
    answers.inc({ mode: "fast" });
    answers.inc({ mode: "fast" }, 2);
    const open = registry.gauge("ac_sessions", "Sessions open.");
    open.set(undefined, 3);
    const took = registry.histogram("ac_open_seconds", "Opening a file.", ["service"], [1, 5]);
    took.observe({ service: "rd" }, 0.5);
    took.observe({ service: "rd" }, 3);
    took.observe({ service: "rd" }, 9);
    const text = registry.render();
    expect(text).toContain('# TYPE ac_answers_total counter\nac_answers_total{mode="fast"} 3');
    expect(text).toContain("ac_sessions 3");
    expect(text).toContain('ac_open_seconds_bucket{service="rd",le="1"} 1');
    expect(text).toContain('ac_open_seconds_bucket{service="rd",le="5"} 2');
    expect(text).toContain('ac_open_seconds_bucket{service="rd",le="+Inf"} 3');
    expect(text).toContain('ac_open_seconds_sum{service="rd"} 12.5');
    expect(text).toContain('ac_open_seconds_count{service="rd"} 3');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("returns the same metric for the same name, and refuses a different kind", () => {
    const registry = new Registry();
    const a = registry.counter("x_total", "x");
    expect(registry.counter("x_total", "x")).toBe(a);
    expect(() => registry.gauge("x_total", "x")).toThrow();
  });

  it("escapes label values, fills missing labels, and ignores nonsense values", () => {
    const registry = new Registry();
    const c = registry.counter("y_total", "y", ["reason", "service"]);
    c.inc({ reason: 'bad "quote"\nline' });
    c.inc({ reason: "x" }, -5);
    const text = registry.render();
    expect(text).toContain('y_total{reason="bad \\"quote\\"\\nline",service="none"} 1');
    // A negative count is not counted at all.
    expect(text).not.toContain('reason="x"');
  });

  it("runs collectors before rendering, and survives one that throws", () => {
    const registry = new Registry();
    const g = registry.gauge("z", "z");
    registry.onCollect(() => g.set(undefined, 7));
    registry.onCollect(() => {
      throw new Error("broken");
    });
    expect(registry.render()).toContain("z 7");
  });
});

describe("qualityBucket", () => {
  it("reads a scope film by its width, and a height alone by its rung", () => {
    expect(qualityBucket(1600, 3840)).toBe("2160");
    expect(qualityBucket(800, 1920)).toBe("1080");
    expect(qualityBucket(2160)).toBe("2160");
    expect(qualityBucket(1080)).toBe("1080");
    expect(qualityBucket(720)).toBe("720");
    expect(qualityBucket(480)).toBe("sd");
    expect(qualityBucket(0)).toBe("unknown");
    expect(qualityBucket(null)).toBe("unknown");
  });
});

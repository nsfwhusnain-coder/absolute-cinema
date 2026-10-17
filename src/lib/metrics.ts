/**
 * Live numbers for Prometheus: counters, gauges and histograms, written out in
 * its text format (version 0.0.4) for a scrape.
 *
 * No dependency, and nothing of Node's or Bun's own: the web app runs on Node,
 * the remuxer and the scraper on Bun, and each process keeps its own registry
 * (on globalThis, so a module bundled twice by Next shares one). Labels must
 * come from small fixed sets (a service, a quality, a device class, a reason):
 * never a title, a viewer or a link, which would make a series each.
 *
 * See docs/TELEMETRY.md for every metric the site records, and why.
 */

export type Labels = Readonly<Record<string, string | number | boolean | undefined>>;

type Kind = "counter" | "gauge" | "histogram";

interface Series {
  labels: Record<string, string>;
  value: number;
  /** Histograms: the count in each bucket (not cumulative), then the sum and count. */
  buckets?: number[];
  sum?: number;
  count?: number;
}

/** Seconds: from a few milliseconds to two minutes, for anything timed. */
export const SECONDS_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 30, 60, 120] as const;

/** Most label values kept per metric; past this, new combinations go to one "other" series. */
const MAX_SERIES = 500;

function cleanLabels(labels: Labels | undefined, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = labels?.[name];
    out[name] = value === undefined || value === "" ? "none" : String(value).slice(0, 64);
  }
  return out;
}

function keyOf(labels: Record<string, string>): string {
  return JSON.stringify(labels);
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function renderLabels(labels: Record<string, string>, extra?: [string, string]): string {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  if (extra) pairs.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return pairs.length ? `{${pairs.join(",")}}` : "";
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

class Metric {
  protected readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly kind: Kind,
    readonly labelNames: readonly string[],
    readonly bucketBounds: readonly number[] = []
  ) {}

  protected seriesFor(labels: Labels | undefined): Series {
    let clean = cleanLabels(labels, this.labelNames);
    let key = keyOf(clean);
    let found = this.series.get(key);
    if (!found && this.series.size >= MAX_SERIES) {
      clean = Object.fromEntries(this.labelNames.map((n) => [n, "other"]));
      key = keyOf(clean);
      found = this.series.get(key);
    }
    if (!found) {
      found = { labels: clean, value: 0, ...(this.kind === "histogram" ? { buckets: this.bucketBounds.map(() => 0), sum: 0, count: 0 } : {}) };
      this.series.set(key, found);
    }
    return found;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help.replace(/\n/g, " ")}`, `# TYPE ${this.name} ${this.kind}`];
    for (const s of this.series.values()) {
      if (this.kind !== "histogram") {
        lines.push(`${this.name}${renderLabels(s.labels)} ${formatNumber(s.value)}`);
        continue;
      }
      let cumulative = 0;
      this.bucketBounds.forEach((bound, i) => {
        cumulative += s.buckets![i]!;
        lines.push(`${this.name}_bucket${renderLabels(s.labels, ["le", String(bound)])} ${cumulative}`);
      });
      lines.push(`${this.name}_bucket${renderLabels(s.labels, ["le", "+Inf"])} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${formatNumber(s.sum!)}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines.join("\n");
  }

  /** Test seam and for gauges rebuilt from scratch at each scrape. */
  reset(): void {
    this.series.clear();
  }
}

export class Counter extends Metric {
  inc(labels?: Labels, by = 1): void {
    if (!(by >= 0)) return;
    this.seriesFor(labels).value += by;
  }
}

export class Gauge extends Metric {
  set(labels: Labels | undefined, value: number): void {
    if (Number.isFinite(value)) this.seriesFor(labels).value = value;
  }

  inc(labels?: Labels, by = 1): void {
    this.seriesFor(labels).value += by;
  }

  dec(labels?: Labels, by = 1): void {
    this.seriesFor(labels).value -= by;
  }
}

export class Histogram extends Metric {
  observe(labels: Labels | undefined, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const s = this.seriesFor(labels);
    const i = this.bucketBounds.findIndex((bound) => value <= bound);
    if (i >= 0) s.buckets![i]! += 1;
    s.sum! += value;
    s.count! += 1;
  }
}

export class Registry {
  private readonly metrics = new Map<string, Metric>();
  /** Called before each render, to set gauges from live state (sessions open, runs alive). */
  private readonly collectors: Array<() => void> = [];

  private add<T extends Metric>(metric: T): T {
    const existing = this.metrics.get(metric.name);
    if (existing) {
      if (existing.kind !== metric.kind) throw new Error(`metric ${metric.name} registered as ${existing.kind} and ${metric.kind}`);
      return existing as T;
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(name, help, "counter", labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(name, help, "gauge", labelNames));
  }

  histogram(name: string, help: string, labelNames: readonly string[] = [], buckets: readonly number[] = SECONDS_BUCKETS): Histogram {
    return this.add(new Histogram(name, help, "histogram", labelNames, [...buckets].sort((a, b) => a - b)));
  }

  /** Runs before every render: the place to set gauges from state that is cheaper to read than to track. */
  onCollect(collect: () => void): void {
    this.collectors.push(collect);
  }

  /** Every metric in Prometheus' text format, ending in a newline. */
  render(): string {
    for (const collect of this.collectors) {
      try {
        collect();
      } catch {
        // One failing collector must not take the whole scrape down.
      }
    }
    const blocks = [...this.metrics.values()].map((m) => m.render());
    return `${blocks.join("\n")}\n`;
  }

  /** Test seam. */
  resetAll(): void {
    for (const metric of this.metrics.values()) metric.reset();
  }
}

const GLOBAL_KEY = "__absoluteCinemaMetrics";

/** This process's registry. */
export function metrics(): Registry {
  const holder = globalThis as unknown as Record<string, Registry | undefined>;
  return (holder[GLOBAL_KEY] ??= new Registry());
}

export type QualityBucket = "2160" | "1440" | "1080" | "720" | "sd" | "unknown";

/**
 * A picture as the quality bucket metrics are labelled with. The width says it
 * best when it is known: a scope film in 4K decodes 3840x1600, and in 1080p
 * 1920x800, so its height alone reads a rung low.
 */
export function qualityBucket(height: number | null | undefined, width?: number | null): QualityBucket {
  const w = width ?? 0;
  if (w > 0) {
    if (w >= 3200) return "2160";
    if (w >= 2200) return "1440";
    if (w >= 1700) return "1080";
    if (w >= 1100) return "720";
    return "sd";
  }
  const h = height ?? 0;
  if (h <= 0) return "unknown";
  if (h >= 2000) return "2160";
  if (h >= 1300) return "1440";
  if (h >= 900) return "1080";
  if (h >= 650) return "720";
  return "sd";
}

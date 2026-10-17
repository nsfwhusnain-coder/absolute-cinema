/**
 * What the capacity governor reads of the machine (docs/CAPACITY.md): the
 * container's own CPU, memory and pressure from its cgroup (v2), the CPU's
 * temperature from the host's sensors, and how late this process's event loop
 * runs. The parsers are pure, so they are tested on fixture text; the readers
 * are the only part that touches the machine, and each gives null when its
 * file is not there (not Linux, cgroup v1, a sensor the kernel does not show).
 */

import { readFileSync, readdirSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";

export interface CpuStat {
  /** CPU time used by everything in the cgroup, in microseconds. */
  usageUsec: number;
  /** Scheduling periods the cgroup had work in, and the ones its quota ran out in. */
  nrPeriods: number;
  nrThrottled: number;
}

/** The counters of a cgroup v2 `cpu.stat`. Null when the text is not that file. */
export function parseCpuStat(text: string): CpuStat | null {
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined && Number.isFinite(Number(value))) fields.set(key, Number(value));
  }
  const usageUsec = fields.get("usage_usec");
  if (usageUsec === undefined) return null;
  return { usageUsec, nrPeriods: fields.get("nr_periods") ?? 0, nrThrottled: fields.get("nr_throttled") ?? 0 };
}

/**
 * The cores the cgroup may use, from `cpu.max` ("<quota> <period>" in
 * microseconds, or "max <period>" for no quota, when every core of the host is
 * its to use).
 */
export function parseCpuMax(text: string, hostCores: number): number {
  const [quota, period] = text.trim().split(/\s+/);
  const q = Number(quota);
  const p = Number(period);
  if (quota === "max" || !(q > 0) || !(p > 0)) return hostCores;
  return Math.min(hostCores, q / p);
}

export interface Pressure {
  /** Share of the last ten seconds, in percent, that some task waited for the resource. */
  someAvg10: number;
}

/** The ten-second average of a pressure file (`cpu.pressure`, `memory.pressure`). */
export function parsePressure(text: string): Pressure | null {
  const some = text.split("\n").find((line) => line.startsWith("some "));
  const avg10 = some?.match(/avg10=([\d.]+)/)?.[1];
  return avg10 === undefined ? null : { someAvg10: Number(avg10) };
}

/**
 * Memory the cgroup holds and cannot give back without swap: process memory,
 * shared memory, socket buffers and the kernel's own. The page cache of the
 * files it writes (the remux cache) is left out: the kernel drops it as soon
 * as memory is wanted, and counted in, eight viewers looked like eleven
 * gigabytes when 2.3 of them were really in use.
 */
export function committedMemoryBytes(memoryStat: string): number | null {
  const fields = new Map<string, number>();
  for (const line of memoryStat.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined) fields.set(key, Number(value));
  }
  const anon = fields.get("anon");
  if (anon === undefined || !Number.isFinite(anon)) return null;
  const extra = ["shmem", "sock", "kernel_stack", "pagetables", "slab_unreclaimable"].reduce((sum, key) => sum + (fields.get(key) ?? 0), 0);
  return anon + extra;
}

/** The cgroup's memory ceiling from `memory.max`, or the host's memory when it has none. */
export function parseMemoryMax(text: string, hostBytes: number): number {
  const value = Number(text.trim());
  return text.trim() === "max" || !(value > 0) ? hostBytes : Math.min(value, hostBytes);
}

/** Sensors that measure the CPU die itself, best first (an ACPI zone is the board, often well below it). */
const CPU_SENSORS = ["k10temp", "zenpower", "coretemp", "cpu_thermal", "soc_thermal"];

/**
 * The file that gives the CPU's temperature, in thousandths of a degree:
 * `CAPACITY_TEMP_PATH` when it is set, else the first input of the best CPU
 * sensor under /sys/class/hwmon (k10temp's is Tctl on AMD, coretemp's the
 * package on Intel). Null when there is none.
 */
export function findCpuTemperaturePath(hwmonRoot = "/sys/class/hwmon", override = process.env.CAPACITY_TEMP_PATH): string | null {
  if (override) return override;
  let entries: string[];
  try {
    entries = readdirSync(hwmonRoot);
  } catch {
    return null;
  }
  const found = new Map<string, string>();
  for (const entry of entries) {
    try {
      const name = readFileSync(join(hwmonRoot, entry, "name"), "utf8").trim();
      if (CPU_SENSORS.includes(name) && !found.has(name)) found.set(name, join(hwmonRoot, entry, "temp1_input"));
    } catch {
      /* a sensor without a name */
    }
  }
  for (const name of CPU_SENSORS) if (found.has(name)) return found.get(name)!;
  return null;
}

/** Degrees Celsius from a sensor file (thousandths of a degree), or null when it cannot be read. */
export function readTemperatureC(path: string | null): number | null {
  if (!path) return null;
  try {
    const milli = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(milli) && milli > 0 ? milli / 1000 : null;
  } catch {
    return null;
  }
}

const CLOCK_TICKS = 100;

/** CPU seconds from the text of a /proc stat file (user and system time), or null when it is not one. */
export function statCpuSeconds(stat: string): number | null {
  // The command name (field 2) may hold spaces: the fields after its closing bracket are fixed.
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? (utime + stime) / CLOCK_TICKS : null;
}

/**
 * The CPU seconds of this process's main thread alone, where its JavaScript
 * runs: /proc/self/task/<pid>/stat (the process's own stat file adds its other
 * threads, the runtime's networking and garbage collection, which a busy
 * process can keep at half a core of their own without the main thread being
 * anywhere near full). Null off Linux.
 */
export function mainThreadCpuSeconds(pid = process.pid): number | null {
  try {
    return statCpuSeconds(readFileSync(`/proc/self/task/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** One reading of the machine, as the governor judges it. */
export interface MachineReading {
  at: number;
  /** Cumulative CPU time of the container, in seconds; rates come from two readings. Null off cgroup v2. */
  cpuSeconds: number | null;
  /** Cumulative scheduling periods, and the ones the quota cut short. */
  periods: number | null;
  throttledPeriods: number | null;
  /** Cores the container may use. */
  cpuLimitCores: number;
  cpuPressure: number | null;
  memoryCommittedBytes: number | null;
  memoryLimitBytes: number;
  memoryPressure: number | null;
  temperatureC: number | null;
  /** The remuxer's main thread's CPU time so far, in seconds: its one JavaScript thread moves every byte. */
  processCpuSeconds?: number | null;
}

/** Reads the container's cgroup and the CPU sensor. Every part that cannot be read is null; nothing throws. */
export class MachineReader {
  private readonly cgroup: string;
  private readonly temperaturePath: string | null;
  private readonly hostCores: number;

  constructor(cgroup = process.env.CAPACITY_CGROUP_DIR || "/sys/fs/cgroup", temperaturePath = findCpuTemperaturePath(), hostCores = availableParallelism()) {
    this.cgroup = cgroup;
    this.temperaturePath = temperaturePath;
    this.hostCores = hostCores;
  }

  /** True when the sensor was found: the summary says when it was not, so a missing guard is not mistaken for a cool CPU. */
  get hasTemperature(): boolean {
    return this.temperaturePath !== null;
  }

  read(at = Date.now()): MachineReading {
    const cpu = parseCpuStat(readText(join(this.cgroup, "cpu.stat")) ?? "");
    const cpuMax = readText(join(this.cgroup, "cpu.max"));
    const memStat = readText(join(this.cgroup, "memory.stat"));
    const memMax = readText(join(this.cgroup, "memory.max"));
    const cpuPressure = parsePressure(readText(join(this.cgroup, "cpu.pressure")) ?? "");
    const memoryPressure = parsePressure(readText(join(this.cgroup, "memory.pressure")) ?? "");
    return {
      at,
      cpuSeconds: cpu ? cpu.usageUsec / 1e6 : null,
      periods: cpu ? cpu.nrPeriods : null,
      throttledPeriods: cpu ? cpu.nrThrottled : null,
      cpuLimitCores: cpuMax ? parseCpuMax(cpuMax, this.hostCores) : this.hostCores,
      cpuPressure: cpuPressure?.someAvg10 ?? null,
      memoryCommittedBytes: memStat ? committedMemoryBytes(memStat) : null,
      memoryLimitBytes: memMax ? parseMemoryMax(memMax, totalmem()) : totalmem(),
      memoryPressure: memoryPressure?.someAvg10 ?? null,
      temperatureC: readTemperatureC(this.temperaturePath),
    };
  }
}

/** How often the event loop's lateness is sampled, and how many samples make its window (ten seconds). */
const LAG_SAMPLE_MS = 250;
const LAG_WINDOW = 40;

/**
 * How late this process's timers fire: a loop busy for a second at a time is a
 * remuxer whose every viewer waits that second for their next slice, whatever
 * the CPU counters say.
 */
export class LoopLag {
  private readonly samples: number[] = [];
  private expected = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    this.expected = performance.now() + LAG_SAMPLE_MS;
    this.timer = setInterval(() => {
      const now = performance.now();
      this.push(Math.max(0, now - this.expected));
      this.expected = now + LAG_SAMPLE_MS;
    }, LAG_SAMPLE_MS);
    this.timer.unref?.();
  }

  push(lagMs: number): void {
    this.samples.push(lagMs);
    if (this.samples.length > LAG_WINDOW) this.samples.shift();
  }

  /** The 95th percentile of the last ten seconds, in milliseconds. */
  p95(): number {
    if (!this.samples.length) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  }

  /**
   * The window as the governor reads it: its 95th percentile, its longest
   * stall, and its second longest. A loop frozen for five seconds gives one
   * late sample, not many (no timer fires while it is frozen), so the
   * percentile alone would never see it.
   */
  reading(): LagReading {
    const sorted = [...this.samples].sort((a, b) => b - a);
    return { p95Ms: this.p95(), maxMs: sorted[0] ?? 0, secondMs: sorted[1] ?? 0 };
  }
}

export interface LagReading {
  p95Ms: number;
  maxMs: number;
  secondMs: number;
}

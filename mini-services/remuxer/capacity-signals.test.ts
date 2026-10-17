import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  statCpuSeconds,
  committedMemoryBytes,
  findCpuTemperaturePath,
  LoopLag,
  MachineReader,
  parseCpuMax,
  parseCpuStat,
  parseMemoryMax,
  parsePressure,
  readTemperatureC,
} from "./capacity-signals";

const CPU_STAT = `usage_usec 912345678
user_usec 700000000
system_usec 212345678
nr_periods 4242
nr_throttled 17
throttled_usec 5150000
nr_bursts 0
burst_usec 0
`;

const MEMORY_STAT = `anon 2379350016
file 8529117184
kernel 300000000
kernel_stack 6291456
pagetables 25165824
sec_pagetables 0
percpu 1000000
sock 326107136
vmalloc 0
shmem 1048576
file_mapped 1000
inactive_file 8527020032
active_file 3145728
slab_reclaimable 291504128
slab_unreclaimable 10485760
`;

describe("parseCpuStat", () => {
  it("reads the usage and the throttled periods", () => {
    expect(parseCpuStat(CPU_STAT)).toEqual({ usageUsec: 912345678, nrPeriods: 4242, nrThrottled: 17 });
  });

  it("reads a cgroup with no quota, which counts no periods", () => {
    expect(parseCpuStat("usage_usec 10\nuser_usec 5\nsystem_usec 5\n")).toEqual({ usageUsec: 10, nrPeriods: 0, nrThrottled: 0 });
  });

  it("is null for text that is not the file", () => {
    expect(parseCpuStat("")).toBeNull();
    expect(parseCpuStat("some avg10=0.00")).toBeNull();
  });
});

describe("parseCpuMax", () => {
  it("turns a quota into cores", () => {
    expect(parseCpuMax("800000 100000\n", 16)).toBe(8);
    expect(parseCpuMax("150000 100000", 16)).toBe(1.5);
  });

  it("gives every core of the host when there is no quota", () => {
    expect(parseCpuMax("max 100000\n", 16)).toBe(16);
  });

  it("never gives more cores than the host has", () => {
    expect(parseCpuMax("6400000 100000", 16)).toBe(16);
  });

  it("falls back to the host for nonsense", () => {
    expect(parseCpuMax("", 12)).toBe(12);
    expect(parseCpuMax("0 100000", 12)).toBe(12);
  });
});

describe("parsePressure", () => {
  it("reads the ten-second average of some", () => {
    expect(parsePressure("some avg10=13.15 avg60=4.02 avg300=1.00 total=14836\nfull avg10=2.00 avg60=0.10 avg300=0.00 total=99\n")).toEqual({
      someAvg10: 13.15,
    });
  });

  it("is null without a some line", () => {
    expect(parsePressure("")).toBeNull();
  });
});

describe("committedMemoryBytes", () => {
  it("counts process, shared, socket and kernel memory and leaves the page cache out", () => {
    const expected = 2379350016 + 1048576 + 326107136 + 6291456 + 25165824 + 10485760;
    expect(committedMemoryBytes(MEMORY_STAT)).toBe(expected);
    // About 2.6 GB, where memory.current said eleven.
    expect(expected / 1024 ** 3).toBeLessThan(3);
  });

  it("is null without an anon line", () => {
    expect(committedMemoryBytes("file 10\n")).toBeNull();
  });
});

describe("parseMemoryMax", () => {
  it("reads a ceiling", () => {
    expect(parseMemoryMax("16106127360\n", 32 * 1024 ** 3)).toBe(16106127360);
  });

  it("gives the host's memory for no ceiling, or a ceiling above it", () => {
    expect(parseMemoryMax("max\n", 1000)).toBe(1000);
    expect(parseMemoryMax("5000", 1000)).toBe(1000);
  });
});

describe("findCpuTemperaturePath", () => {
  const root = () => mkdtempSync(join(tmpdir(), "hwmon-"));
  const sensor = (dir: string, entry: string, name: string, milli?: number) => {
    mkdirSync(join(dir, entry));
    writeFileSync(join(dir, entry, "name"), `${name}\n`);
    if (milli !== undefined) writeFileSync(join(dir, entry, "temp1_input"), `${milli}\n`);
  };

  it("prefers the CPU's own sensor over the board's", () => {
    const dir = root();
    try {
      sensor(dir, "hwmon1", "acpitz", 40000);
      sensor(dir, "hwmon3", "nvme", 33850);
      sensor(dir, "hwmon4", "k10temp", 40625);
      const path = findCpuTemperaturePath(dir, "");
      expect(path).toBe(join(dir, "hwmon4", "temp1_input"));
      expect(readTemperatureC(path)).toBeCloseTo(40.625, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds an Intel package sensor", () => {
    const dir = root();
    try {
      sensor(dir, "hwmon2", "coretemp", 55000);
      expect(findCpuTemperaturePath(dir, "")).toBe(join(dir, "hwmon2", "temp1_input"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null with no CPU sensor, and takes an override as given", () => {
    const dir = root();
    try {
      sensor(dir, "hwmon0", "acpitz", 40000);
      expect(findCpuTemperaturePath(dir, "")).toBeNull();
      expect(findCpuTemperaturePath(dir, "/somewhere/temp")).toBe("/somewhere/temp");
      expect(findCpuTemperaturePath(join(dir, "missing"), "")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads nothing from a missing or empty file", () => {
    expect(readTemperatureC(null)).toBeNull();
    expect(readTemperatureC("/no/such/file")).toBeNull();
  });
});

describe("MachineReader", () => {
  it("reads a cgroup folder and a sensor", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgroup-"));
    try {
      writeFileSync(join(dir, "cpu.stat"), CPU_STAT);
      writeFileSync(join(dir, "cpu.max"), "800000 100000\n");
      writeFileSync(join(dir, "cpu.pressure"), "some avg10=1.61 avg60=0 avg300=0 total=1\n");
      writeFileSync(join(dir, "memory.stat"), MEMORY_STAT);
      writeFileSync(join(dir, "memory.max"), "16106127360\n");
      writeFileSync(join(dir, "memory.pressure"), "some avg10=0.00 avg60=0 avg300=0 total=0\n");
      writeFileSync(join(dir, "temp"), "57125\n");
      const reading = new MachineReader(dir, join(dir, "temp"), 16).read(1000);
      expect(reading.at).toBe(1000);
      expect(reading.cpuSeconds).toBeCloseTo(912.345678, 6);
      expect(reading.periods).toBe(4242);
      expect(reading.throttledPeriods).toBe(17);
      expect(reading.cpuLimitCores).toBe(8);
      expect(reading.cpuPressure).toBe(1.61);
      expect(reading.memoryLimitBytes).toBe(16106127360);
      expect(reading.memoryPressure).toBe(0);
      expect(reading.temperatureC).toBeCloseTo(57.125, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives nulls rather than throwing where nothing can be read", () => {
    const reading = new MachineReader("/no/such/cgroup", null).read(5);
    expect(reading.cpuSeconds).toBeNull();
    expect(reading.memoryCommittedBytes).toBeNull();
    expect(reading.temperatureC).toBeNull();
    expect(reading.cpuLimitCores).toBeGreaterThan(0);
    expect(reading.memoryLimitBytes).toBeGreaterThan(0);
  });
});

describe("statCpuSeconds", () => {
  it("reads user and system time past a command name with spaces", () => {
    const stat = "4129818 (bun index ts) S 1 2 3 0 -1 4194560 100 0 0 0 14000 625 0 0 20 0 20 0 5 1 2";
    expect(statCpuSeconds(stat)).toBeCloseTo(146.25, 5);
  });

  it("is null for anything else", () => {
    expect(statCpuSeconds("")).toBeNull();
    expect(statCpuSeconds("no brackets here")).toBeNull();
  });
});

describe("LoopLag", () => {
  it("gives the 95th percentile of the last forty samples", () => {
    const lag = new LoopLag();
    expect(lag.p95()).toBe(0);
    for (let i = 0; i < 38; i++) lag.push(2);
    lag.push(900);
    lag.push(1200);
    // Two slow samples in forty: the 95th percentile is the lesser of them.
    expect(lag.p95()).toBe(900);
    // Forty more quiet samples push the spikes out of the window.
    for (let i = 0; i < 40; i++) lag.push(3);
    expect(lag.p95()).toBe(3);
  });
});

import { describe, expect, it } from "bun:test";
import type { MachineReading } from "./capacity-signals";
import { declaredStream, Governor, governorConfigFromEnv, streamClass, streamCost, type GovernorConfig, type StreamDescription } from "./governor";

const GB = 1024 ** 3;
const UHD: StreamDescription = { delivery: "remux", height: 2160, bitrateBps: 0, remote: false };
const HD: StreamDescription = { delivery: "remux", height: 1080, bitrateBps: 0, remote: false };

/** A governor on a made-up clock with a made-up machine: 8 cores, 15 GB, cool and idle unless told otherwise. */
function rig(config: Partial<GovernorConfig> = {}) {
  let clock = 1_000_000;
  let cpuSeconds = 0;
  let periods = 0;
  let throttled = 0;
  // Unless a test is about them, the start rate, the internet link and the remuxer's thread are out of the way.
  // The CPU share is pinned here (the default is calibrated, and moves): the arithmetic in the tests reads 8 x 0.8.
  const governor = new Governor({ startsPerWindow: 1000, maxWarming: 1000, downlinkBps: 0, remuxerCores: 100, cpuShare: 0.8, ...config }, () => clock);
  const machine = { cores: 0.3, throttledShare: 0, memoryBytes: 2 * GB, temperatureC: 50 as number | null, lagMs: 2, downBps: 0 };
  /** `seconds` readings, one a second, of the machine as it stands. */
  const run = (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      clock += 1000;
      cpuSeconds += machine.cores;
      periods += 10;
      throttled += 10 * machine.throttledShare;
      const reading: MachineReading = {
        at: clock,
        cpuSeconds,
        periods,
        throttledPeriods: Math.round(throttled),
        cpuLimitCores: 8,
        cpuPressure: 0,
        memoryCommittedBytes: machine.memoryBytes,
        memoryLimitBytes: 15 * GB,
        memoryPressure: 0,
        temperatureC: machine.temperatureC,
      };
      governor.observe(reading, machine.lagMs, machine.downBps);
    }
  };
  const later = (ms: number) => {
    clock += ms;
  };
  run(2);
  return { governor, machine, run, later };
}

const ask = (governor: Governor, stream = UHD, watcher = "aaaa", priority = 0, ticket?: string) => governor.request({ watcher, priority, stream, ticket });

describe("streamCost", () => {
  it("costs a 4K remux more than a 1080p one, by its bitrate", () => {
    const uhd = streamCost(UHD);
    const hd = streamCost(HD);
    expect(uhd.cpuCores).toBeGreaterThan(hd.cpuCores);
    expect(uhd.downBps).toBeGreaterThan(2 * hd.downBps);
    expect(uhd.memoryBytes).toBe(hd.memoryBytes);
  });

  it("takes the file's own bitrate over the typical one", () => {
    expect(streamCost({ ...UHD, bitrateBps: 15e6 }).downBps).toBeCloseTo(15e6 * 1.2, 0);
  });

  it("costs nothing of the machine for a stream the viewer reads from its CDN", () => {
    const home = streamCost({ delivery: "direct", height: 2160, bitrateBps: 40e6, remote: false });
    expect(home.cpuCores).toBe(0);
    expect(home.memoryBytes).toBe(0);
    // A viewer at home still shares the internet link with everyone else's streams.
    expect(home.downBps).toBeGreaterThan(0);
    expect(streamCost({ delivery: "direct", height: 2160, bitrateBps: 40e6, remote: true }).downBps).toBe(0);
  });

  it("puts a viewer outside the home on the upload link", () => {
    expect(streamCost(UHD).upBps).toBe(0);
    expect(streamCost({ ...UHD, remote: true }).upBps).toBeGreaterThan(0);
  });

  it("names the class of a picture from its nominal height", () => {
    expect(streamClass(2160)).toBe("4k");
    expect(streamClass(1080)).toBe("1080p");
    expect(streamClass(720)).toBe("720p");
    expect(streamClass(480)).toBe("sd");
  });
});

describe("Governor admission", () => {
  it("lets streams in while they fit, then queues by the budget that ran out", () => {
    const { governor } = rig();
    // 8 cores x 0.8 = 6.4 planned; the idle site takes 0.3 and a typical 4K remux 0.4: fifteen fit.
    for (let i = 0; i < 15; i++) expect(ask(governor, UHD, `v${i}`).status).toBe("admitted");
    const answer = ask(governor, UHD, "late");
    expect(answer).toMatchObject({ status: "queued", position: 1, waiting: 1, reason: "cpu" });
  });

  it("fits more 1080p streams than 4K ones", () => {
    const count = (stream: StreamDescription) => {
      const { governor } = rig();
      let n = 0;
      while (ask(governor, stream, `v${n}`).status === "admitted") n++;
      return n;
    };
    expect(count(HD)).toBeGreaterThan(count(UHD));
  });

  it("is limited by the internet link when one is set", () => {
    // 450 Mbit/s of link, a typical 4K remux at 50 Mbit/s with 20% headroom: seven fit.
    const { governor } = rig({ downlinkBps: 450e6 });
    for (let i = 0; i < 7; i++) expect(ask(governor, UHD, `v${i}`).status).toBe("admitted");
    expect(ask(governor, UHD, "eighth")).toMatchObject({ status: "queued", reason: "network" });
  });

  it("serves the line in order as seats free, keeping each person's place", () => {
    const { governor } = rig();
    const seats: string[] = [];
    for (let i = 0; i < 15; i++) seats.push((ask(governor, UHD, `v${i}`) as { seat: string }).seat);
    const first = ask(governor, UHD, "first");
    const second = ask(governor, HD, "second");
    expect(first).toMatchObject({ status: "queued", position: 1 });
    expect(second).toMatchObject({ status: "queued", position: 2, waiting: 2 });
    governor.release(seats[0]!, "v0");
    // The smaller stream behind does not jump the line, even though it alone would fit.
    expect(ask(governor, HD, "second", 0, (second as { ticket: string }).ticket)).toMatchObject({ status: "queued", position: 2 });
    expect(ask(governor, UHD, "first", 0, (first as { ticket: string }).ticket).status).toBe("admitted");
    governor.release(seats[1]!, "v1");
    expect(ask(governor, HD, "second", 0, (second as { ticket: string }).ticket).status).toBe("admitted");
  });

  it("says who joined the line and how long they waited", () => {
    const { governor, later } = rig();
    const seats: string[] = [];
    for (let i = 0; i < 15; i++) seats.push((ask(governor, UHD, `v${i}`) as { seat: string }).seat);
    const joined = ask(governor, UHD, "w") as { joined: boolean; ticket: string };
    expect(joined.joined).toBe(true);
    later(5000);
    expect(ask(governor, UHD, "w", 0, joined.ticket)).toMatchObject({ status: "queued", joined: false });
    governor.release(seats[0]!, "v0");
    later(2000);
    expect(ask(governor, UHD, "w", 0, joined.ticket)).toMatchObject({ status: "admitted", waitedMs: 7000 });
    expect(ask(governor, HD, "x")).toMatchObject({ status: "queued" });
  });

  it("tells an active seat from a stopped one and one it does not know", () => {
    const { governor, machine, run } = rig();
    const seat = (ask(governor, UHD, "me") as { seat: string }).seat;
    expect(governor.seatState(seat, "me")).toEqual({ state: "active" });
    expect(governor.seatState(seat, "someone-else")).toEqual({ state: "unknown" });
    machine.memoryBytes = 14.5 * GB;
    run(2);
    governor.housekeeping();
    expect(governor.seatState(seat, "me")).toEqual({ state: "evicted", reason: "memory" });
  });

  it("gives a playing stream its lapsed seat back without the line", () => {
    const { governor } = rig();
    for (let i = 0; i < 15; i++) ask(governor, UHD, `v${i}`);
    ask(governor, UHD, "waiting");
    expect(governor.request({ watcher: "playing", priority: 0, stream: UHD, resume: true }).status).toBe("admitted");
  });

  it("puts the owner's profiles at the front of the line", () => {
    const { governor } = rig();
    const seats: string[] = [];
    for (let i = 0; i < 15; i++) seats.push((ask(governor, UHD, `v${i}`) as { seat: string }).seat);
    const guest = ask(governor, UHD, "guest") as { ticket: string };
    const owner = ask(governor, UHD, "owner", 1) as { ticket: string; position: number };
    expect(owner.position).toBe(1);
    governor.release(seats[0]!, "v0");
    expect(ask(governor, UHD, "guest", 0, guest.ticket)).toMatchObject({ status: "queued", position: 2 });
    expect(ask(governor, UHD, "owner", 1, owner.ticket).status).toBe("admitted");
  });

  it("does not let a ticket be used by someone else", () => {
    const { governor } = rig();
    for (let i = 0; i < 15; i++) ask(governor, UHD, `v${i}`);
    const mine = ask(governor, UHD, "me") as { ticket: string };
    expect(ask(governor, UHD, "thief", 0, mine.ticket)).toMatchObject({ status: "queued", position: 2 });
  });

  it("spaces out starts, but never the owner's", () => {
    const { governor, later } = rig({ startsPerWindow: 4 });
    for (let i = 0; i < 4; i++) expect(ask(governor, HD, `v${i}`).status).toBe("admitted");
    const waiting = ask(governor, HD, "fifth") as { ticket: string; reason: string };
    expect(waiting.reason).toBe("starts");
    expect(ask(governor, HD, "owner", 1).status).toBe("admitted");
    later(10_000);
    expect(ask(governor, HD, "fifth", 0, waiting.ticket).status).toBe("admitted");
  });

  it("asks people to come back later once the line is full", () => {
    const { governor } = rig({ queueMax: 2 });
    for (let i = 0; i < 15; i++) ask(governor, UHD, `v${i}`);
    expect(ask(governor, UHD, "a").status).toBe("queued");
    expect(ask(governor, UHD, "b").status).toBe("queued");
    expect(ask(governor, UHD, "c")).toMatchObject({ status: "full", retryAfterS: 60 });
  });

  it("gives up a place nobody asks about, so the line moves on", () => {
    const { governor, later } = rig();
    const seats: string[] = [];
    for (let i = 0; i < 15; i++) seats.push((ask(governor, UHD, `v${i}`) as { seat: string }).seat);
    ask(governor, UHD, "gone");
    const stays = ask(governor, UHD, "stays") as { ticket: string };
    later(15_000);
    expect(ask(governor, UHD, "stays", 0, stays.ticket)).toMatchObject({ position: 2 });
    later(15_000);
    governor.release(seats[0]!, "v0");
    // "gone" stopped asking 30 s ago: their place is given up and "stays" is next.
    expect(ask(governor, UHD, "stays", 0, stays.ticket).status).toBe("admitted");
  });

  it("gives up a seat nobody renews, while a stream's own requests keep it", () => {
    const { governor, later } = rig();
    const kept = ask(governor, UHD, "kept") as { seat: string };
    const left = ask(governor, UHD, "left") as { seat: string };
    expect(governor.attach(kept.seat, "kept", "session-1")).toBe(true);
    for (let i = 0; i < 4; i++) {
      later(30_000);
      governor.touch("session-1", "kept");
    }
    expect(governor.renew(kept.seat, "kept")).toMatchObject({ status: "active" });
    expect(governor.renew(left.seat, "left")).toEqual({ status: "unknown" });
  });

  it("offers a lighter stream to someone waiting for 4K when 1080p would fit", () => {
    const { governor } = rig();
    // 0.3 + 14 x 0.4 + 0.22 = 6.12 of 6.4 planned cores: another 4K remux (0.4) does not fit, a 1080p one (0.22) does.
    for (let i = 0; i < 14; i++) ask(governor, UHD, `v${i}`);
    ask(governor, HD, "hd");
    expect(ask(governor, UHD, "uhd")).toMatchObject({ status: "queued", reason: "cpu", lighterFits: true });
  });

  it("does not offer a lighter stream that would have to wait too", () => {
    // One remux seat: a 1080p remux waits exactly like the 4K one, so it is not offered.
    const { governor } = rig({ maxRemuxSeats: 1 });
    ask(governor, UHD, "a");
    expect(ask(governor, UHD, "b")).toMatchObject({ status: "queued", reason: "seats", lighterFits: false });
  });

  it("refines a seat's cost with the file's own bitrate once it is open", () => {
    const { governor } = rig();
    const seats: string[] = [];
    for (let i = 0; i < 15; i++) seats.push((ask(governor, UHD, `v${i}`) as { seat: string }).seat);
    const late = ask(governor, UHD, "late") as { status: string; ticket: string };
    expect(late.status).toBe("queued");
    // Each turns out to be a 15 Mbit/s file: 0.19 cores, not the 0.4 assumed for a 4K remux.
    seats.forEach((seat, i) => governor.attach(seat, `v${i}`, `s${i}`, 15e6));
    expect(ask(governor, UHD, "late", 0, late.ticket).status).toBe("admitted");
  });

  it("admits a stream opened without asking only when it fits and nobody waits", () => {
    const { governor } = rig();
    expect(governor.admitUnasked("old-page", UHD)).toHaveProperty("seat");
    for (let i = 0; i < 14; i++) ask(governor, UHD, `v${i}`);
    expect(governor.admitUnasked("old-page-2", UHD)).toEqual({ refused: "cpu" });
  });

  it("lets everyone in when switched off", () => {
    const { governor, machine, run } = rig({ enabled: false });
    machine.temperatureC = 99;
    run(10);
    for (let i = 0; i < 40; i++) expect(ask(governor, UHD, `v${i}`).status).toBe("admitted");
    expect(governor.housekeeping()).toEqual([]);
  });
});

describe("Governor levels", () => {
  it("stops letting people in while the CPU is hot, and holds it until it has cooled", () => {
    const { governor, machine, run } = rig();
    machine.temperatureC = 86;
    run(5);
    expect(governor.currentLevel).toBe("busy");
    expect(ask(governor, HD, "v")).toMatchObject({ status: "queued", reason: "temperature" });
    // Below the entry line, but not below the line to leave by.
    machine.temperatureC = 82;
    run(60);
    expect(governor.currentLevel).toBe("busy");
    machine.temperatureC = 75;
    run(10);
    expect(governor.currentLevel).toBe("busy");
    run(25);
    expect(governor.currentLevel).toBe("ok");
  });

  it("is not moved by one hot second", () => {
    const { governor, machine, run } = rig();
    machine.temperatureC = 99;
    run(1);
    machine.temperatureC = 60;
    run(1);
    expect(governor.currentLevel).toBe("ok");
  });

  it("calls the CPU busy when the container's quota keeps running out", () => {
    const { governor, machine, run } = rig();
    machine.cores = 7.9;
    machine.throttledShare = 0.4;
    run(10);
    expect(governor.currentLevel).toBe("busy");
    expect(governor.snapshot().reasons).toContain("cpu");
  });

  it("calls the CPU busy when the event loop runs late", () => {
    const { governor, machine, run } = rig();
    machine.lagMs = 1200;
    run(2);
    expect(governor.snapshot()).toMatchObject({ level: "busy", reasons: ["cpu"] });
  });

  it("listens to the viewers' stalls only when enough of them are playing", () => {
    const { governor, run } = rig();
    const seats = ["a", "b", "c"].map((w) => [w, (ask(governor, HD, w) as { seat: string }).seat] as const);
    for (const [w, seat] of seats) governor.renew(seat, w, { playing: true, stalls: 1 });
    run(2);
    expect(governor.currentLevel).toBe("ok");
    const fourth = (ask(governor, HD, "d") as { seat: string }).seat;
    governor.renew(fourth, "d", { playing: true, stalls: 0 });
    run(2);
    expect(governor.snapshot()).toMatchObject({ level: "busy", reasons: ["playback"] });
  });

  it("refuses a prewarm unless there is room to spare", () => {
    const { governor, machine, run } = rig();
    expect(governor.prewarmAllowed()).toBe(true);
    machine.temperatureC = 86;
    run(5);
    expect(governor.prewarmAllowed()).toBe(false);
  });
});

describe("Governor evictions", () => {
  it("stops the newest, heaviest stream when the CPU is critically hot, one at a time", () => {
    const { governor, machine, run, later } = rig();
    const old = ask(governor, UHD, "old") as { seat: string };
    later(1000);
    const small = ask(governor, HD, "small") as { seat: string };
    later(1000);
    const heavyNew = ask(governor, UHD, "new") as { seat: string };
    governor.attach(heavyNew.seat, "new", "session-new");
    machine.temperatureC = 95;
    run(5);
    expect(governor.currentLevel).toBe("critical");
    const first = governor.housekeeping();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ seat: heavyNew.seat, watcher: "new", sessionId: "session-new", reason: "temperature" });
    expect(governor.renew(heavyNew.seat, "new")).toEqual({ status: "evicted", reason: "temperature" });
    expect(governor.evictedFrom("session-new", "new")).toBe("temperature");
    // Heat falls slowly: the next stop waits twenty seconds.
    run(10);
    expect(governor.housekeeping()).toEqual([]);
    run(10);
    expect(governor.housekeeping()[0]?.seat).toBe(old.seat);
    expect(governor.renew(small.seat, "small")).toMatchObject({ status: "active" });
  });

  it("stops the owner's stream last", () => {
    const { governor, machine, run } = rig();
    const owner = ask(governor, UHD, "owner", 1) as { seat: string };
    const guest = ask(governor, HD, "guest") as { seat: string };
    machine.memoryBytes = 14.5 * GB;
    run(2);
    expect(governor.currentLevel).toBe("critical");
    expect(governor.housekeeping()[0]?.seat).toBe(guest.seat);
    run(8);
    // With only the owner left, the machine still comes first.
    expect(governor.housekeeping()[0]?.seat).toBe(owner.seat);
  });

  it("goes back to busy, then to ok, once the danger has passed for long enough", () => {
    const { governor, machine, run } = rig();
    machine.temperatureC = 95;
    run(5);
    expect(governor.currentLevel).toBe("critical");
    machine.temperatureC = 86;
    run(20);
    expect(governor.currentLevel).toBe("busy");
    machine.temperatureC = 70;
    run(25);
    expect(governor.currentLevel).toBe("ok");
  });

  it("frees an evicted seat's share at once, so the line can move", () => {
    const { governor, machine, run } = rig();
    for (let i = 0; i < 15; i++) ask(governor, UHD, `v${i}`);
    machine.memoryBytes = 14.5 * GB;
    run(2);
    expect(governor.housekeeping()).toHaveLength(1);
    expect(governor.snapshot().seats).toBe(14);
  });
});

describe("governorConfigFromEnv", () => {
  it("keeps every default when nothing is set, and keeps remux seats within the remuxer's runs", () => {
    // VOD_MAX_RUNS defaults to 4, and a quarter of the runs is kept for seeks.
    expect(governorConfigFromEnv({})).toEqual({ enabled: true, maxRemuxSeats: 3 });
    expect(governorConfigFromEnv({ VOD_MAX_RUNS: "64" }).maxRemuxSeats).toBe(48);
    expect(governorConfigFromEnv({ VOD_MAX_RUNS: "1" }).maxRemuxSeats).toBe(1);
  });

  it("reads the settings, in their units", () => {
    const config = governorConfigFromEnv({
      CAPACITY_GATE: "1",
      CAPACITY_CPU_SHARE: "0.7",
      CAPACITY_DOWNLINK_MBPS: "400",
      CAPACITY_UPLINK_MBPS: "40",
      CAPACITY_QUEUE_MAX: "10",
      CAPACITY_BUSY_TEMP_C: "83",
      CAPACITY_CRITICAL_TEMP_C: "90",
    });
    expect(config).toMatchObject({ enabled: true, cpuShare: 0.7, downlinkBps: 400e6, uplinkBps: 40e6, queueMax: 10 });
    expect(config.thresholds?.busyTempC).toEqual({ enter: 83, leave: 78 });
    expect(config.thresholds?.criticalTempC).toEqual({ enter: 90, leave: 86 });
  });

  it("switches off, and ignores what it cannot read", () => {
    expect(governorConfigFromEnv({ CAPACITY_GATE: "0", CAPACITY_CPU_SHARE: "lots", CAPACITY_MEMORY_SHARE: "5" })).toEqual({ enabled: false, maxRemuxSeats: 3 });
  });
});

describe("Governor, after review", () => {
  it("keeps remux streams within the remuxer's runs, but not web streams", () => {
    const { governor } = rig({ maxRemuxSeats: 2 });
    expect(ask(governor, HD, "a").status).toBe("admitted");
    expect(ask(governor, HD, "b").status).toBe("admitted");
    expect(ask(governor, HD, "c")).toMatchObject({ status: "queued", reason: "seats" });
    const other = rig({ maxRemuxSeats: 2 });
    ask(other.governor, HD, "a");
    ask(other.governor, HD, "b");
    expect(ask(other.governor, { delivery: "web", height: 1080, bitrateBps: 0, remote: false }, "web").status).toBe("admitted");
    expect(other.governor.prewarmAllowed()).toBe(false);
  });

  it("does not take a page's word for a bitrate far below its picture's", () => {
    expect(declaredStream({ ...UHD, bitrateBps: 1e6 }).bitrateBps).toBe(20e6);
    expect(declaredStream({ ...UHD, bitrateBps: 30e6 }).bitrateBps).toBe(30e6);
    expect(declaredStream({ ...UHD, bitrateBps: 0 }).bitrateBps).toBe(0);
    const { governor } = rig();
    // Forty "1 Mbit/s 4K" streams would fit on paper; planned at 20 Mbit/s each, memory takes 26 (450 MB each).
    let n = 0;
    while (ask(governor, { ...UHD, bitrateBps: 1e6 }, `v${n}`).status === "admitted") n++;
    expect(n).toBe(26);
  });

  it("counts a stream whose sound is re-encoded as heavier, once the file says so", () => {
    expect(streamCost({ ...HD, audioTranscode: true }).cpuCores).toBeCloseTo(streamCost(HD).cpuCores + 0.1, 5);
    const { governor } = rig();
    const seat = (ask(governor, HD, "v") as { seat: string }).seat;
    const before = governor.seatsDetail()[0]!.cpuCores;
    // The file turns out to be 6.4 Mbit/s with TrueHD the viewer's browser cannot play: re-encoded.
    governor.attach(seat, "v", "s", 6.4e6, true);
    const after = governor.seatsDetail()[0]!.cpuCores;
    expect(after).toBeCloseTo(0.1 + 0.006 * 6.4 + 0.1, 5);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("re-prices a seat whose viewer moved to another kind of stream", () => {
    const { governor } = rig();
    const seats: string[] = [];
    for (let i = 0; i < 15; i++) seats.push((ask(governor, { ...HD, delivery: "web" }, `v${i}`) as { seat: string }).seat);
    // Fifteen web streams leave plenty of room.
    expect(ask(governor, UHD, "probe").status).toBe("admitted");
    // Then each moves to a 4K remux: the seats now cost that.
    seats.forEach((seat, i) => governor.renew(seat, `v${i}`, { playing: true, stream: UHD }));
    expect(ask(governor, UHD, "late")).toMatchObject({ status: "queued", reason: "cpu" });
  });

  it("counts a seat paused for a while at a fraction of its cost", () => {
    const { governor, later } = rig();
    const seats: string[] = [];
    for (let i = 0; i < 15; i++) seats.push((ask(governor, UHD, `v${i}`) as { seat: string }).seat);
    const waiting = ask(governor, UHD, "late") as { ticket: string };
    seats.slice(0, 5).forEach((seat, i) => governor.renew(seat, `v${i}`, { playing: false }));
    expect(ask(governor, UHD, "late", 0, waiting.ticket).status).toBe("queued");
    later(121_000);
    // Everyone else keeps their seat by renewing.
    seats.slice(5).forEach((seat, i) => governor.renew(seat, `v${i + 5}`, { playing: true }));
    seats.slice(0, 5).forEach((seat, i) => governor.renew(seat, `v${i}`, { playing: false }));
    expect(ask(governor, UHD, "late", 0, waiting.ticket).status).toBe("admitted");
  });

  it("stops a stream that is playing before one that rests", () => {
    const { governor, machine, run, later } = rig();
    const resting = ask(governor, UHD, "resting") as { seat: string };
    later(1000);
    const playing = ask(governor, HD, "playing") as { seat: string };
    governor.attach(playing.seat, "playing", "s-playing");
    governor.renew(resting.seat, "resting", { playing: false });
    later(40_000);
    governor.renew(resting.seat, "resting", { playing: false });
    governor.touch("s-playing", "playing");
    machine.memoryBytes = 14.5 * GB;
    run(2);
    // The resting 4K stream is heavier and newer-or-older matters not: the playing one is what loads the machine.
    expect(governor.housekeeping()[0]?.seat).toBe(playing.seat);
  });

  it("turns away a stream that could never fit, instead of letting it block the queue", () => {
    const { governor } = rig({ downlinkBps: 50e6 });
    // A typical 4K remux needs 60 Mbit/s of link: more than all 50.
    expect(ask(governor, UHD, "big")).toMatchObject({ status: "full", reason: "network" });
    expect(governor.snapshot().queue).toBe(0);
    expect(ask(governor, { ...HD, delivery: "web" }, "small").status).toBe("admitted");
  });

  it("lets the owner join a full queue, at the front", () => {
    const { governor } = rig({ queueMax: 1 });
    for (let i = 0; i < 15; i++) ask(governor, UHD, `v${i}`);
    expect(ask(governor, UHD, "guest").status).toBe("queued");
    expect(ask(governor, UHD, "guest2").status).toBe("full");
    expect(ask(governor, UHD, "owner", 1)).toMatchObject({ status: "queued", position: 1 });
  });

  it("keeps the site's idle share fair on a small machine", () => {
    let clock = 0;
    const governor = new Governor({ startsPerWindow: 1000, maxWarming: 1000, downlinkBps: 0, remuxerCores: 100, cpuShare: 0.8 }, () => clock);
    const small = (at: number): MachineReading => ({
      at,
      cpuSeconds: 0,
      periods: 0,
      throttledPeriods: 0,
      cpuLimitCores: 2,
      cpuPressure: 0,
      memoryCommittedBytes: 0.3 * GB,
      memoryLimitBytes: 1.5 * GB,
      memoryPressure: 0,
      temperatureC: 50,
    });
    governor.observe(small((clock += 1000)), 1, 0);
    governor.observe(small((clock += 1000)), 1, 0);
    // 1.5 GB x 0.85 = 1.27 GB: with a fixed 1.2 GB idle share nobody would fit; with 35% of it, a 1080p remux does.
    expect(governor.request({ watcher: "a", priority: 0, stream: HD }).status).toBe("admitted");
    expect(governor.request({ watcher: "b", priority: 0, stream: HD })).toMatchObject({ status: "queued", reason: "memory" });
  });

  it("sees one long freeze of the remuxer, which the percentile alone would miss", () => {
    const { governor, machine, run } = rig();
    const once = (lag: { p95Ms: number; maxMs: number; secondMs: number }) => {
      governor.observe(
        { at: Date.now(), cpuSeconds: null, periods: null, throttledPeriods: null, cpuLimitCores: 8, cpuPressure: 0, memoryCommittedBytes: machine.memoryBytes, memoryLimitBytes: 15 * GB, memoryPressure: 0, temperatureC: 50 },
        lag,
        0
      );
    };
    once({ p95Ms: 3, maxMs: 2500, secondMs: 3 });
    // A couple of seconds' pause is nothing to a player with 30 s in hand.
    expect(governor.currentLevel).toBe("ok");
    once({ p95Ms: 3, maxMs: 3500, secondMs: 3 });
    expect(governor.snapshot()).toMatchObject({ level: "busy", reasons: ["cpu"] });
    once({ p95Ms: 3, maxMs: 9000, secondMs: 3 });
    expect(governor.currentLevel).toBe("critical");
    run(0);
  });
});

describe("Governor, the remuxer's thread", () => {
  it("keeps remuxed streams within what the remuxer's one thread can move", () => {
    // 0.003 core per Mbit/s: a typical 4K remux (50 Mbit/s) takes 0.15 of the 0.9 planned, so six fit.
    const { governor } = rig({ remuxerCores: 0.9 });
    for (let i = 0; i < 6; i++) expect(ask(governor, UHD, `v${i}`).status).toBe("admitted");
    expect(ask(governor, UHD, "seventh")).toMatchObject({ status: "queued", reason: "cpu" });
    // Web streams go through the web app, not the remuxer.
    const web = rig({ remuxerCores: 0.9 });
    for (let i = 0; i < 6; i++) ask(web.governor, UHD, `v${i}`);
    expect(ask(web.governor, { ...UHD, delivery: "web" }, "web").status).toBe("admitted");
  });

  it("calls the CPU busy when the remuxer's thread is nearly full, whatever the container's cores say", () => {
    let clock = 0;
    let own = 0;
    const governor = new Governor({ startsPerWindow: 1000, maxWarming: 1000, downlinkBps: 0 }, () => clock);
    for (let i = 0; i < 120; i++) {
      clock += 1000;
      own += 1;
      governor.observe(
        { at: clock, cpuSeconds: clock / 250, periods: null, throttledPeriods: null, cpuLimitCores: 8, cpuPressure: 0, memoryCommittedBytes: 2 * GB, memoryLimitBytes: 15 * GB, memoryPressure: 0, temperatureC: 50, processCpuSeconds: own },
        2,
        0
      );
    }
    expect(governor.snapshot()).toMatchObject({ level: "busy", reasons: ["cpu"] });
    expect(governor.snapshot().measured.remuxerCores).toBeGreaterThan(0.97);
  });
});

describe("Governor, warm-up slots", () => {
  it("lets no more than two streams warm up at once, and the owner past them", () => {
    const { governor, later } = rig({ maxWarming: 2 });
    expect(ask(governor, HD, "a").status).toBe("admitted");
    expect(ask(governor, HD, "b").status).toBe("admitted");
    // Two just let in count as warming even before the remuxer has seen them.
    const third = ask(governor, HD, "c") as { status: string; reason: string; ticket: string };
    expect(third).toMatchObject({ status: "queued", reason: "starts" });
    expect(ask(governor, HD, "owner", 1).status).toBe("admitted");
    // Past the grace, the remuxer's own count decides: one still warming leaves one slot.
    later(16_000);
    governor.setWarming(1);
    expect(ask(governor, HD, "c", 0, third.ticket).status).toBe("admitted");
    governor.setWarming(2);
    later(16_000);
    const d = ask(governor, HD, "d") as { status: string; reason: string; ticket: string };
    expect(d).toMatchObject({ status: "queued", reason: "starts" });
    // A slot frees: "d" goes first, and a web stream (which does not warm up here) follows at once.
    governor.setWarming(1);
    expect(ask(governor, HD, "d", 0, d.ticket).status).toBe("admitted");
    governor.setWarming(2);
    expect(ask(governor, { ...HD, delivery: "web" }, "web").status).toBe("admitted");
  });
});

import { describe, expect, it } from "bun:test";
import { CapacityError, capacityRefusal, SeatKeeper, seatStreamFor, type CapacityState } from "./capacity";

const UHD = { delivery: "remux" as const, height: 2160, bitrateBps: 0 };

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** A server that answers each POST from a script, and records what it was sent. */
function server(script: Array<unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const call = { url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    const next = script.length > 1 ? script.shift() : script[0];
    const answer = typeof next === "function" ? (next as (c: Call) => unknown)(call) : next;
    if (answer instanceof Error) throw answer;
    if (answer === null) return new Response("nope", { status: 502 });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetch };
}

function keeper(script: Array<unknown | ((call: Call) => unknown)>) {
  const srv = server(script);
  const k = new SeatKeeper({ fetch: srv.fetch, pollMs: 5, renewMs: 60_000, handoverMs: 20 });
  const states: CapacityState[] = [];
  const evictions: string[] = [];
  k.hold((state) => states.push(state), (reason) => evictions.push(reason));
  return { k, srv, states, evictions };
}

const admitted = { status: "admitted", seat: "a".repeat(24), level: "ok", waitedMs: 0 };
const queued = (position: number) => ({ status: "queued", ticket: "t".repeat(24), joined: position === 2, position, waiting: 2, reason: "cpu", level: "ok", lighterFits: false });

describe("SeatKeeper.acquire", () => {
  it("takes a seat at once when there is room, and keeps it", async () => {
    const { k, srv, states } = keeper([admitted]);
    expect(await k.acquire(UHD, new AbortController().signal)).toBe("a".repeat(24));
    expect(srv.calls[0]).toMatchObject({ url: "/api/capacity/seat", body: { delivery: "remux", height: 2160, resume: false } });
    expect(states.at(-1)).toEqual({ kind: "none" });
    // Held: the next source asks nothing.
    expect(await k.acquire(UHD, new AbortController().signal)).toBe("a".repeat(24));
    expect(srv.calls).toHaveLength(1);
    k.release();
  });

  it("waits in line, showing the place, then takes the seat", async () => {
    const { k, srv, states } = keeper([queued(2), queued(1), admitted]);
    expect(await k.acquire(UHD, new AbortController().signal)).toBe("a".repeat(24));
    expect(states.filter((s) => s.kind === "queued").map((s) => (s as { position: number }).position)).toEqual([2, 1]);
    // Every ask after the first names the place in line.
    expect(srv.calls[1]!.body.ticket).toBe("t".repeat(24));
    expect(srv.calls[2]!.body.ticket).toBe("t".repeat(24));
    k.release();
  });

  it("keeps the place in line when a wait is called off, for the next ask", async () => {
    const { k, srv } = keeper([queued(2)]);
    const abort = new AbortController();
    const waiting = k.acquire(UHD, abort.signal);
    await new Promise((r) => setTimeout(r, 12));
    abort.abort();
    await expect(waiting).rejects.toThrow("aborted");
    const again = k.acquire({ ...UHD, height: 1080 }, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 2));
    const last = srv.calls.at(-1)!;
    expect(last.body).toMatchObject({ ticket: "t".repeat(24), height: 1080 });
    k.release();
    void again.catch(() => undefined);
  });

  it("says the line is full, and does not wait", async () => {
    const { k, states } = keeper([{ status: "full", retryAfterS: 60, reason: "seats", level: "busy" }]);
    await expect(k.acquire(UHD, new AbortController().signal)).rejects.toBeInstanceOf(CapacityError);
    expect(states.at(-1)).toEqual({ kind: "full", reason: "seats", retryAfterS: 60 });
  });

  it("plays when nobody answers (no governor, or a restart)", async () => {
    const { k } = keeper([new Error("network down")]);
    expect(await k.acquire(UHD, new AbortController().signal)).toBeNull();
    const failing = keeper([null]);
    expect(await failing.k.acquire(UHD, new AbortController().signal)).toBeNull();
  });
});

describe("SeatKeeper.renew", () => {
  it("reports stalls and playing, then starts counting again", async () => {
    const { k, srv } = keeper([admitted, { status: "active", level: "ok" }]);
    await k.acquire(UHD, new AbortController().signal);
    k.noteStall();
    k.noteStall();
    k.setPlaying(true);
    expect(await k.renew()).toBe(false);
    expect(srv.calls[1]).toMatchObject({ url: `/api/capacity/seat/${"a".repeat(24)}/renew`, body: { stalls: 2, playing: true } });
    await k.renew();
    expect(srv.calls[2]!.body.stalls).toBe(0);
    k.release();
  });

  it("hears that the stream was stopped, and says why", async () => {
    const { k, states, evictions } = keeper([admitted, { status: "evicted", reason: "temperature" }]);
    await k.acquire(UHD, new AbortController().signal);
    expect(await k.renew()).toBe(true);
    expect(k.evicted).toBe(true);
    expect(k.current).toBeNull();
    expect(evictions).toEqual(["temperature"]);
    expect(states.at(-1)).toEqual({ kind: "evicted", reason: "temperature" });
    k.clearEviction();
    expect(k.evicted).toBe(false);
  });

  it("takes a forgotten seat back quietly, as a stream already playing", async () => {
    const { k, srv, states } = keeper([admitted, { status: "unknown" }, admitted]);
    await k.acquire(UHD, new AbortController().signal);
    const shown = states.length;
    expect(await k.renew()).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(srv.calls[2]!.body.resume).toBe(true);
    expect(states.length).toBe(shown);
    expect(k.current).toBe("a".repeat(24));
    k.release();
  });

  it("keeps playing when a renewal goes unanswered", async () => {
    const { k } = keeper([admitted, null]);
    await k.acquire(UHD, new AbortController().signal);
    expect(await k.renew()).toBe(false);
    expect(k.current).toBe("a".repeat(24));
    k.release();
  });
});

describe("SeatKeeper.release", () => {
  it("gives the seat back", async () => {
    const { k, srv } = keeper([admitted, {}]);
    await k.acquire(UHD, new AbortController().signal);
    k.release();
    await new Promise((r) => setTimeout(r, 2));
    expect(srv.calls.at(-1)!.url).toBe(`/api/capacity/seat/${"a".repeat(24)}/release`);
    expect(k.current).toBeNull();
  });

  it("gives back a place in line too", async () => {
    const { k, srv } = keeper([queued(3)]);
    const abort = new AbortController();
    const waiting = k.acquire(UHD, abort.signal);
    await new Promise((r) => setTimeout(r, 2));
    abort.abort();
    await waiting.catch(() => undefined);
    k.release();
    await new Promise((r) => setTimeout(r, 2));
    expect(srv.calls.at(-1)!.url).toBe(`/api/capacity/seat/${"t".repeat(24)}/release`);
  });

  it("keeps the seat for the next player a while, then gives it back", async () => {
    const { k, srv } = keeper([admitted, {}]);
    await k.acquire(UHD, new AbortController().signal);
    k.letGo();
    // The next episode takes it over in time: nothing is given back.
    k.hold(() => undefined, () => undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(srv.calls.some((c) => c.url.endsWith("/release"))).toBe(false);
    k.letGo();
    await new Promise((r) => setTimeout(r, 30));
    expect(srv.calls.at(-1)!.url.endsWith("/release")).toBe(true);
  });
});

describe("capacityRefusal", () => {
  it("reads a capacity 503", () => {
    const refusal = capacityRefusal(503, { capacity: "evicted", reason: "memory" });
    expect(refusal).toBeInstanceOf(CapacityError);
    expect(refusal).toMatchObject({ capacity: "evicted", reason: "memory" });
    expect(capacityRefusal(503, { capacity: "full" })).toMatchObject({ capacity: "full", reason: "seats" });
  });

  it("is null for any other failure", () => {
    expect(capacityRefusal(503, { error: "Remuxing is disabled on this server" })).toBeNull();
    expect(capacityRefusal(502, { capacity: "full" })).toBeNull();
  });
});

describe("seatStreamFor", () => {
  it("takes the bitrate from the size and the length", () => {
    // 60 GB over 3 h is about 44 Mbit/s.
    const stream = seatStreamFor({ delivery: "remux", height: 2160, sizeBytes: 60e9, durationS: 3 * 3600 });
    expect(stream.bitrateBps).toBeCloseTo(44.4e6, -5);
    expect(stream).toMatchObject({ delivery: "remux", height: 2160 });
  });

  it("leaves the bitrate unknown without both", () => {
    expect(seatStreamFor({ delivery: "web", height: 1080 }).bitrateBps).toBe(0);
    expect(seatStreamFor({ delivery: "web", height: 1080, sizeBytes: 5e9, durationS: 10 }).bitrateBps).toBe(0);
  });
});

describe("SeatKeeper, after review", () => {
  it("stops a quiet take-back when the seat is given back, so no seat is renewed for a closed page", async () => {
    const { k, srv } = keeper([admitted, { status: "unknown" }, queued(2)]);
    await k.acquire(UHD, new AbortController().signal);
    await k.renew();
    await new Promise((r) => setTimeout(r, 12));
    const asksBefore = srv.calls.filter((c) => c.url === "/api/capacity/seat").length;
    k.release();
    await new Promise((r) => setTimeout(r, 30));
    expect(srv.calls.filter((c) => c.url === "/api/capacity/seat").length).toBeLessThanOrEqual(asksBefore + 1);
    expect(k.current).toBeNull();
  });

  it("gives back a second seat when two asks were both answered", async () => {
    let n = 0;
    // Every ask is answered with a new seat (the releases get one too, which they ignore).
    const { k, srv } = keeper([() => ({ ...admitted, seat: String(++n).repeat(24) })]);
    const [first, second] = await Promise.all([k.acquire(UHD, new AbortController().signal), k.acquire(UHD, new AbortController().signal)]);
    expect(first).toBe(second);
    await new Promise((r) => setTimeout(r, 2));
    expect(srv.calls.some((c) => c.url.endsWith("/release"))).toBe(true);
    k.release();
  });

  it("tells the server when the seat's stream changes kind", async () => {
    const { k, srv } = keeper([admitted, { status: "active", level: "ok" }]);
    await k.acquire({ delivery: "web", height: 1080, bitrateBps: 0 }, new AbortController().signal);
    await k.acquire(UHD, new AbortController().signal);
    await k.renew();
    expect(srv.calls.at(-1)!.body.stream).toEqual(UHD);
    await k.renew();
    expect(srv.calls.at(-1)!.body.stream).toBeUndefined();
    k.release();
  });

  it("gives a refused seat back when it forgets it", async () => {
    const { k, srv } = keeper([admitted, {}]);
    await k.acquire(UHD, new AbortController().signal);
    k.forget();
    await new Promise((r) => setTimeout(r, 2));
    expect(srv.calls.at(-1)!.url).toBe(`/api/capacity/seat/${"a".repeat(24)}/release`);
    expect(k.current).toBeNull();
  });
});

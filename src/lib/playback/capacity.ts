/**
 * The page's side of the capacity governor (docs/CAPACITY.md): a seat is
 * asked for before a stream starts, the line is waited in when there is none,
 * the seat is kept while the player is open, and the page hears when its
 * stream was stopped to protect the server.
 *
 * The wire types mirror mini-services/remuxer/governor.ts, which answers them.
 */

export type CapacityReason = "seats" | "starts" | "temperature" | "cpu" | "memory" | "network" | "playback";
export type CapacityLevel = "ok" | "busy" | "critical";

export type SeatAnswer =
  | { status: "admitted"; seat: string | null; level: CapacityLevel; waitedMs: number }
  | { status: "queued"; ticket: string; joined: boolean; position: number; waiting: number; reason: CapacityReason; level: CapacityLevel; lighterFits: boolean }
  | { status: "full"; retryAfterS: number; reason: CapacityReason; level: CapacityLevel };

export type RenewAnswer = { status: "active"; level: CapacityLevel } | { status: "evicted"; reason: CapacityReason } | { status: "unknown" };

/** What a seat is asked for: how the stream reaches the viewer, its picture and its bitrate (0 when unknown). */
export interface SeatStream {
  delivery: "remux" | "web" | "direct";
  height: number;
  bitrateBps: number;
}

/** What the player shows of the line: nothing, a place in it, a full line, or a stream that was stopped. */
export type CapacityState =
  | { kind: "none" }
  | { kind: "queued"; position: number; waiting: number; reason: CapacityReason; lighterFits: boolean }
  | { kind: "full"; reason: CapacityReason; retryAfterS: number }
  | { kind: "evicted"; reason: CapacityReason };

/** A refusal for capacity: never the source's fault, so it is never a reason to try another server. */
export class CapacityError extends Error {
  constructor(
    readonly capacity: "full" | "evicted" | "prewarm",
    readonly reason: CapacityReason
  ) {
    super(capacity === "evicted" ? "stopped to protect the server" : "the server is at capacity");
    this.name = "CapacityError";
  }
}

/** The capacity refusal in an /api/vod response, or null when it is not one. */
export function capacityRefusal(status: number, body: Record<string, unknown>): CapacityError | null {
  if (status !== 503 || (body.capacity !== "full" && body.capacity !== "evicted" && body.capacity !== "prewarm")) return null;
  const reason = typeof body.reason === "string" ? (body.reason as CapacityReason) : "seats";
  return new CapacityError(body.capacity, reason);
}

/** How often the line is asked about, and the seat renewed (the server gives up a place after 20 s, a seat after 75). */
export const QUEUE_POLL_MS = 3_000;
export const RENEW_MS = 5_000;
/** A seat outlives its player this long, so the next episode, or a reload, takes it over instead of queueing again. */
export const HANDOVER_MS = 15_000;

const SEAT_URL = "/api/capacity/seat";

function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One page's seat. Kept across players (see HANDOVER_MS), so it lives as long
 * as the tab: `getSeatKeeper()` hands out the page's one keeper.
 */
export class SeatKeeper {
  private seat: string | null = null;
  private ticket: string | null = null;
  private evictedFor: CapacityReason | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private handover: ReturnType<typeof setTimeout> | null = null;
  private stalls = 0;
  private playing = false;
  private holders = 0;
  /** The stream the seat is for now, sent with the next renewal when it changes (another source, another quality). */
  private stream: SeatStream | null = null;
  private streamChanged = false;
  /** A lapsed seat being taken back behind a playing film: stopped when the seat is given back or asked for anew. */
  private background: AbortController | null = null;
  private listener: ((state: CapacityState) => void) | null = null;
  private onEvicted: ((reason: CapacityReason) => void) | null = null;
  private readonly fetchImpl: Fetch;
  private readonly pollMs: number;
  private readonly renewMs: number;
  private readonly handoverMs: number;

  constructor(options: { fetch?: Fetch; pollMs?: number; renewMs?: number; handoverMs?: number } = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.pollMs = options.pollMs ?? QUEUE_POLL_MS;
    this.renewMs = options.renewMs ?? RENEW_MS;
    this.handoverMs = options.handoverMs ?? HANDOVER_MS;
  }

  /** A player takes the keeper: it hears the line's state and the stream being stopped. */
  hold(listener: (state: CapacityState) => void, onEvicted: (reason: CapacityReason) => void): void {
    this.holders++;
    this.listener = listener;
    this.onEvicted = onEvicted;
    if (this.handover) clearTimeout(this.handover);
    this.handover = null;
  }

  /** A player lets go. The seat is given back once no player has taken it over for a while. */
  letGo(): void {
    this.holders = Math.max(0, this.holders - 1);
    if (this.holders > 0) return;
    this.background?.abort();
    this.background = null;
    this.listener = null;
    this.onEvicted = null;
    this.playing = false;
    if (this.handover) clearTimeout(this.handover);
    this.handover = setTimeout(() => this.release(), this.handoverMs);
  }

  get evicted(): boolean {
    return this.evictedFor !== null;
  }

  private show(state: CapacityState): void {
    this.listener?.(state);
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    try {
      const res = await this.fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json().catch(() => null)) as unknown;
    } catch {
      return null;
    }
  }

  /**
   * The seat for a stream, waiting in line while there is none. Resolves to
   * the seat (null when the server has no governor to ask: the stream plays).
   * Rejects with CapacityError("full") when the line is full, and with an
   * AbortError when `signal` ends the wait; the place in line is kept for the
   * next call either way, so a better source found while waiting loses
   * nothing.
   */
  async acquire(stream: SeatStream, signal: AbortSignal, resume = false): Promise<string | null> {
    this.describe(stream);
    if (this.seat) return this.seat;
    if (!resume) {
      // Asked for in earnest: a quiet take-back still running gives way (the place in line carries over).
      this.background?.abort();
      this.background = null;
    }
    this.evictedFor = null;
    // Taking a lapsed seat back happens behind a playing film: it is never shown.
    const show = (state: CapacityState) => {
      if (!resume) this.show(state);
    };
    for (;;) {
      if (signal.aborted) throw abortError();
      // Another ask got there first.
      if (this.seat) return this.seat;
      const answer = (await this.post(SEAT_URL, { ...stream, ticket: this.ticket ?? undefined, resume })) as SeatAnswer | null;
      if (!answer || typeof answer !== "object" || !("status" in answer)) {
        // No answer: the server has no governor, or it is restarting. Playing beats a page that waits for ever.
        this.ticket = null;
        show({ kind: "none" });
        return null;
      }
      if (answer.status === "admitted") {
        if (this.seat && answer.seat && answer.seat !== this.seat) {
          // Two asks were answered: one seat is enough, the other goes straight back.
          void this.post(`${SEAT_URL}/${answer.seat}/release`, {});
          return this.seat;
        }
        if (signal.aborted && !resume && this.holders === 0) {
          // Nobody is left to use it.
          if (answer.seat) void this.post(`${SEAT_URL}/${answer.seat}/release`, {});
          throw abortError();
        }
        this.seat = answer.seat;
        this.ticket = null;
        this.streamChanged = false;
        show({ kind: "none" });
        if (this.seat) this.startRenewing();
        return this.seat;
      }
      if (answer.status === "full") {
        this.ticket = null;
        show({ kind: "full", reason: answer.reason, retryAfterS: answer.retryAfterS });
        throw new CapacityError("full", answer.reason);
      }
      this.ticket = answer.ticket;
      show({ kind: "queued", position: answer.position, waiting: answer.waiting, reason: answer.reason, lighterFits: answer.lighterFits });
      await sleep(this.pollMs, signal);
    }
  }

  /** The seat being held now, if any. */
  get current(): string | null {
    return this.seat;
  }

  noteStall(): void {
    this.stalls++;
  }

  /** The stream the seat is for now: a change of kind (delivery or picture class) is told with the next renewal. */
  describe(stream: SeatStream): void {
    const before = this.stream;
    this.stream = stream;
    if (before && (before.delivery !== stream.delivery || before.height !== stream.height)) this.streamChanged = true;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
  }

  private startRenewing(): void {
    if (this.renewTimer) return;
    this.renewTimer = setInterval(() => void this.renew(), this.renewMs);
  }

  private stopRenewing(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  /**
   * Tells the server the viewer is still here (with their stalls since the
   * last time). Returns true when it answers that the stream was stopped.
   */
  async renew(): Promise<boolean> {
    const seat = this.seat;
    if (!seat) return this.evicted;
    const stalls = this.stalls;
    this.stalls = 0;
    const changed = this.streamChanged && this.stream ? this.stream : undefined;
    this.streamChanged = false;
    const answer = (await this.post(`${SEAT_URL}/${seat}/renew`, { stalls, playing: this.playing, ...(changed ? { stream: changed } : {}) })) as RenewAnswer | null;
    if (!answer || this.seat !== seat) return this.evicted;
    if (answer.status === "evicted") {
      this.seat = null;
      this.evictedFor = answer.reason;
      this.stopRenewing();
      this.show({ kind: "evicted", reason: answer.reason });
      this.onEvicted?.(answer.reason);
      return true;
    }
    if (answer.status === "unknown") {
      // Forgotten (the server restarted, or a hidden tab renewed too late): the stream is running, so it takes
      // its seat back without waiting in line.
      this.seat = null;
      this.stopRenewing();
      this.background?.abort();
      this.background = new AbortController();
      void this.acquire(this.stream ?? { delivery: "remux", height: 0, bitrateBps: 0 }, this.background.signal, true).catch(() => undefined);
    }
    return false;
  }

  /** Gives the seat back, and any place in line. `beacon` for a page that is going away. */
  release(beacon = false): void {
    if (this.handover) clearTimeout(this.handover);
    this.handover = null;
    this.background?.abort();
    this.background = null;
    this.stopRenewing();
    const id = this.seat ?? this.ticket;
    this.seat = null;
    this.ticket = null;
    if (!id) return;
    const url = `${SEAT_URL}/${id}/release`;
    if (beacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, new Blob(["{}"], { type: "application/json" }));
      return;
    }
    void this.post(url, {});
  }

  /** Drops a seat the server refused a stream under (it lapsed, or the server restarted), telling it so in case it still has it. */
  forget(): void {
    const seat = this.seat;
    this.seat = null;
    this.stopRenewing();
    if (seat) void this.post(`${SEAT_URL}/${seat}/release`, {});
  }

  /** Back to nothing held, after a stop the viewer has seen (they may join the line again). */
  clearEviction(): void {
    this.evictedFor = null;
    this.show({ kind: "none" });
  }
}

let keeper: SeatKeeper | null = null;

/** The page's one seat keeper. */
export function getSeatKeeper(): SeatKeeper {
  keeper ??= new SeatKeeper();
  return keeper;
}

/** The seat request for a source: how it reaches the viewer, its picture height and its bitrate (from its size and length). */
export function seatStreamFor(input: { delivery: "remux" | "web" | "direct"; height: number; sizeBytes?: number | null; durationS?: number | null }): SeatStream {
  const bitrate = input.sizeBytes && input.durationS && input.durationS > 60 ? (input.sizeBytes * 8) / input.durationS : 0;
  return { delivery: input.delivery, height: Math.max(0, Math.round(input.height)), bitrateBps: Number.isFinite(bitrate) ? Math.round(bitrate) : 0 };
}

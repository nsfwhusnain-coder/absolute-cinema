/**
 * Paces the upstream requests made for each link.
 *
 * AllDebrid answers 204 (No Content) instead of the range once one link has
 * been asked too often, and goes on refusing for a few seconds. Measured from
 * the server on 2026-10-17: about twenty requests in a burst were served, then
 * every one was refused for 2-4 s; a steady two a second was nearly always
 * served, four a second was not. The limit is each link's own (another file on
 * the same host was served while the first was being refused), and it counts
 * requests started, not connections open: sixteen long reads at once were all
 * served. A run reading over twelve connections in pieces, with the index reads
 * and the next episode's prewarm alongside, went past it, and pieces refused
 * three times in a row failed the run with nothing made.
 *
 * So every upstream request for a link first waits here for a turn: up to
 * `burst` straight away, then `ratePerS` a second. A refusal stops the link's
 * requests for `refusalPauseMs`, and halves its rate for `slowForMs`.
 */

export interface LinkPacing {
  /** Requests a link may start at once, after a quiet spell. */
  burst: number;
  /** Requests a second a link may start once its burst is spent. */
  ratePerS: number;
  /** After a refusal, how long the link gets no requests at all. */
  refusalPauseMs: number;
  /** After a refusal, how long the link is held to half its rate. */
  slowForMs: number;
}

export const DEFAULT_LINK_PACING: LinkPacing = {
  burst: 12,
  ratePerS: 1.5,
  refusalPauseMs: 3_000,
  slowForMs: 60_000,
};

/** A waiting request looks at whether it is still wanted at least this often. */
const CHECK_MS = 250;
/** A link nobody has asked for in this long is forgotten. */
const FORGET_MS = 10 * 60 * 1000;
const MAX_LINKS = 256;

interface Bucket {
  /** Requests that may start now (fractional while refilling). */
  tokens: number;
  /** When `tokens` was last brought up to date. */
  at: number;
  pausedUntil: number;
  slowUntil: number;
  /** The turn asked for last: each turn starts once the one before it is settled. */
  queue: Promise<unknown>;
  usedAt: number;
}

let pacing: LinkPacing = DEFAULT_LINK_PACING;
const buckets = new Map<string, Bucket>();

function rateAt(bucket: Bucket, now: number): number {
  return now < bucket.slowUntil ? pacing.ratePerS / 2 : pacing.ratePerS;
}

function refill(bucket: Bucket, now: number): void {
  if (now <= bucket.at) return;
  bucket.tokens = Math.min(pacing.burst, bucket.tokens + ((now - bucket.at) / 1000) * rateAt(bucket, now));
  bucket.at = now;
}

function bucketFor(link: string, now: number): Bucket {
  let bucket = buckets.get(link);
  if (!bucket) {
    for (const [key, old] of buckets) {
      if (now - old.usedAt > FORGET_MS || buckets.size >= MAX_LINKS) buckets.delete(key);
      else break;
    }
    bucket = { tokens: pacing.burst, at: now, pausedUntil: 0, slowUntil: 0, queue: Promise.resolve(), usedAt: now };
  } else {
    buckets.delete(link);
  }
  // Kept in order of use, so the oldest are the first looked at for forgetting.
  buckets.set(link, bucket);
  return bucket;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for this link's next turn to start a request, in the order the turns
 * were asked for. Resolves false, without using a turn, once `cancelled` says
 * the request is no longer wanted.
 */
export function linkTurn(link: string, cancelled: () => boolean = () => false): Promise<boolean> {
  const bucket = bucketFor(link, Date.now());
  const turn = bucket.queue.then(async () => {
    for (;;) {
      if (cancelled()) return false;
      const now = Date.now();
      refill(bucket, now);
      const untilToken = bucket.tokens >= 1 ? 0 : ((1 - bucket.tokens) / rateAt(bucket, now)) * 1000;
      const wait = Math.max(bucket.pausedUntil - now, untilToken);
      if (wait <= 0) {
        bucket.tokens -= 1;
        bucket.usedAt = now;
        return true;
      }
      await sleep(Math.min(wait, CHECK_MS));
    }
  });
  bucket.queue = turn.catch(() => false);
  return turn;
}

/**
 * The link refused a request: it gets none for a moment, then half its rate
 * for a while. Refusals during the pause answer requests made before it, and
 * leave it as it is. Returns true for the refusal that started the pause, so a
 * burst of refusals is reported once.
 */
export function linkRefused(link: string, now = Date.now()): boolean {
  const bucket = bucketFor(link, now);
  refill(bucket, now);
  bucket.tokens = 0;
  if (now < bucket.pausedUntil) return false;
  bucket.pausedUntil = now + pacing.refusalPauseMs;
  bucket.slowUntil = now + pacing.slowForMs;
  return true;
}

/**
 * A status that means the CDN would not serve the range just now: 429, 503,
 * or a 2xx that is not the range asked for, such as AllDebrid's 204. A 200 is
 * not one: it means the range was ignored and the whole file is on its way.
 */
export function isRefusal(status: number): boolean {
  return status === 429 || status === 503 || (status > 200 && status < 300 && status !== 206);
}

/** Test seam: other pacing (null for the default), and every link forgotten. */
export function __setLinkPacingForTests(next: Partial<LinkPacing> | null): void {
  pacing = next ? { ...DEFAULT_LINK_PACING, ...next } : DEFAULT_LINK_PACING;
  buckets.clear();
}

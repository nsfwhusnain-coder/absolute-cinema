/**
 * Keeps the player's buffer inside what the browser will hold.
 *
 * hls.js sizes its buffer in seconds, while a browser caps a SourceBuffer in
 * bytes. A remuxed 4K file runs near 40 Mbit/s, which is 5 MB a second, so 60
 * seconds ahead is 300 MB: past Chrome's cap, which then refuses the append
 * (QuotaExceededError). The buffer stops growing and playback stalls the moment
 * it reaches the end of what is held.
 *
 * Each browser's byte budget is therefore turned into seconds with the bitrate
 * actually being loaded, so the bytes stay under the budget whatever the file.
 */

import type { MediaBufferProfile } from "./device-profile";

/** Never ask for less forward buffer than this: below it any hiccup is a stall. */
const MIN_FORWARD_S = 6;
/** Never keep less behind the playhead than this: it is what a small rewind lands on. */
const MIN_BACK_S = 2;
/** Weight of the newest segment in the running bitrate. */
const BITRATE_SMOOTHING = 0.3;
/**
 * Share of the server's declared average the measured rate is never taken below.
 * One small segment, such as a dark scene or a short last piece, must not stretch
 * the buffer past the budget when the file as a whole runs at the declared rate.
 */
const DECLARED_FLOOR = 0.7;
/** What the budget becomes each time the browser says the buffer is full. */
const FULL_SHRINK = 0.5;
/** The budget is never cut below this share of the platform's. */
const MIN_SCALE = 0.25;

export interface BufferLengths {
  maxBufferLengthS: number;
  maxMaxBufferLengthS: number;
  backBufferLengthS: number;
  /** The forward byte budget, passed to hls.js's own byte limit (`maxBufferSize`). */
  maxBufferSize: number;
}

export class BufferBudget {
  /** Smoothed bytes per second of the segments loaded so far. */
  private measuredBytesPerSecond = 0;
  /** The server's average bytes per second for the whole file, when it knows it. */
  private declaredBytesPerSecond = 0;
  /** A rendition's bytes per second from the manifest, used until a segment has been measured. */
  private seededBytesPerSecond = 0;
  private scale = 1;

  /** `declaredBitrateBps` is the file's average bitrate in bits per second, when the server knows it. */
  constructor(
    private readonly profile: MediaBufferProfile,
    declaredBitrateBps?: number
  ) {
    this.declaredBytesPerSecond = toBytesPerSecond(declaredBitrateBps ?? 0);
  }

  /**
   * A rendition's bitrate from the manifest, in bits per second. It stands in
   * for the first segments until one has been measured. A declared average from
   * the server outranks it.
   */
  seed(bitrateBps: number): void {
    const rate = toBytesPerSecond(bitrateBps);
    if (rate && !this.declaredBytesPerSecond) this.seededBytesPerSecond = rate;
  }

  /** Folds one loaded media segment into the running bitrate. */
  observe(bytes: number, durationS: number): void {
    if (!(bytes > 0) || !(durationS > 0)) return;
    const rate = bytes / durationS;
    this.measuredBytesPerSecond = this.measuredBytesPerSecond
      ? this.measuredBytesPerSecond + BITRATE_SMOOTHING * (rate - this.measuredBytesPerSecond)
      : rate;
  }

  /** The browser refused an append: hold less from now on. */
  full(): void {
    this.scale = Math.max(MIN_SCALE, this.scale * FULL_SHRINK);
  }

  lengths(): BufferLengths {
    const { profile, scale } = this;
    const forwardBytes = profile.forwardBytes * scale;
    const rate = this.bytesPerSecond();
    // Before any rate is known the conservative seconds stand in. They shrink
    // with the budget too, so a refusal still has an effect.
    const forward = rate
      ? clamp(forwardBytes / rate, MIN_FORWARD_S, profile.forwardMaxS)
      : clamp(profile.fallbackForwardS * scale, MIN_FORWARD_S, profile.forwardMaxS);
    const back = rate
      ? clamp((profile.backBytes * scale) / rate, MIN_BACK_S, profile.backMaxS)
      : clamp(profile.fallbackBackS * scale, MIN_BACK_S, profile.backMaxS);
    return {
      maxBufferLengthS: forward,
      maxMaxBufferLengthS: forward,
      backBufferLengthS: back,
      maxBufferSize: forwardBytes,
    };
  }

  /** The rate the seconds are worked out from: measured, held up to the declared average, or else the declared or seeded guess. */
  private bytesPerSecond(): number {
    if (!this.measuredBytesPerSecond) return this.declaredBytesPerSecond || this.seededBytesPerSecond;
    if (!this.declaredBytesPerSecond) return this.measuredBytesPerSecond;
    return Math.max(this.measuredBytesPerSecond, DECLARED_FLOOR * this.declaredBytesPerSecond);
  }
}

/** Bits per second to bytes per second, or 0 when the figure is not usable. */
function toBytesPerSecond(bitrateBps: number): number {
  return Number.isFinite(bitrateBps) && bitrateBps > 0 ? bitrateBps / 8 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

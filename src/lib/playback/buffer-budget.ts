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
/**
 * What is kept behind the playhead beyond the file's longest keyframe gap.
 *
 * hls.js trims the back buffer by time alone (to a multiple of the playlist's
 * target duration, 3 s for a remux, before the playhead), and a browser that
 * removes media also removes everything after it up to the next keyframe.
 * With less kept behind than a keyframe gap, a trim reaches through the
 * picture group being played: its frames vanish and playback freezes with
 * seconds of media still buffered (seen on a 4K remux at 37 Mbit/s with 4 s
 * kept behind and keyframes 10 s apart). One target duration and a second
 * of margin on top of the gap keep every trim behind the current group.
 */
const KEYFRAME_GAP_MARGIN_S = 4;
/**
 * Kept behind when the keyframe gaps are not known: a web stream's segments
 * each open on a keyframe, and hls.js trims to a segment boundary a whole
 * segment back, so its trims never reach the group being played. This covers
 * segments of up to eight seconds. A remux always reports its gaps.
 */
const UNKNOWN_KEYFRAME_BACK_S = 8;
/** However long a file's keyframe gaps, never more than this is kept behind. */
const MAX_KEYFRAME_BACK_S = 40;
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
  /** Seconds that must stay behind the playhead so a trim never reaches the picture group being played. */
  private readonly minBackS: number;

  /**
   * `declaredBitrateBps` is the file's average bitrate in bits per second, and
   * `keyframeGapS` its longest gap between keyframes, when the server knows them.
   */
  constructor(
    private readonly profile: MediaBufferProfile,
    declaredBitrateBps?: number,
    keyframeGapS?: number
  ) {
    this.declaredBytesPerSecond = toBytesPerSecond(declaredBitrateBps ?? 0);
    this.minBackS = minimumBackSeconds(keyframeGapS);
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
    const { profile, scale, minBackS } = this;
    const forwardBytes = profile.forwardBytes * scale;
    const rate = this.bytesPerSecond();
    // Before any rate is known the conservative seconds stand in. They shrink
    // with the budget too, so a refusal still has an effect.
    if (!rate) {
      return {
        maxBufferLengthS: clamp(profile.fallbackForwardS * scale, MIN_FORWARD_S, profile.forwardMaxS),
        maxMaxBufferLengthS: clamp(profile.fallbackForwardS * scale, MIN_FORWARD_S, profile.forwardMaxS),
        backBufferLengthS: Math.max(minBackS, Math.min(profile.fallbackBackS * scale, profile.backMaxS)),
        maxBufferSize: forwardBytes,
      };
    }
    // The back buffer is the budget's share, but never less than the keyframe
    // gap needs; what it takes beyond its share comes out of the forward part,
    // so the two together stay inside what the browser holds.
    const back = Math.max(minBackS, Math.min((profile.backBytes * scale) / rate, profile.backMaxS));
    const totalBytes = (profile.forwardBytes + profile.backBytes) * scale;
    const forwardRoom = Math.min(forwardBytes, totalBytes - back * rate);
    const forward = clamp(forwardRoom / rate, MIN_FORWARD_S, profile.forwardMaxS);
    return {
      maxBufferLengthS: forward,
      maxMaxBufferLengthS: forward,
      backBufferLengthS: back,
      maxBufferSize: Math.max(0, forwardRoom),
    };
  }

  /** The rate the seconds are worked out from: measured, held up to the declared average, or else the declared or seeded guess. */
  private bytesPerSecond(): number {
    if (!this.measuredBytesPerSecond) return this.declaredBytesPerSecond || this.seededBytesPerSecond;
    if (!this.declaredBytesPerSecond) return this.measuredBytesPerSecond;
    return Math.max(this.measuredBytesPerSecond, DECLARED_FLOOR * this.declaredBytesPerSecond);
  }
}

/** Seconds to keep behind the playhead for a file whose longest keyframe gap is `keyframeGapS` (unknown when absent). */
export function minimumBackSeconds(keyframeGapS?: number): number {
  if (!(keyframeGapS !== undefined && Number.isFinite(keyframeGapS) && keyframeGapS > 0)) return UNKNOWN_KEYFRAME_BACK_S;
  return Math.min(MAX_KEYFRAME_BACK_S, keyframeGapS + KEYFRAME_GAP_MARGIN_S);
}

/** Bits per second to bytes per second, or 0 when the figure is not usable. */
function toBytesPerSecond(bitrateBps: number): number {
  return Number.isFinite(bitrateBps) && bitrateBps > 0 ? bitrateBps / 8 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

import type { PlaybackSource, PlayerFeedback } from "./types";
import { platformSummary } from "./device-profile";
import { sourceDelivery } from "./source-quality";
import {
  PlayerTally,
  deliveryOf,
  isWatching,
  type PlayerCounters,
  type PlayerDelivery,
  type SessionEndReason,
} from "@/lib/telemetry/qoe";

/** Which title the open player is showing. See {@link setFeedbackTitleContext}. */
export interface FeedbackTitleContext {
  tmdbId?: string;
  mediaType?: "movie" | "tv";
  season?: number;
  episode?: number;
}

let titleContext: FeedbackTitleContext = {};

/**
 * Stamp every subsequent emission with the title being watched.
 *
 * Set centrally rather than threaded through each call site: source memory is
 * per-title, and the six existing emitters live deep inside the player's
 * attempt/watchdog machinery where adding four more arguments each would be
 * far more likely to break something than a single module-level assignment.
 * Cleared on teardown so a stale title can never mislabel the next session.
 */
export function setFeedbackTitleContext(context: FeedbackTitleContext): void {
  titleContext = context;
}

export function clearFeedbackTitleContext(): void {
  titleContext = {};
}

/** The route a file takes to the screen, as the reports name it (see docs/TELEMETRY.md). */
export function deliveryOfSource(source: PlaybackSource): PlayerDelivery {
  return deliveryOf(sourceDelivery(source), source.type);
}

/**
 * Sends one report to the feedback endpoint. A beacon survives the tab
 * closing, so it is preferred; a keepalive request is the fallback.
 * Telemetry must be unable to affect playback, so every failure is swallowed.
 */
function sendReport(fields: object): void {
  if (typeof window === "undefined") return;
  // Stamped here rather than at each call site: every emitter gets device
  // attribution for free, and without it a television session is
  // indistinguishable from a laptop one in the logs — which is precisely why
  // cross-device playback differences went unnoticed in production.
  const platform = platformSummary();
  const body = JSON.stringify({
    ...titleContext,
    ...fields,
    ...(platform ? { platform } : {}),
    occurredAt: Date.now(),
  });
  try {
    if (typeof navigator.sendBeacon === "function") {
      const sent = navigator.sendBeacon(
        "/api/playback/feedback",
        new Blob([body], { type: "application/json" })
      );
      if (sent) return;
    }
    void fetch("/api/playback/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      cache: "no-store",
    }).catch(() => undefined);
  } catch {
    // Telemetry must be unable to affect playback.
  }
}

/** Best-effort observation channel. Playback never waits for telemetry. */
export function emitPlayerFeedback(
  feedback: Omit<PlayerFeedback, "occurredAt"> & { delivery?: PlayerDelivery; decodedWidth?: number }
): void {
  sendReport(feedback);
}

/* Heartbeats and the end-of-title summary. */

/** How often a player reports while it is open on a title with a file attached. */
const HEARTBEAT_MS = 30_000;

/** What the player reads when it reports: the element, the engine and the store, as the controller holds them. */
export interface PlayerReadings extends PlayerCounters {
  /** The engine's kind (hlsjs, native_hls, native_file), or null before one is loaded. */
  engine: string | null;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  buffering: boolean;
  positionS: number;
  durationS: number;
  bufferAheadS: number;
  decodedWidth: number;
  levelBitrateBps: number | null;
  declaredBitrateBps: number | null;
  bandwidthBps: number | null;
  audioLanguage: string | null;
  subtitleLanguage: string | null;
}

/** The file a report is about. */
export interface ReportedFile {
  sourceId: string;
  provider: string;
  delivery: PlayerDelivery;
}

/** What the registry of the open title view needs of it: a way to end it. */
interface OpenView {
  finish(reason: SessionEndReason): void;
}

/** The title view open now. A second one opening ends it as "switched". */
let openView: OpenView | null = null;

/**
 * Keeps one title view's heartbeats and its end-of-title summary. One per
 * player; the controller opens it when the player mounts on a title, attaches
 * each file to it, and closes it on unmount.
 *
 * The leaving is settled a moment later (a timeout of zero): a title that
 * starts in the same moment, which is what a new episode is (a new player on
 * a new title), then ends this view as "switched" instead of "left".
 */
export class PlaybackReporter {
  private readonly tally = new PlayerTally();
  private read: (() => PlayerReadings) | null = null;
  private title: FeedbackTitleContext = {};
  private file: ReportedFile | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The view as it was when it closed: the moment the viewer left, not the moment the leaving was settled. */
  private closed: { now: number; readings: PlayerReadings } | null = null;
  private finished = false;
  /** This view as the registry of open views holds it. */
  private readonly view: OpenView = { finish: (reason) => this.finish(reason) };

  /** `send` is the transport; the default is the feedback endpoint. */
  constructor(private readonly send: (report: Record<string, unknown>) => void = sendReport) {}

  open(read: () => PlayerReadings, title: FeedbackTitleContext): void {
    if (this.finished) return;
    this.read = read;
    this.title = title;
    if (this.closed) {
      // Opened again before its leaving was settled (a remount of the same title): the same view goes on.
      this.closed = null;
      if (this.leaveTimer !== null) clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
      if (this.file) this.startHeartbeat();
    }
    if (openView && openView !== this.view) openView.finish("switched");
    openView = this.view;
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.onPageHide);
  }

  /** A file is about to play on this title. The first one starts the heartbeats. */
  attach(file: ReportedFile): void {
    if (this.finished) return;
    this.file = file;
    this.tally.noteSource(file.sourceId);
    // Whatever was playing before (the previous file) stops counting now.
    this.tally.halted(Date.now());
    if (this.heartbeatTimer === null) this.startHeartbeat();
  }

  /** The first picture of an attempt. `startupMs` is given once for the title: from opening it. */
  picture(startupMs: number | null): void {
    this.tally.picture(startupMs);
  }

  playing(): void {
    this.tally.playing(Date.now());
  }

  /** Paused, or a source being replaced: the picture is not moving. */
  paused(): void {
    this.tally.halted(Date.now());
  }

  /** The element is waiting for data. `eligible` is false for a wait a jump causes, which is not a stall. */
  waiting(eligible: boolean): void {
    this.tally.waiting(Date.now(), eligible);
  }

  /** A jump the viewer made: counted, and the picture is not moving until it lands. */
  seeked(): void {
    const now = Date.now();
    this.tally.seek();
    this.tally.halted(now);
  }

  /**
   * The jump has landed. A jump within buffered media plays on without a
   * `playing` event, so the watch time is resumed from the element's own state;
   * a wait that follows it halts the watch time again.
   */
  seekDone(watching: boolean): void {
    this.tally.watch(Date.now(), watching);
  }

  ended(): void {
    const now = Date.now();
    this.tally.ended();
    this.tally.halted(now);
  }

  /** Every source has been tried and none played. */
  failed(): void {
    this.tally.markFailed();
  }

  /**
   * The viewer is leaving the title (the player unmounted). Freezes the view
   * as it is now; the summary is sent a moment later unless a new title opens
   * first and ends it as "switched".
   */
  close(): void {
    if (this.finished || this.closed) return;
    const now = Date.now();
    this.stopHeartbeat();
    this.tally.halted(now);
    const readings = this.snapshot();
    if (!readings) return;
    this.closed = { now, readings };
    this.leaveTimer = setTimeout(() => this.finish("left"), 0);
  }

  /**
   * Sends the view's summary, once. A view that never had a file has nothing to
   * report: the feedback endpoint needs the file it is about.
   */
  finish(reason: SessionEndReason): void {
    if (this.finished) return;
    this.finished = true;
    this.stopHeartbeat();
    if (this.leaveTimer !== null) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    if (openView === this.view) openView = null;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
    try {
      const now = this.closed ? this.closed.now : Date.now();
      const readings = this.closed ? this.closed.readings : this.snapshot();
      if (!readings || !this.file) return;
      const totals = this.tally.finish(now, readings, reason);
      this.send({
        ...this.title,
        event: "session_end",
        sourceId: this.file.sourceId,
        provider: this.file.provider,
        delivery: this.file.delivery,
        engine: readings.engine,
        endReason: totals.endReason,
        watchedMs: totals.watchedMs,
        stalledMs: totals.stalledMs,
        stalls: totals.stalls,
        seeks: totals.seeks,
        startupMs: totals.startupMs,
        maxHeight: totals.maxHeight,
        avgBitrateBps: totals.avgBitrateBps,
        bytesLoaded: totals.bytesLoaded,
        sourcesTried: totals.sourcesTried,
      });
    } catch {
      // Telemetry must be unable to affect playback.
    }
  }

  /** A page being hidden for good ends the view; one kept in the back-forward cache may come back and go on. */
  private readonly onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) return;
    this.finish("left");
  };

  private snapshot(): PlayerReadings | null {
    try {
      return this.read ? this.read() : null;
    } catch {
      return null;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** One heartbeat: the picture now, and what changed since the last one. */
  private beat(): void {
    if (this.finished || !this.file) return;
    try {
      const now = Date.now();
      const r = this.snapshot();
      if (!r) return;
      this.tally.watch(now, isWatching(r));
      const counts = this.tally.heartbeat(now, r);
      const file = this.file;
      this.send({
        ...this.title,
        event: "heartbeat",
        sourceId: file.sourceId,
        provider: file.provider,
        delivery: file.delivery,
        engine: r.engine,
        positionS: r.positionS,
        durationS: r.durationS,
        playing: !r.paused && !r.ended,
        paused: r.paused,
        buffering: r.buffering,
        bufferAheadS: r.bufferAheadS,
        decodedWidth: r.decodedWidth,
        decodedHeight: r.decodedHeight,
        // A remuxed file's rate is the one it declares; a web stream's is the rendition now playing.
        levelBitrateBps: file.delivery === "remux" ? r.declaredBitrateBps : r.levelBitrateBps,
        bandwidthBps: r.bandwidthBps,
        bytesLoaded: counts.bytesLoaded,
        loadMs: counts.loadMs,
        droppedFrames: counts.droppedFrames,
        decodedFrames: counts.decodedFrames,
        stalls: counts.stalls,
        stalledMs: counts.stalledMs,
        watchedMs: counts.watchedMs,
        audioLanguage: r.audioLanguage,
        subtitleLanguage: r.subtitleLanguage,
      });
    } catch {
      // Telemetry must be unable to affect playback.
    }
  }
}

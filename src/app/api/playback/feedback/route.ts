import { forgetLivePlayer, noteLiveEvent, noteLiveHeartbeat, type LiveContext } from "@/lib/hub/live-players";
import { logEvent, viewerTag } from "@/lib/event-log";
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import type { PlayerFeedbackEvent } from "@/lib/playback/types";
import { providerHealthRegistry } from "@/lib/playback/health-registry";
import { sourceMemoryScope } from "@/lib/playback/source-memory";
import {
  MAX_WATCHED_MS_PER_EVENT,
  recordSourceFeedback,
} from "@/lib/playback/source-memory-store";
import { RateLimiter } from "@/lib/rate-limit";
import { isViewerSideFailure } from "@/lib/playback/failure-kind";
import {
  parseDelivery,
  parseEngine,
  parseHeartbeat,
  parseSessionEnd,
} from "@/lib/telemetry/player-report";
import {
  forgetActivePlayer,
  noteActivePlayer,
  playerLabels,
  recordFirstFrame,
  recordHeartbeat,
  recordSeek,
  recordStall,
  recordStartFailure,
} from "@/lib/telemetry/player-metrics";

const FEEDBACK_LIMIT = 180;
const FEEDBACK_WINDOW_MS = 5 * 60 * 1000;
const feedbackLimiter = new RateLimiter({
  limit: FEEDBACK_LIMIT,
  windowMs: FEEDBACK_WINDOW_MS,
});

/** Longest wait for a picture worth writing down as one. */
const MAX_WAIT_MS = 600_000;

/** Everything the endpoint takes: the player's own events, and a title view's heartbeats and summary. */
type ReportEvent = PlayerFeedbackEvent | "heartbeat" | "session_end";
const EVENTS = new Set<ReportEvent>([
  "first_frame",
  "decoded_resolution",
  "stall",
  "handoff_failed",
  "decode_error",
  "sustained_play",
  "seek",
  "capacity_stopped",
  "heartbeat",
  "session_end",
]);

/**
 * Counts a report's metrics. A metric is only ever a side effect: it is
 * counted after the report is logged, and a failure here must never cost the
 * viewer their response.
 */
function countSafely(count: () => void): void {
  try {
    count();
  } catch {
    // Telemetry must be unable to affect playback.
  }
}

export async function POST(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rate = feedbackLimiter.consume(userId);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many feedback events" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))),
        },
      }
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const event = body.event as ReportEvent;
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.slice(0, 200) : "";
  const provider = typeof body.provider === "string" ? body.provider.slice(0, 80) : "";
  if (!EVENTS.has(event) || !sourceId || !provider) {
    return NextResponse.json({ error: "Invalid feedback" }, { status: 400 });
  }
  const finite = (value: unknown, max: number): number | undefined => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? Math.min(number, max)
      : undefined;
  };
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, max)
      : undefined;
  // Coarse device attribution. Without it a television session and a laptop
  // session are identical in the logs, which is why cross-device playback
  // differences stayed invisible. Never the raw UA — a bounded token only.
  const rawPlatform =
    typeof body.platform === "object" && body.platform !== null
      ? (body.platform as Record<string, unknown>)
      : null;
  const platform = rawPlatform
    ? {
        deviceClass:
          rawPlatform.deviceClass === "tv" ? ("tv" as const) : ("desktop" as const),
        uaPlatform: text(rawPlatform.uaPlatform, 24),
        heapLimitMb: finite(rawPlatform.heapLimitMb, 65_536),
        cores: finite(rawPlatform.cores, 512),
        screenWidth: finite(rawPlatform.screenWidth, 16_384),
      }
    : undefined;
  const tmdbId = text(body.tmdbId, 24);
  const mediaType = body.mediaType === "tv" ? "tv" : "movie";
  const season = finite(body.season, 100) ?? 0;
  const episode = finite(body.episode, 10_000) ?? 0;
  const title = tmdbId ? { tmdbId, mediaType, season, episode } : {};
  // What the live dashboard (/hub) shows of this player.
  const live: LiveContext = {
    title: tmdbId ? { tmdbId, mediaType, season, episode } : null,
    deviceClass: platform?.deviceClass ?? null,
    uaPlatform: platform?.uaPlatform ?? null,
  };

  // A heartbeat or a summary is for the record and the live metrics only. It
  // is not an outcome: it feeds neither the provider's health nor the title's
  // source memory, which are both read by the next start.
  if (event === "heartbeat") {
    const report = parseHeartbeat(body);
    if (!report) return NextResponse.json({ error: "Invalid feedback" }, { status: 400 });
    logEvent("player_feedback", {
      userId,
      ...report,
      ...(platform ? { platform } : {}),
      ...title,
      event: "player_feedback",
      feedbackEvent: "heartbeat",
    });
    const labels = playerLabels({
      deviceClass: platform?.deviceClass,
      delivery: report.delivery,
      provider: report.provider,
      decodedWidth: report.decodedWidth,
      decodedHeight: report.decodedHeight,
    });
    countSafely(() => {
      recordHeartbeat(labels, report);
      noteActivePlayer(viewerTag(userId), report.sourceId, labels);
      noteLiveHeartbeat(userId, report, live);
    });
    return new NextResponse(null, { status: 204 });
  }
  if (event === "session_end") {
    const report = parseSessionEnd(body);
    if (!report) return NextResponse.json({ error: "Invalid feedback" }, { status: 400 });
    logEvent("player_feedback", {
      userId,
      ...report,
      ...(platform ? { platform } : {}),
      ...title,
      event: "player_feedback",
      feedbackEvent: "session_end",
    });
    // The title view is over: it stops counting as playing this file now.
    countSafely(() => forgetActivePlayer(viewerTag(userId), report.sourceId));
    countSafely(() => forgetLivePlayer(userId, report.sourceId));
    return new NextResponse(null, { status: 204 });
  }

  const engine = parseEngine(body.engine) ?? undefined;
  const delivery = parseDelivery(body.delivery) ?? undefined;
  const feedback = {
    event,
    sourceId,
    provider,
    attemptId: text(body.attemptId, 96),
    occurredAt: finite(body.occurredAt, Date.now() + 60_000) ?? Date.now(),
    timeToFirstFrameMs: finite(body.timeToFirstFrameMs, 180_000),
    sinceOpenMs: finite(body.sinceOpenMs, MAX_WAIT_MS),
    seekMs: finite(body.seekMs, MAX_WAIT_MS),
    decodedHeight: finite(body.decodedHeight, 4320),
    decodedWidth: finite(body.decodedWidth, 7680),
    selectedHeight: finite(body.selectedHeight, 4320),
    audioCodec: text(body.audioCodec, 32),
    audioLanguage: text(body.audioLanguage, 32),
    engine,
    delivery,
    errorDetail: text(body.errorDetail, 180),
    reason: text(body.reason, 120),
  };
  logEvent("player_feedback", {
    userId,
    ...feedback,
    ...(platform ? { platform } : {}),
    ...title,
    watchedMs: finite(body.watchedMs, MAX_WATCHED_MS_PER_EVENT),
    event: "player_feedback",
    feedbackEvent: feedback.event,
  });
  const labels = playerLabels({
    deviceClass: platform?.deviceClass,
    delivery: feedback.delivery,
    provider,
    decodedWidth: feedback.decodedWidth,
    decodedHeight: feedback.decodedHeight,
  });
  countSafely(() => noteLiveEvent(userId, { ...feedback, delivery: feedback.delivery ?? undefined, engine: feedback.engine ?? undefined }, live));
  countSafely(() => {
    switch (feedback.event) {
      case "first_frame":
        recordFirstFrame(labels, {
          timeToFirstFrameMs: feedback.timeToFirstFrameMs,
          sinceOpenMs: feedback.sinceOpenMs,
        });
        break;
      case "handoff_failed":
      case "decode_error":
        recordStartFailure(labels, feedback.reason ?? feedback.errorDetail);
        break;
      case "stall":
        recordStall(labels);
        break;
      case "seek":
        recordSeek(labels, feedback.seekMs);
        break;
    }
  });
  // A jump, or a stream the server stopped for capacity, is for the record: it says nothing of a source's health.
  if (feedback.event === "seek" || feedback.event === "capacity_stopped") return new NextResponse(null, { status: 204 });
  // A file this device could not decode says nothing about the server it came
  // from, and both histories below are read by every screen in the house.
  const viewerSide = isViewerSideFailure(feedback);
  if (!viewerSide) providerHealthRegistry.observe({ provider, viewerId: userId }, feedback);

  // Durable per-title memory. The registry above is ephemeral and keyed by
  // provider; this remembers what THIS source actually delivered for THIS
  // title so the next visit can lead with it. Awaited so a burst of events
  // folds in order (streaks and rolling averages are order-dependent), but it
  // can never fail the request — the store swallows its own errors.
  if (tmdbId && !viewerSide) {
    const watchedMs = finite(body.watchedMs, MAX_WATCHED_MS_PER_EVENT);
    await recordSourceFeedback(
      sourceMemoryScope(tmdbId, mediaType, season, episode),
      { ...feedback, watchedMs },
      text(body.label, 80) ?? provider
    );
  }
  return new NextResponse(null, { status: 204 });
}

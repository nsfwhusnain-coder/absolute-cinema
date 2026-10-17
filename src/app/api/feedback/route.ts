import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { withSqliteRetry } from "@/lib/db";
import { logEvent, viewerTag } from "@/lib/event-log";
import { addFeedback, FeedbackRejected } from "@/lib/feedback";
import { RateLimiter } from "@/lib/rate-limit";

/** Pieces of feedback per profile per hour: plenty for a tester, not for a flood. */
const feedbackLimiter = new RateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });

/**
 * POST /api/feedback  { category, message, context? }
 *
 * A tester's note for the admin (Settings → Server → Feedback from viewers),
 * sent from the player's "Report a problem" menu or from Settings. Only a
 * signed-in profile may send one.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!feedbackLimiter.consume(user.id).allowed) {
    return NextResponse.json({ error: "You've sent a lot of feedback this hour. Thank you! Try again later." }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as { category?: unknown; message?: unknown; context?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  try {
    // Two notes sent at the same moment: the one whose write loses the race reads the list again and goes on top.
    const item = await withSqliteRetry(() =>
      addFeedback({ userId: user.id, name: user.name, category: body.category, message: body.message, context: body.context })
    );
    // The account goes in as its tag, and the message not at all: logEvent prints its fields to the container's log too.
    logEvent("user_feedback", {
      viewer: viewerTag(user.id),
      category: item.category,
      length: item.message.length,
      mediaType: item.context?.mediaType,
      tmdbId: item.context?.tmdbId,
    });
    return NextResponse.json({ ok: true, id: item.id });
  } catch (e: unknown) {
    if (e instanceof FeedbackRejected) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[feedback] could not be kept:", e);
    return NextResponse.json({ error: "Could not send your feedback" }, { status: 500 });
  }
}

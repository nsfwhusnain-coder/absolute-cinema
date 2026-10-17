import { NextRequest, NextResponse } from "next/server";
import { checkInvite, normalizeInviteCode } from "@/lib/invites";
import { clientIpFromHeaders } from "@/lib/login-rate-limit";
import { RateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Look-ups per address per minute: an invite link is opened once or twice, never guessed at. */
const lookupLimiter = new RateLimiter({ limit: 30, windowMs: 60_000 });

/**
 * GET /api/invites/<code> → { state: "valid" | "expired" | "used" | "revoked" | "unknown" }
 *
 * Whether an invite link can still create a profile, for the page it opens
 * (/join/<code>). Says nothing else about the invite or the server.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!lookupLimiter.consume(clientIpFromHeaders(req.headers) ?? "unknown").allowed) {
    return NextResponse.json({ error: "Too many look-ups. Try again in a minute." }, { status: 429 });
  }
  const code = normalizeInviteCode((await params).code);
  const state = code ? await checkInvite(code) : "unknown";
  return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
}

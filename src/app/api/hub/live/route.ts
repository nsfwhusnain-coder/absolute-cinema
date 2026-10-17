import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { hubSnapshot } from "@/lib/hub/live-snapshot";

export const dynamic = "force-dynamic";

/** The dashboard's key: HUB_KEY, or the metrics token when no key of its own is set. */
function hubKey(): string | null {
  return process.env.HUB_KEY || process.env.METRICS_TOKEN || null;
}

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GET /api/hub/live — the live dashboard's picture of right now (docs/HUB.md):
 * who watches what, at what quality, what it costs the server, and the
 * machine's load. It names people and what they watch, so it is for the
 * owner: an admin profile's session, or the dashboard's key (`?key=` or a
 * Bearer token) for a screen that is not signed in.
 */
export async function GET(req: NextRequest) {
  const expected = hubKey();
  const given = req.nextUrl.searchParams.get("key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const keyed = Boolean(expected && given && sameKey(given, expected));
  if (!keyed) {
    const user = await getAuthenticatedUser();
    if (!user) return NextResponse.json({ error: "Sign in as the owner, or open the dashboard with its key" }, { status: 401 });
    if (!user.isAdmin) return NextResponse.json({ error: "The dashboard is for the owner's profiles" }, { status: 403 });
  }
  return NextResponse.json(await hubSnapshot(), { headers: { "Cache-Control": "no-store" } });
}

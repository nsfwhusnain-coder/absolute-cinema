import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { clientIpFromHeaders } from "@/lib/login-rate-limit";
import { isRemoteAddress } from "@/lib/playback/network-place";
import { REMUXER_URL, watcherOf } from "@/lib/playback/remuxer";
import { isPublicInstance } from "@/lib/public-instance";

export const dynamic = "force-dynamic";

const SEAT_TIMEOUT_MS = 5_000;
const TICKET = /^[a-f0-9]{24}$/;
const MAX_HEIGHT = 4320;
const MAX_BITRATE_BPS = 400e6;

/**
 * POST /api/capacity/seat  { delivery, height, bitrateBps, ticket?, resume? }
 *
 * Asks for a seat to start a stream (docs/CAPACITY.md). The remuxer's
 * governor answers with a seat, a place in line, or "full". Who is asking,
 * whether they go first (the owner's profiles do) and whether they are outside
 * the home network are added here, never taken from the page.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const height = Number(body.height);
  const bitrate = Number(body.bitrateBps);
  const payload = {
    watcher: watcherOf(user.id),
    priority: user.isAdmin ? 1 : 0,
    delivery: body.delivery === "web" || body.delivery === "direct" ? body.delivery : "remux",
    height: Number.isFinite(height) && height > 0 ? Math.min(MAX_HEIGHT, Math.round(height)) : 0,
    bitrateBps: Number.isFinite(bitrate) && bitrate > 0 ? Math.min(MAX_BITRATE_BPS, Math.round(bitrate)) : 0,
    // A public instance, reached only through a tunnel, has no viewers at home (docs/SHARING.md).
    remote: isPublicInstance() || isRemoteAddress(clientIpFromHeaders(req.headers)),
    ...(typeof body.ticket === "string" && TICKET.test(body.ticket) ? { ticket: body.ticket } : {}),
    resume: body.resume === true,
  };
  const res = await fetch(`${REMUXER_URL}/capacity/seat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEAT_TIMEOUT_MS),
    cache: "no-store",
  }).catch(() => null);
  // No governor to ask (the remuxer is restarting, or remuxing is off): the stream plays. A page that waited for
  // ever on a seat nobody can give would be worse than one extra viewer.
  if (!res || !res.ok) return NextResponse.json({ status: "admitted", seat: null, level: "ok", waitedMs: 0 }, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(await res.json(), { headers: { "Cache-Control": "no-store" } });
}

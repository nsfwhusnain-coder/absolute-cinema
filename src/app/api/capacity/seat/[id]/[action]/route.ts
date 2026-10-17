import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { REMUXER_URL, watcherOf } from "@/lib/playback/remuxer";

export const dynamic = "force-dynamic";

const SEAT_ID = /^[a-f0-9]{24}$/;
const SEAT_TIMEOUT_MS = 3_000;
const MAX_STALLS = 1000;
const MAX_HEIGHT = 4320;
const MAX_BITRATE_BPS = 400e6;

/** The stream the seat is for now, when the page says it changed (another source, another quality). */
function describedStream(value: unknown): { delivery: string; height: number; bitrateBps: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stream = value as Record<string, unknown>;
  const height = Number(stream.height);
  const bitrate = Number(stream.bitrateBps);
  return {
    delivery: stream.delivery === "web" || stream.delivery === "direct" ? stream.delivery : "remux",
    height: Number.isFinite(height) && height > 0 ? Math.min(MAX_HEIGHT, Math.round(height)) : 0,
    bitrateBps: Number.isFinite(bitrate) && bitrate > 0 ? Math.min(MAX_BITRATE_BPS, Math.round(bitrate)) : 0,
  };
}

/**
 * POST /api/capacity/seat/<id>/renew    { stalls, playing } → { status: "active" | "evicted" | "unknown" }
 * POST /api/capacity/seat/<id>/release
 *
 * Keeps a seat (and says when its stream was stopped to protect the server),
 * or gives it back; <id> may also be a place in line. The release is sent as a
 * beacon by a page that is closing.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, action } = await params;
  if (!SEAT_ID.test(id) || (action !== "renew" && action !== "release")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = action === "renew" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const stalls = Number(body.stalls);
  const res = await fetch(`${REMUXER_URL}/capacity/seat/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      watcher: watcherOf(user.id),
      stalls: Number.isFinite(stalls) && stalls > 0 ? Math.min(MAX_STALLS, Math.round(stalls)) : 0,
      playing: body.playing === true,
      ...(describedStream(body.stream) ? { stream: describedStream(body.stream) } : {}),
    }),
    signal: AbortSignal.timeout(SEAT_TIMEOUT_MS),
    cache: "no-store",
  }).catch(() => null);
  if (action === "release") return new Response(null, { status: 204 });
  // Nothing to say (the remuxer is unreachable): the page keeps playing and asks again next time.
  if (!res || !res.ok) return NextResponse.json({ error: "Remuxer unavailable" }, { status: 502 });
  return NextResponse.json(await res.json(), { headers: { "Cache-Control": "no-store" } });
}

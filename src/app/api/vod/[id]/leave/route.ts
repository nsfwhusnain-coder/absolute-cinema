import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { REMUXER_URL } from "@/lib/playback/remuxer";

export const dynamic = "force-dynamic";

const SESSION_ID = /^[a-f0-9]{24}$/;
const LEAVE_TIMEOUT_MS = 2_000;

/** The viewer is done with a remux session: its runs stop reading and give up their places. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!SESSION_ID.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await fetch(`${REMUXER_URL}/vod/${id}/leave`, { method: "POST", signal: AbortSignal.timeout(LEAVE_TIMEOUT_MS) }).catch(() => null);
  return new Response(null, { status: 204 });
}

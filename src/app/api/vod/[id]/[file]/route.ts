import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { REMUXER_URL } from "@/lib/playback/remuxer";

export const dynamic = "force-dynamic";

const SESSION_ID = /^[a-f0-9]{24}$/;
const FILE = /^(index\.m3u8|init\.mp4|\d{1,6}\.m4s)$/;

/** Authenticated pass-through of remuxer playlists and segments (streamed, never buffered). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; file: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, file } = await params;
  if (!SESSION_ID.test(id) || !FILE.test(file)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const upstream = await fetch(`${REMUXER_URL}/vod/${id}/${file}`, { signal: req.signal }).catch(() => null);
  if (!upstream) return NextResponse.json({ error: "Remuxer unavailable" }, { status: 502 });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "no-store",
      ...(upstream.headers.get("content-length") ? { "Content-Length": upstream.headers.get("content-length")! } : {}),
    },
  });
}

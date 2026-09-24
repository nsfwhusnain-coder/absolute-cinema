import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { animeSkipSegments } from "@/lib/playback/skip-times";

/** GET /api/skip-times?tmdbId=&season=&episode= → { segments } (anime only; empty otherwise). */
export async function GET(req: NextRequest) {
  if (!(await getAuthenticatedUserId())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = req.nextUrl.searchParams;
  const tmdbId = Number(params.get("tmdbId"));
  const season = Number(params.get("season"));
  const episode = Number(params.get("episode"));
  if (!tmdbId || !season || !episode) return NextResponse.json({ segments: [] });
  const segments = await animeSkipSegments(tmdbId, season, episode);
  return NextResponse.json({ segments }, { headers: { "Cache-Control": "private, max-age=3600" } });
}

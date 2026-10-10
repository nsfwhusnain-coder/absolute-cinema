import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { fetchSubtitlesForTitle } from "@/lib/subtitles/subtitles-service";

function wholeNumber(raw: string | null, min: number, max: number): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : Number.NaN;
}

export async function GET(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const mediaTypeParam = url.searchParams.get("mediaType");
  const tmdbId = wholeNumber(url.searchParams.get("tmdbId"), 1, 999_999_999);
  const season = wholeNumber(url.searchParams.get("season"), 0, 9_999);
  const episode = wholeNumber(url.searchParams.get("episode"), 0, 99_999);

  if (tmdbId === undefined || !mediaTypeParam) {
    return NextResponse.json({ error: "Missing tmdbId or mediaType" }, { status: 400 });
  }
  if (Number.isNaN(tmdbId) || Number.isNaN(season) || Number.isNaN(episode)) {
    return NextResponse.json({ error: "Invalid tmdbId, season or episode" }, { status: 400 });
  }
  const mediaType = mediaTypeParam === "tv" ? "tv" : "movie";

  const tracks = await fetchSubtitlesForTitle({
    tmdbId,
    mediaType,
    season,
    episode,
  });

  return NextResponse.json(
    { subtitles: tracks },
    { headers: { "Cache-Control": "private, max-age=3600" } }
  );
}

import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { resolveRemuxSourceUrl } from "@/lib/playback/remux-source";
import { REMUXER_URL } from "@/lib/playback/remuxer";

export const dynamic = "force-dynamic";

const OPEN_TIMEOUT_MS = 30_000;
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

/**
 * GET /api/vod/open?type=&id=&sourceId=&ticket=&season=&episode=&startAt=
 *                  &audioPreference=&originalLanguage=&audioLanguage=
 *
 * Opens a seekable video-on-demand remux of an MKV source and returns the
 * playlist URL plus the title's real duration.
 */
export async function GET(req: NextRequest) {
  if (process.env.REMUX_ENABLED === "0") {
    return NextResponse.json({ error: "Remuxing is disabled on this server" }, { status: 503 });
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const type = params.get("type");
  const tmdbId = Number(params.get("id"));
  const sourceId = params.get("sourceId") ?? "";
  if ((type !== "movie" && type !== "tv") || !tmdbId || !sourceId) {
    return NextResponse.json({ error: "Missing type, id or sourceId" }, { status: 400 });
  }
  const optionalInt = (name: string) => {
    const value = Number(params.get(name));
    return params.get(name) && Number.isFinite(value) ? value : undefined;
  };
  const url = await resolveRemuxSourceUrl({
    userId,
    sourceId,
    mediaType: type,
    tmdbId,
    season: optionalInt("season"),
    episode: optionalInt("episode"),
    ticket: params.get("ticket"),
  });
  if (!url) return NextResponse.json({ error: "Source expired" }, { status: 409 });

  const worker = new URLSearchParams({ u: url, startAt: String(Math.max(0, optionalInt("startAt") ?? 0)) });
  const pref = params.get("audioPreference");
  worker.set("audioPreference", pref === "english" || pref === "preferred" ? pref : "original");
  for (const name of ["originalLanguage", "audioLanguage"]) {
    const value = (params.get(name) ?? "").toLowerCase();
    if (LANGUAGE.test(value)) worker.set(name, value);
  }
  const audioIndex = optionalInt("audioIndex");
  if (audioIndex !== undefined && Number.isInteger(audioIndex) && audioIndex >= 0) worker.set("audioIndex", String(audioIndex));

  const res = await fetch(`${REMUXER_URL}/vod/open?${worker}`, { signal: AbortSignal.timeout(OPEN_TIMEOUT_MS) }).catch(
    () => null
  );
  if (!res) return NextResponse.json({ error: "Remuxer unavailable" }, { status: 502 });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    durationS?: number;
    dynamicRange?: string;
    audio?: unknown;
    audioIndex?: number | null;
    audioTracks?: unknown[];
    subtitles?: unknown[];
    error?: string;
  };
  if (!res.ok || !body.id) {
    return NextResponse.json({ error: body.error ?? `remuxer ${res.status}` }, { status: res.status === 415 ? 415 : 502 });
  }
  return NextResponse.json(
    {
      playlistUrl: `/api/vod/${body.id}/index.m3u8`,
      durationS: body.durationS,
      dynamicRange: body.dynamicRange ?? "SDR",
      audio: body.audio ?? null,
      audioIndex: body.audioIndex ?? null,
      audioTracks: body.audioTracks ?? [],
      subtitles: body.subtitles ?? [],
      subtitleBase: `/api/vod/${body.id}/`,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

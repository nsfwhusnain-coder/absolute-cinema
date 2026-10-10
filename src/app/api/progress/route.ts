import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getAuthenticatedUserId } from "@/lib/auth";
import { db, withSqliteRetry } from "@/lib/db";
import { nextEpisodeAfter } from "@/lib/continue-next";

/**
 * Per-user watch progress (continue watching).
 *
 * GET    /api/progress                — Continue Watching (see GET below)
 * POST   /api/progress                — upsert { tmdbId, mediaType, title, poster, backdrop, progress, position, duration, season?, episode?, providerId? }
 * DELETE /api/progress?tmdbId=...&mediaType=...&season=...&episode=... — remove (TV: specific episode when season+episode given)
 */

const MEDIA_TYPES = new Set(["movie", "tv"]);

/** Movies use 0/0 so SQLite UNIQUE has a single stable key per title. */
function resolveSeasonEpisode(
  mediaType: string,
  season?: number | null,
  episode?: number | null
): { season: number; episode: number } | { error: string } {
  if (mediaType === "movie") {
    return { season: 0, episode: 0 };
  }
  if (season == null || episode == null || !Number.isFinite(season) || !Number.isFinite(episode)) {
    return { error: "TV progress requires season and episode" };
  }
  return { season: Number(season), episode: Number(episode) };
}

/** A finished row: the viewer reached the end (or marked it watched). */
const FINISHED = 0.95;
const CONTINUE_LIMIT = 20;

/**
 * GET /api/progress — Continue Watching: one row per title, newest first.
 *   A show whose latest episode was finished comes back as its NEXT episode
 *   (`upNext: true`, progress 0), the way the big services do it, instead of
 *   resurfacing some older half-watched episode. Finished films drop off.
 * GET /api/progress?tmdbId=…&mediaType=tv — every saved episode of one show
 *   (finished ones included), for progress bars and ticks on the episode list.
 */
export async function GET(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const showId = url.searchParams.get("tmdbId");
  if (showId) {
    if (!/^\d{1,9}$/.test(showId)) return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });
    const mediaType = url.searchParams.get("mediaType") === "movie" ? "movie" : "tv";
    const rows = await db.watchProgress.findMany({
      where: { userId, tmdbId: Number(showId), mediaType },
      orderBy: { updatedAt: "desc" },
      select: { season: true, episode: true, progress: true, position: true, duration: true, updatedAt: true },
      take: 2000,
    });
    return NextResponse.json(rows, { headers: { "Cache-Control": "private, no-store" } });
  }

  const items = await db.watchProgress.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const seen = new Set<string>();
  const latest: typeof items = [];
  for (const row of items) {
    const key = row.mediaType === "tv" ? `tv:${row.tmdbId}` : `movie:${row.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
  }

  const collapsed = (
    await Promise.all(
      latest.slice(0, CONTINUE_LIMIT * 2).map(async (row) => {
        // Older rows were saved as "Show · S1E3"; the episode lives in its own columns.
        const clean = { ...row, title: row.title.replace(/ · S\d+E\d+$/, "") };
        if (row.progress < FINISHED) return clean;
        if (row.mediaType !== "tv") return null;
        const next = await nextEpisodeAfter(row.tmdbId, row.season, row.episode);
        if (!next) return null;
        return { ...clean, season: next.season, episode: next.episode, progress: 0, position: 0, duration: 0, upNext: true };
      })
    )
  )
    .filter((row) => row !== null)
    .slice(0, CONTINUE_LIMIT);

  return NextResponse.json(collapsed);
}

export async function POST(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    tmdbId: number;
    mediaType: string;
    title?: string;
    poster?: string | null;
    backdrop?: string | null;
    progress: number;
    position?: number;
    duration?: number;
    season?: number | null;
    episode?: number | null;
    providerId?: string | null;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body?.tmdbId || !body.mediaType || typeof body.progress !== "number" || !Number.isFinite(body.progress)) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (!Number.isInteger(Number(body.tmdbId)) || Number(body.tmdbId) <= 0) {
    return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });
  }

  if (!MEDIA_TYPES.has(body.mediaType)) {
    return NextResponse.json({ error: "mediaType must be movie or tv" }, { status: 400 });
  }

  const resolved = resolveSeasonEpisode(body.mediaType, body.season, body.episode);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  if (typeof body.title !== "string" || !body.title.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  if (body.duration == null || !Number.isFinite(body.duration) || body.duration <= 0) {
    return NextResponse.json({ error: "duration is required" }, { status: 400 });
  }

  const progress = Math.min(1, Math.max(0, body.progress));
  const tmdbId = Number(body.tmdbId);

  try {
    const item = await withSqliteRetry(async () => {
      return await db.watchProgress.upsert({
        where: {
          userId_tmdbId_mediaType_season_episode: {
            userId,
            tmdbId,
            mediaType: body.mediaType,
            season: resolved.season,
            episode: resolved.episode,
          },
        },
        update: {
          title: body.title ?? "",
          poster: body.poster ?? null,
          backdrop: body.backdrop ?? null,
          progress,
          position: body.position ?? 0,
          duration: body.duration ?? 0,
          providerId: body.providerId ?? null,
        },
        create: {
          userId,
          tmdbId,
          mediaType: body.mediaType,
          title: body.title ?? "",
          poster: body.poster ?? null,
          backdrop: body.backdrop ?? null,
          progress,
          position: body.position ?? 0,
          duration: body.duration ?? 0,
          season: resolved.season,
          episode: resolved.episode,
          providerId: body.providerId ?? null,
        },
      });
    });

    return NextResponse.json(item);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      return NextResponse.json({ error: "Session expired — please sign in again" }, { status: 401 });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tmdbId = url.searchParams.get("tmdbId");
  const mediaType = url.searchParams.get("mediaType");
  const seasonParam = url.searchParams.get("season");
  const episodeParam = url.searchParams.get("episode");

  if (!tmdbId || !mediaType) {
    return NextResponse.json({ error: "Missing tmdbId or mediaType" }, { status: 400 });
  }

  if (!MEDIA_TYPES.has(mediaType)) {
    return NextResponse.json({ error: "mediaType must be movie or tv" }, { status: 400 });
  }
  if (!/^\d{1,9}$/.test(tmdbId)) {
    return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });
  }

  const baseWhere = { userId, tmdbId: Number(tmdbId), mediaType };

  await withSqliteRetry(async () => {
    if (mediaType === "movie") {
      await db.watchProgress.deleteMany({
        where: { ...baseWhere, season: 0, episode: 0 },
      });
    } else if (seasonParam != null && episodeParam != null) {
      await db.watchProgress.deleteMany({
        where: {
          ...baseWhere,
          season: Number(seasonParam),
          episode: Number(episodeParam),
        },
      });
    } else {
      await db.watchProgress.deleteMany({ where: baseWhere });
    }
  });

  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { cachedTmdbRoute, pageNumber } from "@/lib/tmdb-route";

/**
 * Generic TMDB proxy. Lets us call TMDB from the client without exposing the API key.
 *
 * Usage:
 *   GET /api/tmdb/trending/movie/week
 *   GET /api/tmdb/movie/550?append_to_response=credits,videos
 *   GET /api/tmdb/search/movie?query=inception
 */
const MAX_QUERY_LENGTH = 200;
const POSITIVE_ID = /^\d{1,9}$/;

/** Upstream statuses the client can act on; the rest are the server's problem. */
function statusFor(e: unknown): number {
  const status = (e as { status?: number })?.status;
  if (status === 404) return 404;
  if (status === 400 || status === 414 || status === 422) return 400;
  if (status === 429) return 503;
  return 500;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await ctx.params;
  if (!path?.length) return NextResponse.json({ error: "Missing path" }, { status: 400 });

  const url = new URL(_req.url);
  const params: Record<string, string | number | boolean> = {};
  url.searchParams.forEach((v, k) => {
    if (k === "XTransformPort") return;
    params[k] = v;
  });
  if (params.page !== undefined) params.page = pageNumber(params.page);
  if (typeof params.query === "string") {
    params.query = params.query.trim().slice(0, MAX_QUERY_LENGTH);
    if (!params.query) return NextResponse.json({ page: 1, results: [], total_pages: 0, total_results: 0 });
  }
  // Ids and season numbers are digits; anything else is a bad request, not a
  // TMDB call that fails as a 500 (or quietly becomes season 0).
  const idSegment = ["movie", "tv", "person", "collection"].includes(path[0]!) ? path[1] : undefined;
  if (idSegment && !["popular", "top_rated", "upcoming", "now_playing", "airing_today", "on_the_air"].includes(idSegment) && !POSITIVE_ID.test(idSegment)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  if (path[0] === "tv" && path[2] === "season" && !/^\d{1,4}$/.test(path[3] ?? "")) {
    return NextResponse.json({ error: "Invalid season" }, { status: 400 });
  }

  try {
    const data = await cachedTmdbRoute(path, params);

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "private, max-age=300, stale-while-revalidate=21600",
        "X-Catalog-Cache": "SWR",
      },
    });
  } catch (e: unknown) {
    const status = statusFor(e);
    const message =
      status === 404 ? "Not found" : status === 400 ? "Bad request" : status === 503 ? "TMDB is busy, try again shortly" : "TMDB request failed";
    return NextResponse.json({ error: message }, { status });
  }
}
import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { loadHomeFeed } from "@/lib/home-feed";

/**
 * GET /api/home — everything the Home page's first screens need, in one
 * response: the banner pool and the six catalog rails.
 *
 * Home used to make about twenty /api/tmdb requests for these (three pages of
 * each list, week and day trending). Over HTTP/1.1 a browser runs six at a
 * time, so from outside the house (150 ms away) the rails waited on four
 * round trips before the first card. The lists come from the same cache the
 * proxy uses, so this is usually all cache hits on the server.
 */
export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await loadHomeFeed(), { headers: { "Cache-Control": "private, max-age=300" } });
}

import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { OPERATOR_TMDB_ENV, OPERATOR_TMDB_SETTING_KEY } from "@/lib/operator-keys";
import { getEffectiveRealDebridToken } from "@/lib/debrid-credentials";
import { validateTmdbKey } from "@/lib/tmdb";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * First-run status for the setup wizard.
 *
 * GET  /api/setup  → { tmdb, realDebrid, isAdmin } (booleans only, never keys)
 * POST /api/setup  → { tmdbKey }  validate against TMDB, then save (admin only)
 */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const setting = await db.appSetting.findUnique({ where: { key: OPERATOR_TMDB_SETTING_KEY } });
  const rd = await getEffectiveRealDebridToken();
  return NextResponse.json(
    {
      tmdb: Boolean(setting?.value || process.env[OPERATOR_TMDB_ENV]),
      realDebrid: rd.source !== "none",
      isAdmin: user.isAdmin,
    },
    { headers: NO_STORE },
  );
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { tmdbKey?: unknown };
  const key = typeof body.tmdbKey === "string" ? body.tmdbKey.trim() : "";
  if (!key) return NextResponse.json({ error: "Enter your TMDB API key." }, { status: 400 });

  const check = await validateTmdbKey(key);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  await db.appSetting.upsert({
    where: { key: OPERATOR_TMDB_SETTING_KEY },
    update: { value: key },
    create: { key: OPERATOR_TMDB_SETTING_KEY, value: key },
  });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

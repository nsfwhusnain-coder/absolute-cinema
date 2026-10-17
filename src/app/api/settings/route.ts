import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { DEFAULT_PROVIDER_ID, listProviders } from "@/lib/playback";
import { FLAG_DEFAULTS, invalidateAppFlag } from "@/lib/feature-flags";
import { PROFILE_PICKER_SETTING, profilePickerEnabled, REQUIRE_PIN_SETTING, requirePin, SIGNUPS_OPEN_SETTING, signupsOpen } from "@/lib/profiles";
import { INVITES_SETTING } from "@/lib/invites";
import { FEEDBACK_SETTING } from "@/lib/feedback";

/**
 * Server-wide settings (TMDB API key override, playback provider, profiles, flags).
 *
 * GET    /api/settings          — read all settings (admin sees full, user sees redacted)
 * POST   /api/settings          — update settings (admin only)
 *   body: { tmdb_api_key?, playback_provider?, signups_open?, profile_picker?, require_pin?,
 *           flag_ui_bottom_nav?, flag_ui_hubs?, flag_playback_fast_path? }
 */

const ADMIN_ONLY_KEYS = ["tmdb_api_key"]; // not exposed to non-admins

// Secrets that must NEVER be serialized to any client, admin included. The
// Real-Debrid token is managed via /api/debrid/status and only ever leaves the
// server as account metadata, never as the raw token.
const SECRET_KEYS = ["realdebrid_token"];

// Kept by their own routes, not shown as settings (the invite list: /api/admin/invites; the feedback: /api/admin/feedback).
const INTERNAL_KEYS = [INVITES_SETTING, FEEDBACK_SETTING];

const FLAG_KEYS = Object.keys(FLAG_DEFAULTS);

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await db.appSetting.findMany();
  const out: Record<string, string> = {};
  for (const s of settings) {
    if (SECRET_KEYS.includes(s.key) || INTERNAL_KEYS.includes(s.key)) {
      continue; // never leaves the server, or is not a setting
    }
    if (ADMIN_ONLY_KEYS.includes(s.key)) {
      // Admins see that a key exists (last 4 chars), never the key itself.
      if (user.isAdmin && s.value) out[s.key] = `…${s.value.slice(-4)}`;
      continue;
    }
    out[s.key] = s.value;
  }
  if (!out.playback_provider) out.playback_provider = DEFAULT_PROVIDER_ID;
  // The profile switches as they stand, whether chosen here or defaulted by the environment.
  out[SIGNUPS_OPEN_SETTING] ??= (await signupsOpen()) ? "on" : "off";
  out[PROFILE_PICKER_SETTING] ??= (await profilePickerEnabled()) ? "on" : "off";
  out[REQUIRE_PIN_SETTING] ??= (await requirePin()) ? "on" : "off";
  for (const [key, def] of Object.entries(FLAG_DEFAULTS)) {
    if (!out[key]) out[key] = def;
  }

  const status = {
    tmdb: !!out.tmdb_api_key || !!process.env.TMDB_API_KEY,
    playbackProvider: out.playback_provider,
  };

  // Non-admins only ever need their own playback prefs + flags. The provider
  // registry and server status stay admin-only — this used to ship the full
  // payload (including providers + status) to every signed-in user.
  if (!user.isAdmin) {
    const nonAdminKeys = ["playback_provider", ...FLAG_KEYS];
    for (const key of Object.keys(out)) {
      if (!nonAdminKeys.includes(key)) delete out[key];
    }
    return NextResponse.json({
      settings: out,
      status: { tmdb: false, playbackProvider: out.playback_provider },
      isAdmin: false,
      providers: [],
    });
  }

  return NextResponse.json({ settings: out, status, isAdmin: true, providers: listProviders() });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  let body: Record<string, string | undefined>;
  try {
    body = (await req.json()) as Record<string, string | undefined>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const allowed = ["tmdb_api_key", "playback_provider", SIGNUPS_OPEN_SETTING, PROFILE_PICKER_SETTING, REQUIRE_PIN_SETTING, ...FLAG_KEYS];

  for (const key of allowed) {
    const val = body[key];
    if (val === undefined) continue; // not provided — don't touch
    if (typeof val !== "string") return NextResponse.json({ error: `${key} must be text` }, { status: 400 });
    if (val === "") {
      // clear
      await db.appSetting.deleteMany({ where: { key } });
    } else {
      await db.appSetting.upsert({
        where: { key },
        update: { value: val },
        create: { key, value: val },
      });
    }
    if (key.startsWith("flag_")) invalidateAppFlag(key);
  }

  return NextResponse.json({ ok: true });
}

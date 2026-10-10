import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import {
  normalizeAudioLanguage,
  parseAudioPreference,
  parseFourKStartupPreference,
  parsePlaybackQualityPreference,
  parseSubtitlePreference,
} from "@/lib/profile-preferences";
import {
  getHideAdultPreference,
  getProfileExtras,
  getUserPlaybackPreferences,
  saveHideAdultPreference,
  saveProfileExtraRows,
  saveUserPlaybackPreferences,
} from "@/lib/profile-preferences.server";
import { extrasPatch } from "@/lib/profile-extras";

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [preferences, hideAdult, extras] = await Promise.all([
    getUserPlaybackPreferences(userId),
    getHideAdultPreference(userId),
    getProfileExtras(userId),
  ]);
  return NextResponse.json(
    { ...preferences, hideAdult, ...extras },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function PATCH(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    playbackQuality?: unknown;
    audioLanguage?: unknown;
    audioPreference?: unknown;
    subtitlePreference?: unknown;
    fourKStartup?: unknown;
    hideAdult?: unknown;
  } & Record<string, unknown>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // Look and behaviour extras are validated before anything is written.
  const extraRows = extrasPatch(body);
  if ("invalid" in extraRows) {
    return NextResponse.json({ error: `The ${extraRows.invalid} preference is invalid.` }, { status: 400 });
  }

  // Partial update: any field left out keeps its saved value.
  const current = await getUserPlaybackPreferences(userId);
  const pick = <T,>(value: unknown, parse: (v: unknown) => T | null, fallback: T): T | null =>
    value === undefined ? fallback : parse(value);
  const playbackQuality = pick(body.playbackQuality, parsePlaybackQualityPreference, current.playbackQuality);
  const audioLanguage = pick(body.audioLanguage, normalizeAudioLanguage, current.audioLanguage);
  const audioPreference = pick(body.audioPreference, parseAudioPreference, current.audioPreference);
  const subtitlePreference = pick(body.subtitlePreference, parseSubtitlePreference, current.subtitlePreference);
  const fourKStartup = pick(body.fourKStartup, parseFourKStartupPreference, current.fourKStartup);
  if (
    playbackQuality == null ||
    audioLanguage == null ||
    audioPreference == null ||
    subtitlePreference == null ||
    fourKStartup == null
  ) {
    return NextResponse.json({ error: "One of the preferences is invalid." }, { status: 400 });
  }

  const preferences = {
    playbackQuality,
    audioLanguage,
    audioPreference,
    subtitlePreference,
    fourKStartup,
  };
  await saveUserPlaybackPreferences(userId, preferences);
  if (typeof body.hideAdult === "boolean") {
    await saveHideAdultPreference(userId, body.hideAdult);
  }
  await saveProfileExtraRows(userId, extraRows.rows);
  const [hideAdult, extras] = await Promise.all([
    typeof body.hideAdult === "boolean" ? body.hideAdult : getHideAdultPreference(userId),
    getProfileExtras(userId),
  ]);
  return NextResponse.json(
    { ...preferences, hideAdult, ...extras },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

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
  parseAccent,
  parseMaterial,
  saveHideAdultPreference,
  saveProfileExtras,
  saveUserPlaybackPreferences,
} from "@/lib/profile-preferences.server";

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
    material?: unknown;
    accent?: unknown;
    autoplayNext?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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
  const material = body.material === undefined ? undefined : parseMaterial(body.material);
  const accent = body.accent === undefined ? undefined : parseAccent(body.accent);
  if (material === null || accent === null) {
    return NextResponse.json({ error: "Unknown theme or accent." }, { status: 400 });
  }
  await saveProfileExtras(userId, {
    ...(material ? { material } : {}),
    ...(accent ? { accent } : {}),
    ...(typeof body.autoplayNext === "boolean" ? { autoplayNext: body.autoplayNext } : {}),
  });
  const [hideAdult, extras] = await Promise.all([
    typeof body.hideAdult === "boolean" ? body.hideAdult : getHideAdultPreference(userId),
    getProfileExtras(userId),
  ]);
  return NextResponse.json(
    { ...preferences, hideAdult, ...extras },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

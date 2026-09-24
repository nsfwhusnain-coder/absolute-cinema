import "server-only";
import { db } from "@/lib/db";
import {
  AUDIO_PREFERENCE_SETTING_KEY,
  AUDIO_LANGUAGE_SETTING_KEY,
  DEFAULT_PROFILE_PLAYBACK_PREFERENCES,
  FOUR_K_STARTUP_SETTING_KEY,
  HIDE_ADULT_SETTING_KEY,
  PLAYBACK_QUALITY_SETTING_KEY,
  SUBTITLE_PREFERENCE_SETTING_KEY,
  normalizeAudioLanguage,
  parseAudioPreference,
  parseFourKStartupPreference,
  parseHideAdultPreference,
  parsePlaybackQualityPreference,
  parseSubtitlePreference,
  type ProfilePlaybackPreferences,
} from "@/lib/profile-preferences";
import { ACCENTS, DEFAULT_ACCENT, DEFAULT_MATERIAL, type AccentId, type Material } from "@/lib/appearance";

export async function getUserPlaybackPreferences(
  userId: string
): Promise<ProfilePlaybackPreferences> {
  const rows = await db.userSetting.findMany({
    where: {
      userId,
      key: {
        in: [
          PLAYBACK_QUALITY_SETTING_KEY,
          AUDIO_LANGUAGE_SETTING_KEY,
          AUDIO_PREFERENCE_SETTING_KEY,
          SUBTITLE_PREFERENCE_SETTING_KEY,
          FOUR_K_STARTUP_SETTING_KEY,
        ],
      },
    },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    playbackQuality:
      parsePlaybackQualityPreference(values.get(PLAYBACK_QUALITY_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality,
    audioLanguage:
      normalizeAudioLanguage(values.get(AUDIO_LANGUAGE_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioLanguage,
    audioPreference:
      parseAudioPreference(values.get(AUDIO_PREFERENCE_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioPreference,
    subtitlePreference:
      parseSubtitlePreference(values.get(SUBTITLE_PREFERENCE_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.subtitlePreference,
    fourKStartup:
      parseFourKStartupPreference(values.get(FOUR_K_STARTUP_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup,
  };
}

export async function saveUserPlaybackPreferences(
  userId: string,
  preferences: ProfilePlaybackPreferences
): Promise<void> {
  await db.$transaction([
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: PLAYBACK_QUALITY_SETTING_KEY },
      },
      update: { value: String(preferences.playbackQuality) },
      create: {
        userId,
        key: PLAYBACK_QUALITY_SETTING_KEY,
        value: String(preferences.playbackQuality),
      },
    }),
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: AUDIO_LANGUAGE_SETTING_KEY },
      },
      update: { value: preferences.audioLanguage },
      create: {
        userId,
        key: AUDIO_LANGUAGE_SETTING_KEY,
        value: preferences.audioLanguage,
      },
    }),
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: AUDIO_PREFERENCE_SETTING_KEY },
      },
      update: { value: preferences.audioPreference },
      create: {
        userId,
        key: AUDIO_PREFERENCE_SETTING_KEY,
        value: preferences.audioPreference,
      },
    }),
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: SUBTITLE_PREFERENCE_SETTING_KEY },
      },
      update: { value: preferences.subtitlePreference },
      create: {
        userId,
        key: SUBTITLE_PREFERENCE_SETTING_KEY,
        value: preferences.subtitlePreference,
      },
    }),
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: FOUR_K_STARTUP_SETTING_KEY },
      },
      update: { value: preferences.fourKStartup },
      create: {
        userId,
        key: FOUR_K_STARTUP_SETTING_KEY,
        value: preferences.fourKStartup,
      },
    }),
  ]);
}

export async function getHideAdultPreference(userId: string): Promise<boolean> {
  const row = await db.userSetting.findUnique({
    where: { userId_key: { userId, key: HIDE_ADULT_SETTING_KEY } },
    select: { value: true },
  });
  return parseHideAdultPreference(row?.value);
}

export async function saveHideAdultPreference(
  userId: string,
  hideAdult: boolean
): Promise<void> {
  await db.userSetting.upsert({
    where: { userId_key: { userId, key: HIDE_ADULT_SETTING_KEY } },
    update: { value: hideAdult ? "on" : "off" },
    create: { userId, key: HIDE_ADULT_SETTING_KEY, value: hideAdult ? "on" : "off" },
  });
}

const MATERIAL_SETTING_KEY = "appearance_material";
const ACCENT_SETTING_KEY = "appearance_accent";
const AUTOPLAY_NEXT_SETTING_KEY = "autoplay_next";
const CAPTION_SIZE_SETTING_KEY = "caption_size";
const CAPTION_BACKGROUND_SETTING_KEY = "caption_background";

export type CaptionSize = "small" | "medium" | "large";
export type CaptionBackground = "box" | "shadow";

export function parseCaptionSize(value: unknown): CaptionSize | null {
  return value === "small" || value === "medium" || value === "large" ? value : null;
}

export function parseCaptionBackground(value: unknown): CaptionBackground | null {
  return value === "box" || value === "shadow" ? value : null;
}

/** Per-profile look and small behaviour choices that follow the profile to every device. */
export interface ProfileExtras {
  material: Material;
  accent: AccentId;
  autoplayNext: boolean;
  captionSize: CaptionSize;
  captionBackground: CaptionBackground;
}

export function parseMaterial(value: unknown): Material | null {
  return value === "clear" || value === "solid" ? value : null;
}

export function parseAccent(value: unknown): AccentId | null {
  return ACCENTS.some((a) => a.id === value) ? (value as AccentId) : null;
}

export async function getProfileExtras(userId: string): Promise<ProfileExtras> {
  const rows = await db.userSetting.findMany({
    where: {
      userId,
      key: { in: [MATERIAL_SETTING_KEY, ACCENT_SETTING_KEY, AUTOPLAY_NEXT_SETTING_KEY, CAPTION_SIZE_SETTING_KEY, CAPTION_BACKGROUND_SETTING_KEY] },
    },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    material: parseMaterial(values.get(MATERIAL_SETTING_KEY)) ?? DEFAULT_MATERIAL,
    accent: parseAccent(values.get(ACCENT_SETTING_KEY)) ?? DEFAULT_ACCENT,
    autoplayNext: values.get(AUTOPLAY_NEXT_SETTING_KEY) !== "off",
    captionSize: parseCaptionSize(values.get(CAPTION_SIZE_SETTING_KEY)) ?? "medium",
    captionBackground: parseCaptionBackground(values.get(CAPTION_BACKGROUND_SETTING_KEY)) ?? "box",
  };
}

export async function saveProfileExtras(userId: string, patch: Partial<ProfileExtras>): Promise<void> {
  const writes: Array<[string, string]> = [];
  if (patch.material) writes.push([MATERIAL_SETTING_KEY, patch.material]);
  if (patch.accent) writes.push([ACCENT_SETTING_KEY, patch.accent]);
  if (patch.autoplayNext !== undefined) writes.push([AUTOPLAY_NEXT_SETTING_KEY, patch.autoplayNext ? "on" : "off"]);
  if (patch.captionSize) writes.push([CAPTION_SIZE_SETTING_KEY, patch.captionSize]);
  if (patch.captionBackground) writes.push([CAPTION_BACKGROUND_SETTING_KEY, patch.captionBackground]);
  await db.$transaction(
    writes.map(([key, value]) =>
      db.userSetting.upsert({
        where: { userId_key: { userId, key } },
        update: { value },
        create: { userId, key, value },
      })
    )
  );
}

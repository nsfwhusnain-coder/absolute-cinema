import {
  DEFAULT_PROFILE_PLAYBACK_PREFERENCES,
  normalizeAudioLanguage,
  parseAudioPreference,
  parseFourKStartupPreference,
  parsePlaybackQualityPreference,
  parseSubtitlePreference,
  playbackDiscoveryPreferenceKey,
  type AudioPreference,
  type FourKStartupPreference,
  type PlaybackQualityPreference,
  type ProfilePlaybackPreferences,
  type SubtitlePreference,
} from "@/lib/profile-preferences";

const PREFERRED_PROVIDER_KEY = "absolute-cinema:preferred-provider";
const PREFERRED_QUALITY_KEY = "absolute-cinema:preferred-quality";
const PLAYBACK_SPEED_KEY = "absolute-cinema:playback-speed";
const PREFERRED_AUDIO_LANG_KEY = "absolute-cinema:audio-lang";
const AUDIO_PREFERENCE_KEY = "absolute-cinema:audio-preference";
const SUBTITLE_PREFERENCE_KEY = "absolute-cinema:subtitle-preference";
const FOUR_K_STARTUP_KEY = "absolute-cinema:four-k-startup";
const AUTOPLAY_NEXT_KEY = "absolute-cinema:autoplay-next";

/**
 * Default stream preference key.
 * Empty → pure probe/rank pick (Aether/Horizon/Solstice beat Luna).
 * Avoid baking "Luna" here — it was stranding users on the slow CDN.
 */
export const DEFAULT_SOURCE_KEY = "";

export function getPreferredProvider(): string {
  if (typeof window === "undefined") return DEFAULT_SOURCE_KEY;
  return localStorage.getItem(PREFERRED_PROVIDER_KEY) || DEFAULT_SOURCE_KEY;
}

export function setPreferredProvider(provider: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PREFERRED_PROVIDER_KEY, provider);
}

/**
 * Preferred height in pixels (e.g. 1080, 2160) or auto.
 * Product rule: **1080p minimum** — never return a preference below 1080.
 * "auto" = ABR among 1080 / 4K only (player enforces floor).
 */
export function getPreferredQualityHeight(): PlaybackQualityPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality;
  }
  const raw = localStorage.getItem(PREFERRED_QUALITY_KEY);
  return (
    parsePlaybackQualityPreference(raw) ??
    DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality
  );
}

export function setPreferredQualityHeight(height: PlaybackQualityPreference): void {
  if (typeof window === "undefined") return;
  const normalized = parsePlaybackQualityPreference(height);
  localStorage.setItem(
    PREFERRED_QUALITY_KEY,
    String(normalized ?? DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality)
  );
}

export function getSavedPlaybackSpeed(): number {
  if (typeof window === "undefined") return 1;
  const raw = localStorage.getItem(PLAYBACK_SPEED_KEY);
  const n = raw ? Number(raw) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function setSavedPlaybackSpeed(speed: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PLAYBACK_SPEED_KEY, String(speed));
}

/** Start the next episode automatically when one ends (per device, default on). */
export function getAutoplayNext(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(AUTOPLAY_NEXT_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAutoplayNext(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AUTOPLAY_NEXT_KEY, enabled ? "on" : "off");
  } catch {
    /* private mode: the default stays in effect */
  }
}

export const DEFAULT_AUDIO_LANGUAGE = "en";

export function getPreferredAudioLanguage(): string {
  if (typeof window === "undefined") return DEFAULT_AUDIO_LANGUAGE;
  return (
    normalizeAudioLanguage(localStorage.getItem(PREFERRED_AUDIO_LANG_KEY)) ||
    DEFAULT_AUDIO_LANGUAGE
  );
}

export function setPreferredAudioLanguage(lang: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    PREFERRED_AUDIO_LANG_KEY,
    normalizeAudioLanguage(lang) || DEFAULT_AUDIO_LANGUAGE
  );
}

export function getAudioPreference(): AudioPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioPreference;
  }
  return (
    parseAudioPreference(localStorage.getItem(AUDIO_PREFERENCE_KEY)) ??
    DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioPreference
  );
}

export function setAudioPreference(preference: AudioPreference): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    AUDIO_PREFERENCE_KEY,
    parseAudioPreference(preference) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioPreference
  );
}

export function getSubtitlePreference(): SubtitlePreference {
  if (typeof window === "undefined") {
    return DEFAULT_PROFILE_PLAYBACK_PREFERENCES.subtitlePreference;
  }
  return (
    parseSubtitlePreference(localStorage.getItem(SUBTITLE_PREFERENCE_KEY)) ??
    DEFAULT_PROFILE_PLAYBACK_PREFERENCES.subtitlePreference
  );
}

export function setSubtitlePreference(preference: SubtitlePreference): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    SUBTITLE_PREFERENCE_KEY,
    parseSubtitlePreference(preference) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.subtitlePreference
  );
}

export function getFourKStartupPreference(): FourKStartupPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup;
  }
  return (
    parseFourKStartupPreference(localStorage.getItem(FOUR_K_STARTUP_KEY)) ??
    DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup
  );
}

export function getPlaybackDiscoveryPreferenceKey(): string {
  try {
    return playbackDiscoveryPreferenceKey(
      getPreferredQualityHeight(),
      getFourKStartupPreference()
    );
  } catch {
    return playbackDiscoveryPreferenceKey(
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality,
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup
    );
  }
}

export function setFourKStartupPreference(
  preference: FourKStartupPreference
): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    FOUR_K_STARTUP_KEY,
    parseFourKStartupPreference(preference) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup
  );
}

/** Hydrate the low-latency browser cache from the authenticated profile API. */
export function syncProfilePlaybackPreferences(
  preferences: ProfilePlaybackPreferences
): void {
  setPreferredQualityHeight(preferences.playbackQuality);
  setPreferredAudioLanguage(preferences.audioLanguage);
  setAudioPreference(preferences.audioPreference);
  setSubtitlePreference(preferences.subtitlePreference);
  setFourKStartupPreference(preferences.fourKStartup);
}

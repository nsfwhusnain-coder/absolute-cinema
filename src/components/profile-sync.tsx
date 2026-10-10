"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { signOut, useSession } from "next-auth/react";
import { applyAccent, applyMaterial, applyUiScale, currentAccent, currentMaterial } from "@/lib/appearance";
import { UI_SCALE_PERCENT } from "@/lib/profile-extras";
import { PREFERENCES_QUERY_KEY, fetchPreferences, isSignedOutError } from "@/lib/preferences-client";
import { setAutoplayNext, syncProfilePlaybackPreferences } from "@/lib/player-preferences";

/**
 * Device-local data that belongs to one profile: recent searches, the
 * "already watched" list and per-show audio/subtitle choices. On a shared
 * browser each profile gets its own copy, so switching profile never shows
 * someone else's searches or history (a PIN-locked profile's included).
 */
const PROFILE_PRIVATE_KEYS = [
  "absolute-cinema:search-recents",
  "absolute-cinema:watched",
  "absolute-cinema:title-language",
];
const DEVICE_OWNER_KEY = "absolute-cinema:device-profile";

/** Puts the previous profile's private data aside and brings back this profile's. */
export function swapProfilePrivateData(storage: Storage, profileId: string): void {
  const owner = storage.getItem(DEVICE_OWNER_KEY);
  if (owner === profileId) return;
  for (const key of PROFILE_PRIVATE_KEYS) {
    const current = storage.getItem(key);
    if (owner && current != null) storage.setItem(`${key}@${owner}`, current);
    const mine = storage.getItem(`${key}@${profileId}`);
    if (mine != null) storage.setItem(key, mine);
    else if (owner) storage.removeItem(key);
    storage.removeItem(`${key}@${profileId}`);
  }
  storage.setItem(DEVICE_OWNER_KEY, profileId);
}

/**
 * Applies the signed-in profile's saved look and playback choices on whatever
 * device it opens on. The device keeps a copy so the next page load paints in
 * the right theme before this runs.
 */
export function ProfileSync() {
  const { status, data: session } = useSession();
  const profileId = session?.user?.id;
  useEffect(() => {
    if (!profileId) return;
    try {
      swapProfilePrivateData(window.localStorage, profileId);
    } catch {
      /* storage unavailable (private mode): nothing is kept, so nothing can leak */
    }
  }, [profileId]);
  const { data, error } = useQuery({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: fetchPreferences,
    enabled: status === "authenticated",
    staleTime: 5 * 60_000,
  });

  // A session for a profile the server no longer has: every page would sit on
  // its loading state for good (the player on its loader). End the session, so
  // the viewer lands on the profile picker instead.
  const sessionDead = status === "authenticated" && isSignedOutError(error);
  useEffect(() => {
    if (sessionDead) void signOut({ callbackUrl: "/login" });
  }, [sessionDead]);

  useEffect(() => {
    if (!data) return;
    if (data.material !== currentMaterial()) applyMaterial(data.material);
    if (data.accent !== currentAccent()) applyAccent(data.accent);
    applyUiScale(UI_SCALE_PERCENT[data.uiScale] ?? 100);
    setAutoplayNext(data.autoplayNext);
    syncProfilePlaybackPreferences(data);
  }, [data]);

  return null;
}

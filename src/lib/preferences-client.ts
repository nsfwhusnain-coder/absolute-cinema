"use client";

import type { AccentId, Material } from "@/lib/appearance";
import type { ProfilePlaybackPreferences } from "@/lib/profile-preferences";

/** Everything /api/preferences returns for the signed-in profile. */
export interface ProfilePreferences extends ProfilePlaybackPreferences {
  hideAdult: boolean;
  material: Material;
  accent: AccentId;
  autoplayNext: boolean;
  captionSize: "small" | "medium" | "large";
  captionBackground: "box" | "shadow";
}

export const PREFERENCES_QUERY_KEY = ["profile-preferences"] as const;

export async function fetchPreferences(): Promise<ProfilePreferences> {
  const res = await fetch("/api/preferences", { cache: "no-store" });
  const json = (await res.json()) as ProfilePreferences & { error?: string };
  if (!res.ok) throw new Error(json.error || "Could not load preferences");
  return json;
}

export async function patchPreferences(patch: Partial<Record<keyof ProfilePreferences, unknown>>): Promise<ProfilePreferences> {
  const res = await fetch("/api/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const json = (await res.json()) as ProfilePreferences & { error?: string };
  if (!res.ok) throw new Error(json.error || "Could not save");
  return json;
}

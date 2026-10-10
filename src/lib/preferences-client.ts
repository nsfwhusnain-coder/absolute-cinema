"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ProfilePlaybackPreferences } from "@/lib/profile-preferences";
import type { ProfileExtras } from "@/lib/profile-extras";

/** Everything /api/preferences returns for the signed-in profile. */
export interface ProfilePreferences extends ProfilePlaybackPreferences, ProfileExtras {
  hideAdult: boolean;
}

export const PREFERENCES_QUERY_KEY = ["profile-preferences"] as const;

const UNAUTHORIZED = 401;

/** A failed preferences request, with the status the server answered. */
export class PreferencesError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/**
 * True when the server no longer knows the signed-in profile: it was deleted
 * on another device, or the database was restored from before it existed. The
 * browser still holds a session that reads as valid, so every request fails.
 */
export function isSignedOutError(error: unknown): boolean {
  return error instanceof PreferencesError && error.status === UNAUTHORIZED;
}

export async function fetchPreferences(): Promise<ProfilePreferences> {
  const res = await fetch("/api/preferences", { cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as ProfilePreferences & { error?: string };
  if (!res.ok) throw new PreferencesError(json.error || "Could not load preferences", res.status);
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

/**
 * The profile's preferences plus an optimistic `save`: the change shows at
 * once, is sent to the server, and is rolled back with a message if it fails.
 */
export function useProfilePreferences() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: PREFERENCES_QUERY_KEY, queryFn: fetchPreferences, staleTime: 5 * 60_000 });
  const save = useCallback(
    async (patch: Partial<ProfilePreferences>): Promise<ProfilePreferences | null> => {
      const previous = qc.getQueryData<ProfilePreferences>(PREFERENCES_QUERY_KEY);
      if (previous) qc.setQueryData<ProfilePreferences>(PREFERENCES_QUERY_KEY, { ...previous, ...patch });
      try {
        const next = await patchPreferences(patch);
        qc.setQueryData(PREFERENCES_QUERY_KEY, next);
        return next;
      } catch (err) {
        if (previous) qc.setQueryData(PREFERENCES_QUERY_KEY, previous);
        toast.error(err instanceof Error ? err.message : "Could not save");
        return null;
      }
    },
    [qc]
  );
  return { data: query.data, save };
}

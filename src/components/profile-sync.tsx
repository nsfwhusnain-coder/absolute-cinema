"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { applyAccent, applyMaterial, currentAccent, currentMaterial } from "@/lib/appearance";
import { PREFERENCES_QUERY_KEY, fetchPreferences } from "@/lib/preferences-client";
import { setAutoplayNext, syncProfilePlaybackPreferences } from "@/lib/player-preferences";

/**
 * Applies the signed-in profile's saved look and playback choices on whatever
 * device it opens on. The device keeps a copy so the next page load paints in
 * the right theme before this runs.
 */
export function ProfileSync() {
  const { status } = useSession();
  const { data } = useQuery({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: fetchPreferences,
    enabled: status === "authenticated",
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!data) return;
    if (data.material !== currentMaterial()) applyMaterial(data.material);
    if (data.accent !== currentAccent()) applyAccent(data.accent);
    setAutoplayNext(data.autoplayNext);
    syncProfilePlaybackPreferences(data);
  }, [data]);

  return null;
}

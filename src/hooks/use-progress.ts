"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signOut, useSession } from "next-auth/react";
import { useMemo, useRef } from "react";
import { collapseContinueItems } from "@/lib/continue-watching";
import { safeCallbackPath } from "@/views/login";

export interface ProgressItem {
  tmdbId: number;
  mediaType: string;
  title: string;
  poster?: string | null;
  backdrop?: string | null;
  progress: number;
  position: number;
  duration: number;
  season?: number | null;
  episode?: number | null;
  providerId?: string | null;
  /** The next episode of a show whose latest episode was finished (Continue Watching only). */
  upNext?: boolean;
}

const SAVE_DEBOUNCE_MS = 5000;

async function progressRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.ok) return res.json() as Promise<T>;

  const body = (await res.json().catch(() => ({}))) as { error?: string };
  const message = body.error || "Failed to update progress";

  if (res.status === 401) {
    const currentPath =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : "/";
    const safe = safeCallbackPath(currentPath);
    await signOut({
      callbackUrl: `/login?error=SessionExpired&callbackUrl=${encodeURIComponent(safe)}`,
    });
    throw new Error("Session expired — please sign in again");
  }

  throw new Error(message);
}

export function useProgress() {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const lastSave = useRef(0);

  const { data: items, isLoading } = useQuery({
    queryKey: ["progress"],
    queryFn: () => progressRequest<ProgressItem[]>("/api/progress"),
    enabled: !!session,
  });

  const mutation = useMutation({
    mutationFn: (item: ProgressItem) =>
      progressRequest<ProgressItem>("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["progress"] }),
  });

  const remove = useMutation({
    mutationFn: ({
      tmdbId,
      mediaType,
      season,
      episode,
    }: {
      tmdbId: number;
      mediaType: string;
      season?: number | null;
      episode?: number | null;
    }) => {
      const params = new URLSearchParams({
        tmdbId: String(tmdbId),
        mediaType,
      });
      if (mediaType === "tv" && season != null && episode != null) {
        params.set("season", String(season));
        params.set("episode", String(episode));
      }
      return progressRequest<{ ok: boolean }>(`/api/progress?${params.toString()}`, {
        method: "DELETE",
      });
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["progress"] });
      void qc.invalidateQueries({ queryKey: ["show-progress", vars.tmdbId] });
    },
  });

  // Debounced save — at most once every 5s, always flushes immediately for progress >= 1 (ended).
  const save = (item: ProgressItem) => {
    const now = Date.now();
    if (item.progress >= 1 || now - lastSave.current > SAVE_DEBOUNCE_MS) {
      lastSave.current = now;
      mutation.mutate(item);
    }
  };

  // Defensive collapse (API also collapses) — one TV card per show.
  const collapsed = useMemo(
    () => collapseContinueItems(items || []),
    [items]
  );

  return { items: collapsed, isLoading, save, remove };
}
export interface ShowProgressRow {
  season: number;
  episode: number;
  progress: number;
  position: number;
  duration: number;
}

/**
 * Every saved episode of one show (finished ones included), keyed
 * "season:episode": what the episode lists use for progress bars and ticks.
 * Continue Watching only carries the latest episode per show.
 */
export function useShowProgress(tvId: number) {
  return useShowProgressQuery(tvId).map;
}

/** The same, with whether it has loaded (the watch page waits for it before resuming). */
export function useShowProgressQuery(tvId: number) {
  const { data: session } = useSession();
  const query = useQuery({
    queryKey: ["show-progress", tvId],
    queryFn: () => progressRequest<ShowProgressRow[]>(`/api/progress?tmdbId=${tvId}&mediaType=tv`),
    enabled: !!session && tvId > 0,
    staleTime: 30_000,
  });
  const { data } = query;
  const map = useMemo(() => {
    const out = new Map<string, ShowProgressRow>();
    for (const row of data ?? []) out.set(`${row.season}:${row.episode}`, row);
    return out;
  }, [data]);
  return { map, isFetched: query.isFetched };
}

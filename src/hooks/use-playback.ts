"use client";

import { useCallback, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import type { MediaType, PlaybackResponse, PlaybackSource } from "@/lib/playback/types";
import { mergeProgressivePlaybackSources } from "@/lib/playback/merge-sources";
import {
  getPlaybackDiscoveryPreferenceKey,
  getPreferredQualityHeight,
  syncProfilePlaybackPreferences,
} from "@/lib/player-preferences";
import { getMemPlaybackSeed, playbackMemKey } from "@/lib/playback-preresolve";
import { usableCachedPlayback } from "@/lib/playback/cache-age";
import { PlaybackRequestError, shouldRetryPlaybackRequest } from "@/lib/playback/request-error";
import { tvQueryIndex } from "@/lib/playback/tv-index";

export { tvQueryIndex } from "@/lib/playback/tv-index";

interface Args {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  enabled?: boolean;
}

const FAST_TIMEOUT_MS = 8_000;
const FULL_TIMEOUT_MS = 45_000;
/** While the server says more sources are coming, ask again this often… */
const POLL_INTERVAL_MS = 3_000;
/** …but stop after this long either way. */
const POLL_WINDOW_MS = 30_000;

export function playbackQueryKey(mediaType: MediaType, tmdbId: number, season: number | undefined, episode: number | undefined, fast: boolean) {
  return ["playback", mediaType, tmdbId, season, episode, fast ? "fast" : "full", getPlaybackDiscoveryPreferenceKey()] as const;
}

async function fetchPlayback(
  mediaType: MediaType,
  tmdbId: number,
  season: number | undefined,
  episode: number | undefined,
  fast: boolean,
  refresh = false
): Promise<PlaybackResponse> {
  const params = new URLSearchParams();
  if (mediaType === "tv") {
    params.set("season", String(tvQueryIndex(season)));
    params.set("episode", String(tvQueryIndex(episode)));
  }
  if (fast) params.set("fast", "1");
  if (refresh) params.set("refresh", "1");
  params.set("qualityHint", String(getPreferredQualityHeight()));
  const res = await fetch(`/api/playback/${mediaType}/${tmdbId}?${params}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(fast ? FAST_TIMEOUT_MS : FULL_TIMEOUT_MS),
  });
  const json = (await res.json()) as PlaybackResponse & { error?: string };
  if (!res.ok) throw new PlaybackRequestError(json.error || json.message || "Failed to resolve playback", res.status);
  if (json.preferences) syncProfilePlaybackPreferences(json.preferences);
  return json;
}

/** Warms the fast answer for a title the viewer is likely to play (detail page, next episode). */
export function usePrefetchPlayback({ tmdbId, mediaType, season, episode, enabled = true }: Args) {
  const { data: session } = useSession();
  useQuery({
    queryKey: playbackQueryKey(mediaType, tmdbId, season, episode, true),
    queryFn: () => fetchPlayback(mediaType, tmdbId, season, episode, true),
    enabled: enabled && !!session,
    retry: 1,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export interface Streams {
  sources: PlaybackSource[];
  /** More sources may still arrive (full resolve running or server reports partial). */
  discovering: boolean;
  preferences: PlaybackResponse["preferences"];
  remuxAvailable: boolean;
  status: PlaybackResponse["status"] | null;
  response: PlaybackResponse | undefined;
  error: Error | null;
  /** Ask the server for a fresh roster (new links), e.g. after a stream expired. */
  refresh(): void;
}

/**
 * The watch page's stream list: a fast answer (cache + quick providers) and a
 * full answer (every provider + Real-Debrid) requested together and merged,
 * re-polled while the server reports that more are on the way.
 */
export function useStreams({ tmdbId, mediaType, season, episode, enabled = true }: Args): Streams {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const canFetch = enabled && !!session;
  const refreshNext = useRef(false);
  const pollStarted = useRef<number | null>(null);

  const seed = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    const hit = getMemPlaybackSeed(playbackMemKey(mediaType, tmdbId, season, episode));
    const data = hit?.data as PlaybackResponse | undefined;
    return data?.sources?.length ? { data, updatedAt: hit!.updatedAt } : undefined;
  }, [mediaType, tmdbId, season, episode]);

  const fast = useQuery({
    queryKey: playbackQueryKey(mediaType, tmdbId, season, episode, true),
    queryFn: () => fetchPlayback(mediaType, tmdbId, season, episode, true),
    enabled: canFetch,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    ...(seed ? { initialData: seed.data, initialDataUpdatedAt: seed.updatedAt } : {}),
  });

  const full = useQuery({
    queryKey: playbackQueryKey(mediaType, tmdbId, season, episode, false),
    queryFn: () => {
      const refresh = refreshNext.current;
      refreshNext.current = false;
      return fetchPlayback(mediaType, tmdbId, season, episode, false, refresh);
    },
    enabled: canFetch,
    retry: shouldRetryPlaybackRequest,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      if (!query.state.data?.partial) return false;
      pollStarted.current ??= Date.now();
      return Date.now() - pollStarted.current < POLL_WINDOW_MS ? POLL_INTERVAL_MS : false;
    },
  });

  const fastData = usableCachedPlayback(fast.data, fast.dataUpdatedAt);
  const sources = useMemo(
    () => mergeProgressivePlaybackSources(fastData?.sources, full.data?.sources, full.data?.refreshNonce != null),
    [fastData?.sources, full.data?.sources, full.data?.refreshNonce]
  );

  const fullOpen = canFetch && (!full.isFetched || full.isFetching);
  const partial = Boolean(full.data?.partial) && Date.now() - (pollStarted.current ?? Date.now()) < POLL_WINDOW_MS;

  const refresh = useCallback(() => {
    refreshNext.current = true;
    pollStarted.current = null;
    void qc.refetchQueries({ queryKey: playbackQueryKey(mediaType, tmdbId, season, episode, false) });
  }, [qc, mediaType, tmdbId, season, episode]);

  const response = full.data ?? fastData;
  return {
    sources,
    discovering: fullOpen || partial,
    preferences: full.data?.preferences ?? fastData?.preferences,
    remuxAvailable: (full.data?.remuxAvailable ?? fastData?.remuxAvailable) !== false,
    status: response?.status ?? null,
    response,
    error: (full.error as Error | null) ?? null,
    refresh,
  };
}

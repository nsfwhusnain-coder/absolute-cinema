"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import type { MediaType, PlaybackResponse, PlaybackSource } from "@/lib/playback/types";
import { mergeProgressivePlaybackSources } from "@/lib/playback/merge-sources";
import { keepsWarm } from "@/lib/playback/prewarm-renewal";
import type { Outlook } from "@/lib/playback/orchestrator";
import {
  getPlaybackDiscoveryPreferenceKey,
  getPreferredQualityHeight,
  syncProfilePlaybackPreferences,
} from "@/lib/player-preferences";
import { getMemPlaybackSeed, playbackMemKey } from "@/lib/playback-preresolve";
import { usableCachedPlayback } from "@/lib/playback/cache-age";
import { streamsDiscovering } from "@/lib/playback/stream-discovery";
import { PlaybackRequestError, shouldRetryPlaybackRequest } from "@/lib/playback/request-error";
import { tvQueryIndex } from "@/lib/playback/tv-index";
import { timeoutSignal } from "@/lib/abort";
import { prewarmStart } from "@/components/player/prewarm";

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
/**
 * …and this often while a debrid service is still deciding: the player holds
 * its start for that answer (a 4K file may be a second away), so each second
 * between the service deciding and the next ask was a second of spinner. The
 * server answers a re-ask from what the services have so far.
 */
const DEBRID_POLL_INTERVAL_MS = 1_000;
/** Once the debrid services have nothing more to add, only the web providers' slow tail is awaited: this often is enough. */
const SETTLED_POLL_INTERVAL_MS = 10_000;
/** …but stop after this long either way. */
const POLL_WINDOW_MS = 30_000;
/**
 * Until the full answer lands, re-ask the fast endpoint this often. Providers
 * that answer after the first reply are merged into the server's fast cache,
 * so each re-ask is a cheap cache hit that brings them to the player seconds
 * before the full resolve (which also waits on probes) returns.
 */
const FAST_REPOLL_MS = 2_000;

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
  const timeout = timeoutSignal(fast ? FAST_TIMEOUT_MS : FULL_TIMEOUT_MS);
  const res = await fetch(`/api/playback/${mediaType}/${tmdbId}?${params}`, {
    cache: "no-store",
    signal: timeout.signal,
  }).finally(timeout.done);
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

/** How often a prewarm still wanted is renewed (the server drops one nobody plays after 75 s). */
const PREWARM_RENEW_MS = 50_000;

/**
 * Gets a title ready before Play. Its sources are resolved in full (the same
 * answers the watch page asks for, so Play finds them already in hand), and
 * when the source Play would start is a remux its session is opened: the
 * file indexed and the first seconds made. See components/player/prewarm.
 */
export function usePrewarmStart(args: Args & { startAt: number; originalLanguage?: string | null }) {
  const { tmdbId, mediaType, season, episode, enabled = true, startAt, originalLanguage } = args;
  const { data: session } = useSession();
  const active = enabled && !!session;
  const fast = useQuery({
    queryKey: playbackQueryKey(mediaType, tmdbId, season, episode, true),
    queryFn: () => fetchPlayback(mediaType, tmdbId, season, episode, true),
    enabled: active,
    retry: 1,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const full = useQuery({
    queryKey: playbackQueryKey(mediaType, tmdbId, season, episode, false),
    queryFn: () => fetchPlayback(mediaType, tmdbId, season, episode, false),
    enabled: active,
    retry: false,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const response = full.data ?? fast.data;
  const sources = useMemo(
    () => mergeProgressivePlaybackSources(fast.data?.sources, full.data?.sources, false),
    [fast.data?.sources, full.data?.sources]
  );
  const remuxAvailable = response?.remuxAvailable !== false;
  const audioPreference = response?.preferences?.audioPreference ?? "original";
  const audioLanguage = response?.preferences?.audioLanguage ?? "en";
  const quality = response?.preferences?.playbackQuality;
  useEffect(() => {
    if (!active || !sources.length) return;
    const warm = () =>
      prewarmStart({
        sources,
        remuxAvailable,
        title: { tmdbId, mediaType, season, episode, originalLanguage },
        audio: { preference: audioPreference, language: audioLanguage },
        quality,
        startAt,
      });
    const hidden = () => document.visibilityState === "hidden";
    let renewals = 0;
    if (!hidden()) warm();
    const timer = setInterval(() => {
      if (!keepsWarm(renewals, hidden())) return;
      renewals++;
      warm();
    }, PREWARM_RENEW_MS);
    // Back on the page after being away: ready again, and the count starts over.
    const onVisibility = () => {
      if (hidden()) return;
      renewals = 0;
      warm();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, sources, remuxAvailable, audioPreference, audioLanguage, quality, tmdbId, mediaType, season, episode, originalLanguage, startAt]);
}

export interface Streams {
  sources: PlaybackSource[];
  /** More sources may still arrive (full resolve running or server reports partial). */
  discovering: boolean;
  /** What the full answer says the debrid services can still add. */
  outlook: Outlook;
  preferences: PlaybackResponse["preferences"];
  remuxAvailable: boolean;
  /** The server lets this viewer download files. */
  downloadsAvailable: boolean;
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
  const { data: session, status: sessionStatus } = useSession();
  const qc = useQueryClient();
  const canFetch = enabled && !!session;
  const refreshNext = useRef(false);
  // When re-polling began, per title. Per title because the watch page (and
  // this hook) stays mounted from one episode to the next: a single shared
  // start time ran out 30 s after the page opened, so every later episode
  // stopped looking for late sources at once.
  const pollStarts = useRef(new Map<string, number>());
  const titleKey = `${mediaType}:${tmdbId}:${season ?? ""}:${episode ?? ""}`;

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
    refetchInterval: () => {
      // Stop once the full answer is in, or has failed for good (it used to poll every 2 s forever).
      const full = qc.getQueryState(playbackQueryKey(mediaType, tmdbId, season, episode, false));
      return full?.dataUpdatedAt || full?.status === "error" ? false : FAST_REPOLL_MS;
    },
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
      const starts = pollStarts.current;
      if (!starts.has(titleKey)) starts.set(titleKey, Date.now());
      if (Date.now() - starts.get(titleKey)! >= POLL_WINDOW_MS) return false;
      if (query.state.data.debridSettled === false) return DEBRID_POLL_INTERVAL_MS;
      return query.state.data.debridSettled ? SETTLED_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    },
  });

  const fastData = usableCachedPlayback(fast.data, fast.dataUpdatedAt);
  const sources = useMemo(
    () => mergeProgressivePlaybackSources(fastData?.sources, full.data?.sources, full.data?.refreshNonce != null),
    [fastData?.sources, full.data?.sources, full.data?.refreshNonce]
  );

  const pollStart = pollStarts.current.get(titleKey);
  const partial = Boolean(full.data?.partial) && (pollStart === undefined || Date.now() - pollStart < POLL_WINDOW_MS);
  // Before the session is known the queries cannot run yet, but the full answer is still to come.
  const discovering = canFetch
    ? streamsDiscovering({ hasFullData: full.data !== undefined, fullStatus: full.status, fullFetching: full.isFetching, partialWithinWindow: partial })
    : enabled && sessionStatus === "loading";

  const refresh = useCallback(() => {
    refreshNext.current = true;
    pollStarts.current.delete(titleKey);
    void qc.refetchQueries({ queryKey: playbackQueryKey(mediaType, tmdbId, season, episode, false) });
  }, [qc, mediaType, tmdbId, season, episode, titleKey]);

  const fourKSettled = full.data?.fourKSettled === true;
  const debridSettled = full.data?.debridSettled === true;
  const outlook = useMemo(() => ({ fourKSettled, debridSettled }), [fourKSettled, debridSettled]);

  const response = full.data ?? fastData;
  return {
    sources,
    discovering,
    outlook,
    preferences: full.data?.preferences ?? fastData?.preferences,
    remuxAvailable: (full.data?.remuxAvailable ?? fastData?.remuxAvailable) !== false,
    downloadsAvailable: (full.data?.downloadsAvailable ?? fastData?.downloadsAvailable) !== false,
    status: response?.status ?? null,
    response,
    error: (full.error as Error | null) ?? null,
    refresh,
  };
}

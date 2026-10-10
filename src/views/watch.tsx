"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { creditsStartFor, upNextPhase } from "@/components/player/up-next-window";
import { usePlayerState } from "@/components/player/store";
import { useSleepTimer } from "@/components/player/use-sleep-timer";
import { stopsAtThisEnd } from "@/components/player/sleep-timer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useNavigate } from "@/hooks/use-navigate";
import { tmdbImageUrl, pickTitleLogoUrl, type TmdbImages } from "@/lib/tmdb";
import { useMounted } from "@/hooks/use-mounted";
import { Player } from "@/components/player/Player";
import { AlertCircle, ExternalLink, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrefetchPlayback, useStreams } from "@/hooks/use-playback";
import { NoProvider } from "@/components/empty-states";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { tvQueryIndex } from "@/lib/playback/tv-index";
import { getAutoplayNext } from "@/lib/player-preferences";
import { PREFERENCES_QUERY_KEY, fetchPreferences } from "@/lib/preferences-client";
import type { SkipSegment } from "@/lib/playback/skip-times";
import { fetchLoaderLook, loaderLookQueryKey } from "@/lib/loader/look-client";
import { preloadLoaderEngine } from "@/components/loader/cinematic-loader";
import { LoaderBackdrop, NEUTRAL_PALETTE } from "@/components/loader/loader-backdrop";
import type { LoaderPalette } from "@/lib/loader/palette";
import { resolveNextEpisode, type AiredEpisode, type SeasonMeta } from "@/lib/playback/next-episode";
import { tvSeasonQuery } from "@/lib/tv-season-query";
import { resumeTvEpisode } from "@/lib/continue-watching";
import { useShowProgressQuery } from "@/hooks/use-progress";

/** Cancelable countdown once an episode has really ended, before the next one starts. */
const NEXT_EPISODE_COUNTDOWN_S = 6;
/** After this many episodes start on their own with no interaction, ask "Still watching?". */
const STILL_WATCHING_AFTER = 3;

interface Props {
  mediaType: "movie" | "tv";
  id: number;
  season?: number;
  episode?: number;
}

interface ProgressItem {
  tmdbId: number;
  mediaType: string;
  progress: number;
  position: number;
  duration: number;
  season?: number | null;
  episode?: number | null;
  updatedAt?: string;
}


/** Full-viewport watch page: the player and nothing else. */
export function WatchView({ mediaType, id, season, episode }: Props) {
  // Episodes that started on their own since anyone last touched anything.
  const autoAdvances = useRef(0);
  useEffect(() => {
    const reset = () => {
      autoAdvances.current = 0;
    };
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, []);
  // The profile's own threshold (Settings → Playback; 0 = never ask), read when the card mounts.
  const stillWatchingAfter = useRef(STILL_WATCHING_AFTER);
  const shouldAskStillWatching = useCallback(
    () => stillWatchingAfter.current > 0 && autoAdvances.current >= stillWatchingAfter.current,
    []
  );
  const countAutoAdvance = useCallback(() => {
    autoAdvances.current += 1;
  }, []);

  // The player puts the whole page into full screen, so changing episode keeps
  // it; leaving the watch page is what ends it. The sleep timer likewise runs
  // across episodes and ends with the watch page.
  useEffect(
    () => () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      useSleepTimer.getState().cancel();
    },
    []
  );
  const navigate = useNavigate();
  const router = useRouter();
  const mounted = useMounted();
  // Whichever button started playback, the loading scene's engine is ready by now.
  useEffect(() => {
    preloadLoaderEngine();
  }, []);
  const { data: session } = useSession();
  const qc = useQueryClient();
  const { data: profilePrefs } = useQuery({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: fetchPreferences,
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (profilePrefs) stillWatchingAfter.current = profilePrefs.stillWatchingAfter;
  }, [profilePrefs]);
  const [ended, setEnded] = useState(false);
  /** Always tagged with title/S/E so a flush never writes episode N's playhead onto episode N+1. */
  const lastProgressRef = useRef<{
    position: number;
    duration: number;
    tmdbId: number;
    mediaType: string;
    season: number;
    episode: number;
  } | null>(null);
  const saveGenerationRef = useRef(0);

  // "Ended" belongs to the episode on screen. Another episode (browser Back
  // included), or playing again after the end (replay, scrubbing back), means
  // it is over no longer, so the up-next countdown must not fire.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnded(false);
  }, [id, mediaType, season, episode]);
  useEffect(() => {
    if (!ended) return;
    return usePlayerState.subscribe((state, previous) => {
      if (state.playing && !previous.playing) setEnded(false);
    });
  }, [ended]);

  // TV scrapers require season+episode. Default S1E1 when URL omits them.
  // Season/episode 0 is TMDB specials — do not coerce 0 → 1.
  const tvSeason = mediaType === "tv" ? tvQueryIndex(season) : undefined;
  const tvEpisode = mediaType === "tv" ? tvQueryIndex(episode) : undefined;

  /**
   * Leave the player by popping history — do NOT push the detail URL.
   * Pushing detail on top of watch traps the next Back on the player:
   *   home → detail → watch → detail(pushed)  ⇒  Back = watch again.
   * With back(): home → detail → watch  ⇒  Back = detail  ⇒  Back = home.
   */
  const leaveWatch = useCallback(() => {
    if (typeof window !== "undefined") {
      const idx = (window.history.state as { idx?: number } | null)?.idx;
      if (typeof idx === "number" && idx > 0) {
        router.back();
        return;
      }
      try {
        if (
          document.referrer &&
          new URL(document.referrer).origin === window.location.origin
        ) {
          router.back();
          return;
        }
      } catch {
        /* ignore invalid referrer */
      }
    }
    router.replace(`/${mediaType}/${id}`);
  }, [router, mediaType, id]);

  const { data: meta } = useQuery({
    queryKey: ["tmdb", mediaType, id, "watch"],
    queryFn: async () => {
      const res = await fetch(
        mediaType === "movie"
          ? `/api/tmdb/movie/${id}?append_to_response=images`
          : `/api/tmdb/tv/${id}?append_to_response=images`
      );
      if (!res.ok) return null;
      return res.json();
    },
    enabled: mounted,
  });

  const { data: subtitlesResponse } = useQuery({
    queryKey: ["subtitles", mediaType, id, tvSeason, tvEpisode],
    queryFn: async () => {
      const qs = new URLSearchParams({
        tmdbId: String(id),
        mediaType,
        ...(mediaType === "tv" && tvSeason != null ? { season: String(tvSeason) } : {}),
        ...(mediaType === "tv" && tvEpisode != null ? { episode: String(tvEpisode) } : {}),
      });
      const res = await fetch(`/api/subtitles?${qs.toString()}`);
      if (!res.ok) return { subtitles: [] };
      return res.json();
    },
    enabled: mounted && !!id,
    staleTime: 60 * 60 * 1000,
  });
  const externalSubtitles = subtitlesResponse?.subtitles ?? [];

  const images = meta?.images as TmdbImages | undefined;

  const { data: seasonMeta } = useQuery({
    ...tvSeasonQuery<{
      episodes?: Array<{ episode_number: number; runtime?: number | null; name?: string; overview?: string }>;
    }>(id, tvSeason),
    enabled: mounted && mediaType === "tv" && tvSeason != null,
  });

  // Always fresh here: a cached list from before the last episode was left
  // would start it from the beginning instead of where the viewer stopped.
  const { data: progressList, isFetched: progressLoaded } = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const res = await fetch("/api/progress");
      if (!res.ok) return [] as ProgressItem[];
      return res.json() as Promise<ProgressItem[]>;
    },
    enabled: mounted && !!session,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const tvParamsInUrl =
    mediaType !== "tv" ||
    (season != null &&
      Number.isFinite(season) &&
      season >= 0 &&
      episode != null &&
      Number.isFinite(episode) &&
      episode >= 0);

  // Normalize TV URLs so history/share always include S/E. If the URL omitted
  // them, resume from Continue (including Specials) instead of forcing S1E1.
  useEffect(() => {
    if (!mounted || mediaType !== "tv" || tvParamsInUrl) return;
    if (session && progressList === undefined) return;
    const resume = resumeTvEpisode(progressList, id);
    const s = resume?.season ?? 1;
    const e = resume?.episode ?? 1;
    router.replace(`/watch/tv/${id}?season=${s}&episode=${e}`);
  }, [mounted, mediaType, id, tvParamsInUrl, session, progressList, router]);

  useEffect(() => {
    // Drop previous episode's playhead immediately — do not let flush/onProgress
    // write S1E1's timestamp onto S1E2 (next-episode / picker bug).
    lastProgressRef.current = null;
    saveGenerationRef.current += 1;
  }, [id, mediaType, tvSeason, tvEpisode]);

  // Where to resume, worked out during render so the player mounts with it.
  // (Set from an effect it arrived a render late: the player had mounted with
  // 0 and could already have started the stream from the beginning.)
  //
  // Where each episode was left, in order of trust: this visit's own reports
  // (switching back to an episode watched a minute ago), then every saved
  // episode of the show (Continue Watching only lists a show's latest one, so
  // older half-watched episodes used to start from 0:00), then that list.
  const showProgress = useShowProgressQuery(mediaType === "tv" ? id : 0);
  const sessionPositions = useRef(new Map<string, { position: number; duration: number }>());
  const savedTime = useMemo(() => {
    const key = mediaType === "tv" ? `${tvSeason}:${tvEpisode}` : "0:0";
    const fromRow = (row: { progress: number; position: number; duration: number } | undefined) => {
      if (!row || !(row.progress > 0.02 && row.progress < 0.95 && row.duration > 0)) return 0;
      const fromPos = Number(row.position) || 0;
      const t = fromPos > 5 ? fromPos : (Number(row.progress) || 0) * (Number(row.duration) || 0);
      return t > 5 ? t : 0;
    };
    const local = sessionPositions.current.get(`${id}:${key}`);
    if (local) return fromRow({ ...local, progress: local.position / local.duration });
    const saved = mediaType === "tv" ? showProgress.map.get(key) : undefined;
    if (saved) return fromRow(saved);
    const found = progressList?.find((p) => {
      if (Number(p.tmdbId) !== Number(id) || p.mediaType !== mediaType) return false;
      if (mediaType !== "tv") return true;
      // Movies use season/episode 0 in DB; TV must match the open episode.
      return Number(p.season) === Number(tvSeason) && Number(p.episode) === Number(tvEpisode);
    });
    return fromRow(found);
  }, [progressList, showProgress.map, id, mediaType, tvSeason, tvEpisode]);

  const streams = useStreams({
    tmdbId: id,
    mediaType,
    season: tvSeason,
    episode: tvEpisode,
    enabled: mounted && tvParamsInUrl,
  });
  const playback = streams.response;

  // Wait for the saved position (a fraction of a second) so the player starts
  // where the viewer left off rather than at 0 and jumping.
  const showPlayerShell = mounted && !!session && progressLoaded && (mediaType !== "tv" || showProgress.isFetched);
  const knownTitle = meta?.title || meta?.name || playback?.title;
  const baseTitle = knownTitle || "Untitled";
  const { data: loaderLook } = useQuery({
    queryKey: loaderLookQueryKey(mediaType, id),
    queryFn: () => fetchLoaderLook(mediaType, id),
    enabled: mounted,
    staleTime: 24 * 60 * 60 * 1000,
  });
  const { data: skipData } = useQuery({
    queryKey: ["skip-times", id, tvSeason, tvEpisode],
    queryFn: async () => {
      const res = await fetch(`/api/skip-times?tmdbId=${id}&season=${tvSeason}&episode=${tvEpisode}`);
      return res.ok ? ((await res.json()) as { segments: SkipSegment[] }) : { segments: [] };
    },
    enabled: mounted && mediaType === "tv" && tvSeason != null && tvEpisode != null,
    staleTime: 60 * 60 * 1000,
  });
  const episodeMeta = seasonMeta?.episodes?.find((e) => e.episode_number === tvEpisode);
  const episodeName = episodeMeta?.name;
  const overview = (mediaType === "tv" ? episodeMeta?.overview || meta?.overview : meta?.overview) || undefined;
  const episodeLabel =
    mediaType === "tv" && tvSeason != null && tvEpisode != null
      ? `S${tvSeason} · E${tvEpisode}${episodeName ? ` · ${episodeName}` : ""}`
      : undefined;
  const blockedStatus =
    playback?.status === "not_configured" ||
    playback?.status === "external" ||
    playback?.status === "requestable";

  const persistProgress = useCallback(
    async (e: {
      position: number;
      duration: number;
      progress?: number;
      tmdbId: number;
      mediaType: string;
      season: number;
      episode: number;
    }) => {
      if (!session || e.duration <= 0) return;
      if (
        e.mediaType === "tv" &&
        (!Number.isFinite(e.season) ||
          e.season < 0 ||
          !Number.isFinite(e.episode) ||
          e.episode < 0)
      ) {
        return;
      }

      // Drop stale saves from the previous episode after a switch.
      if (
        e.tmdbId !== id ||
        e.mediaType !== mediaType ||
        (mediaType === "tv" &&
          (e.season !== tvSeason || e.episode !== tvEpisode)) ||
        (mediaType === "movie" && (e.season !== 0 || e.episode !== 0))
      ) {
        return;
      }

      const generation = ++saveGenerationRef.current;
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: e.tmdbId,
          mediaType: e.mediaType,
          // The show's own name: the episode is stored in season/episode, and a
          // "· S1E3" suffix here leaked into "Because you watched…" and My List.
          title: baseTitle,
          poster: meta?.poster_path ?? null,
          backdrop: meta?.backdrop_path ?? null,
          progress: e.progress ?? e.position / e.duration,
          position: e.position,
          duration: e.duration,
          season: e.mediaType === "tv" ? e.season : 0,
          episode: e.mediaType === "tv" ? e.episode : 0,
          providerId: playback?.providerId ?? null,
        }),
      }).catch(() => null); // offline for a moment: the next report (every 10 s) catches up

      if (generation !== saveGenerationRef.current) return;
      if (res?.ok) {
        // Marked stale, not refetched: this page re-reads progress every 10 s
        // otherwise, for a list only the pages behind it show.
        void qc.invalidateQueries({ queryKey: ["progress"], refetchType: "none" });
      }
    },
    [session, id, mediaType, baseTitle, meta, tvSeason, tvEpisode, playback?.providerId, qc]
  );

  const flushProgress = useCallback(() => {
    const last = lastProgressRef.current;
    if (!last || last.duration <= 0) return;
    // Only flush if the snapshot still belongs to the episode on screen.
    if (
      last.tmdbId !== id ||
      last.mediaType !== mediaType ||
      (mediaType === "tv"
        ? last.season !== tvSeason || last.episode !== tvEpisode
        : last.season !== 0 || last.episode !== 0)
    ) {
      return;
    }
    void persistProgress(last);
  }, [persistProgress, id, mediaType, tvSeason, tvEpisode]);

  /**
   * Tab-close-safe flush (task 6): a plain `fetch` here gets cancelled by the
   * browser on unload before it ever leaves the page, silently dropping the
   * final resume position. `sendBeacon` (falling back to `fetch(keepalive)`)
   * survives page teardown. POST /api/progress just does `req.json()` — it
   * doesn't care about Content-Type — so a Blob typed `application/json`
   * parses the same as the regular fetch path; the route itself is untouched.
   */
  const flushProgressBeacon = useCallback(() => {
    const last = lastProgressRef.current;
    if (!session || !last || last.duration <= 0) return;
    if (
      last.tmdbId !== id ||
      last.mediaType !== mediaType ||
      (mediaType === "tv"
        ? last.season !== tvSeason || last.episode !== tvEpisode
        : last.season !== 0 || last.episode !== 0)
    ) {
      return;
    }

    const body = JSON.stringify({
      tmdbId: last.tmdbId,
      mediaType: last.mediaType,
      title: baseTitle,
      poster: meta?.poster_path ?? null,
      backdrop: meta?.backdrop_path ?? null,
      progress: last.position / last.duration,
      position: last.position,
      duration: last.duration,
      season: last.mediaType === "tv" ? last.season : 0,
      episode: last.mediaType === "tv" ? last.episode : 0,
      providerId: playback?.providerId ?? null,
    });

    let sent = false;
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      sent = navigator.sendBeacon("/api/progress", blob);
    }
    if (!sent) {
      void fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        /* page is closing — nothing left to surface this to */
      });
    }
  }, [session, id, mediaType, baseTitle, meta, tvSeason, tvEpisode, playback?.providerId]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushProgressBeacon();
    };
    const onPageHide = () => flushProgressBeacon();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      // Unmount here means an in-app navigation (tab stays open) — the
      // regular fetch path is fine and keeps the progress-query invalidation.
      flushProgress();
    };
  }, [flushProgress, flushProgressBeacon]);

  /**
   * useCallback (task 8): the player reads this via a ref internally so it
   * never re-attaches its media listeners on a new identity, but keeping this
   * stable too means it isn't recreated needlessly on every WatchView render
   * (e.g. every progressive-enrich poll tick).
   */
  const onProgress = useCallback(
    (current: number, duration: number) => {
      if (duration <= 0) return;
      const seasonKey = mediaType === "tv" ? (tvSeason ?? 0) : 0;
      const episodeKey = mediaType === "tv" ? (tvEpisode ?? 0) : 0;
      if (duration > 0) sessionPositions.current.set(`${id}:${seasonKey}:${episodeKey}`, { position: current, duration });
      lastProgressRef.current = {
        position: current,
        duration,
        tmdbId: id,
        mediaType,
        season: seasonKey,
        episode: episodeKey,
      };
      void persistProgress({
        position: current,
        duration,
        tmdbId: id,
        mediaType,
        season: seasonKey,
        episode: episodeKey,
      });
    },
    [id, mediaType, tvSeason, tvEpisode, persistProgress]
  );

  const onEnded = useCallback(async () => {
    if (!session) return;
    // The up-next card must not wait on the network.
    setEnded(true);
    const generation = ++saveGenerationRef.current;
    // Saved as finished (not deleted): Continue Watching then offers the next
    // episode, and the episode list can tick this one off.
    const duration = usePlayerState.getState().duration || lastProgressRef.current?.duration || 1;
    lastProgressRef.current = null;
    // Finished: opening it again starts from the beginning.
    sessionPositions.current.set(`${id}:${mediaType === "tv" ? `${tvSeason}:${tvEpisode}` : "0:0"}`, { position: duration, duration });
    const res = await fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdbId: id,
        mediaType,
        title: baseTitle,
        poster: meta?.poster_path ?? null,
        backdrop: meta?.backdrop_path ?? null,
        progress: 1,
        position: duration,
        duration,
        season: mediaType === "tv" ? tvSeason : 0,
        episode: mediaType === "tv" ? tvEpisode : 0,
        providerId: playback?.providerId ?? null,
      }),
    }).catch(() => null);
    if (generation !== saveGenerationRef.current) return;
    if (res?.ok) {
      qc.invalidateQueries({ queryKey: ["progress"] });
      qc.invalidateQueries({ queryKey: ["show-progress", id] });
    }
    if (mediaType === "movie") toast.success("Finished! Marked as watched.");
  }, [session, id, mediaType, tvSeason, tvEpisode, qc, baseTitle, meta, playback?.providerId]);

  // useMemo (task 8): resolveNextEpisode returns a fresh object literal every
  // call even when season/episode are unchanged — without memoizing, this
  // identity churn (on every WatchView render, e.g. progressive-enrich polls)
  // was one of the two causes forcing the player's media listeners to detach
  // and re-attach roughly every 2-5s.
  const nextEpisodeTarget = useMemo(
    () =>
      mediaType === "tv" && tvSeason != null && tvEpisode != null
        ? resolveNextEpisode(
            meta?.seasons as SeasonMeta[] | undefined,
            tvSeason,
            tvEpisode,
            meta?.last_episode_to_air as AiredEpisode | null | undefined
          )
        : null,
    [mediaType, tvSeason, tvEpisode, meta?.seasons, meta?.last_episode_to_air]
  );
  const hasNextEpisode = nextEpisodeTarget != null;

  // Fast-path only — no chrome change. Warms the next episode while this one plays.
  usePrefetchPlayback({
    tmdbId: id,
    mediaType: "tv",
    season: nextEpisodeTarget?.season,
    episode: nextEpisodeTarget?.episode,
    enabled: mounted && tvParamsInUrl && mediaType === "tv" && nextEpisodeTarget != null,
  });

  /**
   * TMDB's stated runtime, in seconds.
   *
   * Used only when the stream cannot state its own length yet — a remux is
   * produced live, so its playlist reports how much has been remuxed rather
   * than how long the title is. Without this, watching the first quarter of a
   * remuxed film and leaving would save no resume point at all, because the
   * only duration on offer was one known to be wrong. TMDB's figure is accurate
   * to about a minute, which is far better than either alternative.
   *
   * TV uses the selected episode's runtime when TMDB provides it, then falls
   * back to the series-level `episode_run_time` average. A missing value simply
   * means no fallback — never a guess.
   */
  const tmdbRuntimeSeconds = useMemo(() => {
    const exactEpisodeRuntime =
      mediaType === "tv"
        ? seasonMeta?.episodes?.find(
            (candidate) => candidate.episode_number === tvEpisode
          )?.runtime
        : null;
    const raw = mediaType === "tv"
      ? exactEpisodeRuntime ??
        (meta?.episode_run_time as number[] | undefined)?.[0]
      : (meta?.runtime as number | undefined);
    return typeof raw === "number" && raw > 0 ? raw * 60 : 0;
  }, [mediaType, meta, seasonMeta, tvEpisode]);

  const goToNextEpisode = useCallback(() => {
    if (!nextEpisodeTarget) return;
    // Flush current episode under its own identity, then hard-reset so next ep starts at 0.
    flushProgress();
    lastProgressRef.current = null;
    saveGenerationRef.current += 1;
    setEnded(false);
    // Replace, not push: one history entry for the whole binge, so Back leaves
    // the player instead of replaying every episode watched on the way.
    router.replace(
      `/watch/tv/${id}?season=${nextEpisodeTarget.season}&episode=${nextEpisodeTarget.episode}`
    );
  }, [nextEpisodeTarget, flushProgress, router, id]);

  const selectEpisode = useCallback(
    (s: number, e: number) => {
      flushProgress();
      lastProgressRef.current = null;
      saveGenerationRef.current += 1;
      setEnded(false);
      router.replace(`/watch/tv/${id}?season=${s}&episode=${e}`);
    },
    [router, id, flushProgress]
  );

  const handleRequest = async () => {
    const endpoint = playback?.action?.requestEndpoint;
    if (!endpoint) return;
    try {
      const res = await fetch(endpoint, { method: "POST" });
      if (res.ok) {
        toast.success("Request sent");
        streams.refresh();
      } else toast.error("Request failed");
    } catch {
      toast.error("Request failed");
    }
  };

  const backdrop = tmdbImageUrl(meta?.backdrop_path ?? playback?.poster, "w1280");
  const logo = pickTitleLogoUrl(images, "w500");

  // Full-bleed inside watch/layout — no max-width shell; bars only from object-fit:contain
  return (
    <div
      data-page="watch"
      className="relative m-0 h-full w-full max-w-none overflow-hidden bg-black p-0"
    >
      {!mounted ? (
        <WatchBoot palette={loaderLook?.palette} />
      ) : !session ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-white/70">
          <User className="h-10 w-10 text-white" />
          <div className="text-sm font-medium">Sign in to start watching</div>
          <Button
            type="button"
            onClick={() => {
              const watchPath =
                mediaType === "tv" &&
                season != null &&
                Number.isFinite(season) &&
                season >= 0 &&
                episode != null &&
                Number.isFinite(episode) &&
                episode >= 0
                  ? `/watch/tv/${id}?season=${season}&episode=${episode}`
                  : `/watch/${mediaType}/${id}`;
              navigate(`/login?callbackUrl=${encodeURIComponent(watchPath)}`);
            }}
            size="sm"
          >
            Sign in
          </Button>
        </div>
      ) : blockedStatus ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-white">
          {playback?.status === "not_configured" ? (
            <NoProvider />
          ) : playback?.status === "external" ? (
            <>
              <ExternalLink className="h-10 w-10" />
              <div className="text-sm font-medium">Available on a paid service</div>
              {playback.action?.url && (
                <a href={playback.action.url} target="_blank" rel="noreferrer">
                  <Button type="button" size="sm">
                    {playback.action.label}
                  </Button>
                </a>
              )}
            </>
          ) : (
            <>
              <AlertCircle className="h-10 w-10 text-amber-400" />
              <div className="text-sm font-medium">Not in your library</div>
              <Button
                type="button"
                size="sm"
                onClick={handleRequest}
                disabled={!playback?.action?.requestEndpoint}
              >
                {playback?.action?.label || "Request"}
              </Button>
            </>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={leaveWatch}>
            Back
          </Button>
        </div>
      ) : showPlayerShell ? (
        <div className="absolute inset-0 h-full w-full">
          <Player
            key={`${mediaType}-${id}-${tvSeason}-${tvEpisode}`}
            sources={streams.sources}
            discovering={streams.discovering}
            remuxAvailable={streams.remuxAvailable}
            title={{
              tmdbId: id,
              mediaType,
              season: tvSeason,
              episode: tvEpisode,
              originalLanguage: meta?.original_language ?? null,
            }}
            // Blank until the title is known: the loading screen showed "UNTITLED" for the first moments.
            displayTitle={knownTitle ?? ""}
            episodeLabel={episodeLabel}
            overview={overview}
            loaderLook={loaderLook}
            skipSegments={skipData?.segments}
            backdrop={backdrop}
            logo={logo}
            initialTime={savedTime}
            fallbackDurationS={tmdbRuntimeSeconds}
            audio={{
              preference: streams.preferences?.audioPreference ?? "original",
              language: streams.preferences?.audioLanguage ?? "en",
            }}
            quality={streams.preferences?.playbackQuality}
            subtitlePreference={streams.preferences?.subtitlePreference ?? "english"}
            externalSubtitles={externalSubtitles}
            onProgress={onProgress}
            onEnded={onEnded}
            onBack={leaveWatch}
            onRefreshSources={streams.refresh}
            tv={
              mediaType === "tv" && tvSeason != null && tvEpisode != null
                ? {
                    seasons: ((meta?.seasons as SeasonMeta[] | undefined) ?? [])
                      .filter((s) => s.season_number >= 0 && s.episode_count > 0)
                      .map((s) => ({
                        season_number: s.season_number,
                        name: s.season_number === 0 ? "Specials" : `Season ${s.season_number}`,
                        episode_count: s.episode_count,
                      })),
                    season: tvSeason,
                    episode: tvEpisode,
                    onSelectEpisode: selectEpisode,
                    onNextEpisode: hasNextEpisode ? goToNextEpisode : undefined,
                  }
                : undefined
            }
          />
          {mediaType === "tv" && nextEpisodeTarget && (
            <UpNextGate
              key={`${nextEpisodeTarget.season}-${nextEpisodeTarget.episode}`}
              ended={ended}
              target={nextEpisodeTarget}
              fallbackDurationS={tmdbRuntimeSeconds}
              skipSegments={skipData?.segments}
              currentSeason={tvSeason}
              onPlayNow={goToNextEpisode}
              askStillWatching={shouldAskStillWatching}
              onAutoAdvance={countAutoAdvance}
            />
          )}
        </div>
      ) : (
        <WatchBoot palette={loaderLook?.palette} />
      )}
    </div>
  );
}

/**
 * The loading screen's backdrop and hairline, shown for the few hundred
 * milliseconds before the player itself mounts. The player's loader continues
 * the same backdrop mid-drift, so the two read as one screen.
 */
function WatchBoot({ palette }: { palette?: LoaderPalette }) {
  return (
    <div className="absolute inset-0 bg-black" aria-busy="true" aria-label="Loading">
      <LoaderBackdrop palette={palette ?? NEUTRAL_PALETTE} />
      <div className="absolute inset-x-0 bottom-[9vh] flex justify-center">
        <div className="h-px w-40 overflow-hidden bg-white/10 sm:w-56" aria-hidden>
          <div className="loader-hairline h-full w-1/3 bg-white/70" />
        </div>
      </div>
    </div>
  );
}

/**
 * Decides WHEN the next-episode card appears and whether it may start the next
 * episode by itself; `NextEpisodeCard` below decides what it looks like.
 *
 * The card is an offer while the episode is still playing (inside the credits
 * when a time for them is known, otherwise a short tail) and only counts down
 * once the video has really ended — see `upNextPhase`, which owns the rules. A
 * timer started before the end skips whatever the episode still has to show.
 *
 * Split out as its own component so the 250ms currentTime tick re-renders this
 * alone rather than the whole watch view.
 */
function UpNextGate({
  ended,
  target,
  currentSeason,
  fallbackDurationS,
  skipSegments,
  onPlayNow,
  askStillWatching,
  onAutoAdvance,
}: {
  ended: boolean;
  target: { season: number; episode: number };
  currentSeason?: number;
  fallbackDurationS: number;
  skipSegments?: SkipSegment[];
  onPlayNow: () => void;
  askStillWatching: () => boolean;
  onAutoAdvance: () => void;
}) {
  const currentTime = usePlayerState((s) => s.currentTime);
  const duration = usePlayerState((s) => s.duration);
  // The sleep timer has the last word: no offer when it will stop playback at
  // this episode's end, and nothing at all once it has (the sleep screen is up).
  // An "after 2 episodes" timer that just counted this end still counts down.
  const sleepHides = useSleepTimer((s) => s.asleep !== null || (stopsAtThisEnd(s.timer) && !ended));

  const phase = upNextPhase({
    currentTime,
    duration,
    ended,
    fallbackDurationS,
    creditsStartS: creditsStartFor(skipSegments, duration),
  });
  const visible = phase !== "hidden" && !sleepHides;
  // The player hides its own "Next Episode" skip button while this card shows.
  useEffect(() => {
    usePlayerState.getState().set({ upNextVisible: visible });
    return () => usePlayerState.getState().set({ upNextVisible: false });
  }, [visible]);
  if (!visible) return null;

  return (
    <NextEpisodeCard
      target={target}
      currentSeason={currentSeason}
      autoplay={phase === "countdown"}
      onPlayNow={onPlayNow}
      askStillWatching={askStillWatching}
      onAutoAdvance={onAutoAdvance}
    />
  );
}

/**
 * The next-episode card. It only ever has a countdown once `autoplay` is true
 * (the episode ended); before that it is a plain "Up next" button. Self-contained
 * (own ticking state) so mount/unmount, driven by the parent's per-episode `key`,
 * resets it for every new episode. Ticks via setTimeout callbacks rather than a
 * parent-owned interval.
 */
function NextEpisodeCard({
  target,
  currentSeason,
  autoplay,
  onPlayNow,
  askStillWatching,
  onAutoAdvance,
}: {
  target: { season: number; episode: number };
  currentSeason?: number;
  autoplay: boolean;
  onPlayNow: () => void;
  askStillWatching: () => boolean;
  onAutoAdvance: () => void;
}) {
  const [remaining, setRemaining] = useState(NEXT_EPISODE_COUNTDOWN_S);
  // Several episodes in a row with nobody touching anything: ask before going on.
  const [stillWatching] = useState(askStillWatching);
  const [cancelled, setCancelled] = useState(() => !getAutoplayNext() || stillWatching);
  const firedRef = useRef(false);
  const counting = autoplay && !cancelled;

  useEffect(() => {
    if (!counting) return;
    if (remaining <= 0) {
      if (!firedRef.current) {
        firedRef.current = true;
        onAutoAdvance();
        onPlayNow();
      }
      return;
    }
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining, counting, onPlayNow, onAutoAdvance]);

  if (stillWatching) {
    return (
      <div className="glass-clear absolute bottom-32 right-4 z-40 w-80 rounded-3xl p-5 text-white sm:right-8">
        <div className="font-display text-lg font-semibold">Still watching?</div>
        <p className="mt-1 text-sm text-white/65">Next up: S{target.season} · E{target.episode}</p>
        <div className="mt-4 flex gap-2">
          <Button type="button" data-remote-default onClick={onPlayNow} className="flex-1 rounded-full">
            Keep watching
          </Button>
        </div>
      </div>
    );
  }

  const playLabel =
    target.season !== currentSeason
      ? `Play S${target.season} E${target.episode}`
      : `Play Episode ${target.episode}`;

  return (
    <div className="glass-clear absolute bottom-32 right-4 z-40 w-72 rounded-3xl p-4 text-white sm:right-8">
      <div className="mb-2 text-center text-sm font-medium text-white">
        {counting ? `Next episode in ${remaining}…` : "Up next"}
      </div>
      <div className="flex items-center justify-center gap-2">
        {counting && (
          <Button type="button" variant="ghost" onClick={() => setCancelled(true)} className="rounded-full">
            Cancel
          </Button>
        )}
        <Button type="button" data-remote-default onClick={onPlayNow} className="rounded-full">
          {counting ? "Play now" : playLabel}
        </Button>
      </div>
    </div>
  );
}

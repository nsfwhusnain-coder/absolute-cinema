import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getProvider } from "@/lib/playback";
import type { MediaType, PlaybackResponse, PlaybackSource } from "@/lib/playback";
import { isPlaybackFastPathEnabled } from "@/lib/feature-flags";
import {
  decideImmediateSource,
  type DecidePlaybackOptions,
} from "@/lib/playback/decide-playback";
import { withCdnRates } from "@/lib/playback/debrid/cdn-rate";
import { remuxHasCapacity } from "@/lib/playback/remux-health";
import { bitrateSustainabilityRank } from "@/lib/playback/source-quality";
import { buildFastDebridResponse } from "@/lib/playback/fast-debrid";
import { answerFacts } from "@/lib/playback/answer-facts";
import { RateLimiter } from "@/lib/rate-limit";
import { getUserPlaybackPreferences } from "@/lib/profile-preferences.server";
import {
  consumesTitleResolveBudget,
  playbackRefreshMode,
} from "@/lib/playback/refresh-mode";
import { proxyRecoveryDebridSources } from "@/lib/playback/recovery-proxy";
import { consumePlaybackResolveBudget } from "@/lib/playback/resolve-budget";
import { stampSourceUrlTickets } from "@/lib/playback/source-url-ticket";
import {
  providerHealthRegistry,
  sourcesWithProviderHealth,
} from "@/lib/playback/health-registry";
import {
  applySourceMemory,
  memorySourceKey,
  pickProvenSource,
  sourceMemoryScope,
  type SourceMemoryRecord,
} from "@/lib/playback/source-memory";
import { loadSourceMemory } from "@/lib/playback/source-memory-store";
import { tvQueryIndex } from "@/lib/playback/tv-index";
import { resolvePlaybackContentClass } from "@/lib/playback/content-class";
import { rememberPlaybackRoster } from "@/lib/playback/source-url-cache";
import { resolvePlayableTitle } from "@/lib/catalog/title-alias.server";
import { PlaybackTracker } from "@/lib/playback/playback-observability";
import { parseRouteId } from "@/lib/route-params";
import { logEvent, viewerTag } from "@/lib/event-log";
import { recordPlaybackAnswer } from "@/lib/telemetry/playback-answers";
import { isDiscoveryFinal, noteDiscovery } from "@/lib/telemetry/discovery";

// A title's full answer now goes out as soon as its start is decided and is
// asked for again until the rest has come in: a handful of asks per title
// where there were two or three. The limits allow for it.
const FULL_RESOLVE_PER_TITLE_LIMIT = 24;
const FULL_RESOLVE_PER_USER_LIMIT = 150;
const FULL_RESOLVE_WINDOW_MS = 5 * 60 * 1000;
const fullResolvePerTitleLimiter = new RateLimiter({
  limit: FULL_RESOLVE_PER_TITLE_LIMIT,
  windowMs: FULL_RESOLVE_WINDOW_MS,
});
const fullResolvePerUserLimiter = new RateLimiter({
  limit: FULL_RESOLVE_PER_USER_LIMIT,
  windowMs: FULL_RESOLVE_WINDOW_MS,
});

const NOCACHE_RESOLVE_LIMIT = 6;
const NOCACHE_RESOLVE_WINDOW_MS = 5 * 60 * 1000;
const noCacheResolveLimiter = new RateLimiter({
  limit: NOCACHE_RESOLVE_LIMIT,
  windowMs: NOCACHE_RESOLVE_WINDOW_MS,
});

const RECOVERY_REFRESH_LIMIT = 3;
const RECOVERY_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const recoveryRefreshLimiter = new RateLimiter({
  limit: RECOVERY_REFRESH_LIMIT,
  windowMs: RECOVERY_REFRESH_WINDOW_MS,
});

function tooManyRequests(retryAfterMs: number, message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    }
  );
}

/**
 * GET /api/playback/movie/550
 * GET /api/playback/tv/1399?season=1&episode=1
 *
 * Resolves playback for a title through the currently-configured PlaybackProvider
 * and returns a PlaybackResponse with structured PlaybackTracker observability.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ type: string; id: string }> }
) {
  const url = new URL(req.url);
  const clientPlaybackId =
    req.headers.get("x-playback-id") ||
    url.searchParams.get("playbackId") ||
    undefined;

  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;

  const { type, id } = await ctx.params;
  if (type !== "movie" && type !== "tv") {
    return NextResponse.json({ error: "Invalid media type" }, { status: 400 });
  }

  // Digits only: "-5" or "1.5" used to start a real (wasted) scrape.
  const requestedId = parseRouteId(id);
  if (!requestedId) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const playable = await resolvePlayableTitle(type, requestedId);
  const mediaType = playable.mediaType;
  const tmdbId = playable.tmdbId;

  const seasonParam = url.searchParams.get("season");
  const episodeParam = url.searchParams.get("episode");

  let season = seasonParam != null && seasonParam !== "" ? Number(seasonParam) : undefined;
  let episode = episodeParam != null && episodeParam !== "" ? Number(episodeParam) : undefined;
  if (mediaType === "tv") {
    if (season == null && playable.season != null) season = playable.season;
    if (episode == null && playable.episode != null) episode = playable.episode;
    season = tvQueryIndex(Number.isFinite(season as number) ? season : undefined);
    episode = tvQueryIndex(Number.isFinite(episode as number) ? episode : undefined);
  }

  const tracker = new PlaybackTracker({
    playbackId: clientPlaybackId,
    mediaType,
    tmdbId,
    season,
    episode,
  });

  const wantFast =
    url.searchParams.get("fast") === "1" || url.searchParams.get("prefetch") === "1";
  const fastPathOk = await isPlaybackFastPathEnabled();
  const fast = wantFast && fastPathOk;
  const noCacheRequested = url.searchParams.get("nocache") === "1";
  const recoveryRefreshRequested = url.searchParams.get("refresh") === "1";
  const refreshMode = playbackRefreshMode({
    fast,
    adminNoCacheRequested: noCacheRequested,
    recoveryRefreshRequested,
    isAdmin: user.isAdmin,
  });
  const noCache = refreshMode !== "none";
  const refreshNonce = noCache ? Date.now() : undefined;

  if (!fast) {
    const titleResolveKey =
      `${userId}:${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}`;
    const resolveBudget = consumePlaybackResolveBudget({
      userLimiter: fullResolvePerUserLimiter,
      titleLimiter: fullResolvePerTitleLimiter,
      userKey: userId,
      titleKey: titleResolveKey,
      consumeTitle: consumesTitleResolveBudget(refreshMode),
    });
    if (!resolveBudget.allowed) {
      return tooManyRequests(
        resolveBudget.retryAfterMs,
        "Too many playback resolve requests. Please wait a moment and try again."
      );
    }
  }
  if (noCache) {
    const refreshKey =
      refreshMode === "recovery"
        ? `${userId}:${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}`
        : userId;
    const refreshCheck =
      refreshMode === "recovery"
        ? recoveryRefreshLimiter.consume(refreshKey)
        : noCacheResolveLimiter.consume(refreshKey);
    if (!refreshCheck.allowed) {
      return tooManyRequests(
        refreshCheck.retryAfterMs,
        "Too many forced refreshes. Please wait a few minutes and try again."
      );
    }
  }

  tracker.mark("auth_and_budget_verified", { fast, noCache });

  const [profilePreferences, contentClass, remuxAvailable] = await Promise.all([
    getUserPlaybackPreferences(userId),
    resolvePlaybackContentClass(mediaType, tmdbId),
    remuxHasCapacity(),
  ]);
  const qualityHint = profilePreferences.playbackQuality;
  const want4k = qualityHint === "auto" || (typeof qualityHint === "number" && qualityHint >= 2160);
  const decideOptions = {
    preferredHeight: qualityHint,
    fourKStartup: "fast",
    remuxAvailable,
  } as const;
  const sourceCacheIdentity = {
    userId,
    mediaType,
    tmdbId,
    season,
    episode,
  };

  tracker.mark("preferences_loaded");

  const {
    getCachedPlayback,
    setCachedPlayback,
    playbackCacheKey,
    playbackResponseTtlMs,
  } = await import("@/lib/server-cache");

  const cacheKey = playbackCacheKey(
    mediaType,
    tmdbId,
    season,
    episode,
    fast,
    userId,
    qualityHint,
    contentClass
  );

  // Per-title source memory. Loaded once and used by both the cache-hit and
  // the fresh path, so a proven source leads the roster even on an instant
  // cache hit. Never throws — an unavailable store yields an empty map and
  // ranking falls back to exactly the previous behaviour.
  const sourceMemory = await loadSourceMemory(
    sourceMemoryScope(String(tmdbId), mediaType, season, episode)
  );

  if (!noCache) {
    const cached = getCachedPlayback<PlaybackResponse>(cacheKey);
    if (cached) {
      const healthAware = withRuntimeProviderHealth(
        cached,
        userId,
        mediaType,
        decideOptions,
        sourceMemory
      );
      rememberPlaybackRoster(sourceCacheIdentity, healthAware.sources);
      tracker.mark("cache_hit");
      tracker.setAnswer({ userId, mode: fast ? "fast" : "full", cache: "hit", qualityHint, ...answerFacts(healthAware) });
      tracker.setSelectedSource({
        id: healthAware.streamUrl || "cached",
        quality: healthAware.sources?.[0]?.quality || "auto",
        provider: "cache",
      });
      tracker.logSummary("info");
      recordPlaybackAnswer({ fast, cacheHit: true, status: healthAware.status, totalMs: tracker.getSummary().totalDurationMs });
      if (!fast && isDiscoveryFinal(healthAware)) {
        const summary = noteDiscovery({
          title: { mediaType, tmdbId, season, episode },
          sources: healthAware.sources ?? [],
          want4k,
          qualityHint: qualityHint ?? null,
          cache: true,
        });
        // The viewer goes in as its tag: logEvent prints its fields to the console, and an account id must not reach it.
        if (summary) logEvent("discovery_summary", { viewer: viewerTag(userId), ...summary });
      }

      return NextResponse.json({
        ...healthAware,
        preferences: profilePreferences,
        remuxAvailable,
      }, {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Playback-Cache": "HIT",
          "X-Playback-Id": tracker.playbackId,
          "X-Playback-Timing": tracker.getTimingHeaderValue(),
        },
      });
    }
  }

  tracker.mark("cache_miss_dispatched");
  const provider = await getProvider();

  const debridPromise = fast
    ? resolveFastDebridSourcesSafely({
        tmdbId,
        mediaType,
        season,
        episode,
      })
    : resolveDebridSourcesSafely({
        tmdbId,
        mediaType,
        season,
        episode,
        forceRefresh: noCache,
        want4k,
      });

  const providerRequest = { tmdbId, mediaType, season, episode, userId, fast, noCache, qualityHint, contentClass };
  const providersStartedAt = Date.now();
  const providerPromise = provider.resolve(providerRequest);
  // How long the web providers took, once they have: only a full answer that waited for them records it.
  let providersMs: number | undefined;

  let result: PlaybackResponse;
  if (fast) {
    const debridSources = await debridPromise;
    const debridOnly = buildFastDebridResponse(
      debridSources,
      qualityHint ?? "auto",
      decideOptions
    );
    if (debridOnly) {
      result = debridOnly;
      tracker.mark("fast_debrid_hit", { count: debridSources.length });
      void providerPromise.catch(() => undefined);
      console.info(
        JSON.stringify({
          event: "playback_fast_debrid_hit",
          mediaType,
          tmdbId,
          sourceCount: debridSources.length,
        })
      );
    } else {
      result = await providerPromise;
      tracker.mark("provider_resolved", { count: result.sources?.length ?? 0 });
      mergeDebridSources(result, debridSources, decideOptions);
    }
  } else {
    const providers = { done: false };
    void providerPromise.then(() => {
      providers.done = true;
      providersMs = Date.now() - providersStartedAt;
    }, () => undefined);
    const resolvedDebridSources = await debridPromise;
    const outlook = await debridOutlookSafely(resolvedDebridSources);
    // Once the debrid services have decided what a 4K viewer starts on, the
    // web providers' slow tail (a browser scrape can run 20 s) is not worth
    // holding the answer for: what they have so far goes out, and the rest
    // follows on the player's next ask.
    const startDecided =
      want4k && outlook !== null && (outlook.fourKSettled || resolvedDebridSources.some((s) => (s.maxHeight ?? 0) >= 2160));
    const providerResult =
      providers.done || !startDecided
        ? await providerPromise
        : await Promise.any([providerPromise, provider.resolve({ ...providerRequest, fast: true })]);
    const providersPending = !providers.done;
    tracker.mark("full_resolvers_settled", {
      providerCount: providerResult.sources?.length ?? 0,
      debridCount: resolvedDebridSources.length,
      providersPending,
    });
    const debridSources =
      refreshMode === "recovery" && refreshNonce != null
        ? proxyRecoveryDebridSources(
            userId,
            resolvedDebridSources,
            refreshNonce
          )
        : resolvedDebridSources;
    result = providerResult;
    mergeDebridSources(result, debridSources, decideOptions);
    if (outlook) result = { ...result, fourKSettled: outlook.fourKSettled, debridSettled: outlook.settled };
    if (providersPending || (await isIncompleteDebridRosterSafely(resolvedDebridSources))) {
      // The answer went out early with good sources while slower slots or
      // providers keep resolving; keep the cache short so the player's next
      // poll sees them.
      result = { ...result, partial: true };
    }
  }

  if (result && result.status !== "error") {
    setCachedPlayback(cacheKey, result, playbackResponseTtlMs(result));
  }

  const healthAwareResult = withRuntimeProviderHealth(
    result,
    userId,
    mediaType,
    decideOptions,
    sourceMemory
  );
  rememberPlaybackRoster(sourceCacheIdentity, healthAwareResult.sources);

  tracker.setAnswer({ userId, mode: fast ? "fast" : "full", cache: "miss", qualityHint, ...answerFacts(healthAwareResult) });
  tracker.setSelectedSource({
    id: healthAwareResult.streamUrl || "none",
    quality: healthAwareResult.sources?.[0]?.quality || "auto",
    provider: healthAwareResult.providerId || "scraped",
  });
  tracker.logSummary("info");
  recordPlaybackAnswer({ fast, cacheHit: false, status: healthAwareResult.status, totalMs: tracker.getSummary().totalDurationMs });
  if (!fast && isDiscoveryFinal(healthAwareResult)) {
    const summary = noteDiscovery({
      title: { mediaType, tmdbId, season, episode },
      sources: healthAwareResult.sources ?? [],
      want4k,
      qualityHint: qualityHint ?? null,
      cache: false,
      providersMs,
    });
    if (summary) logEvent("discovery_summary", { viewer: viewerTag(userId), ...summary });
  }

  return NextResponse.json({
    ...healthAwareResult,
    preferences: profilePreferences,
    remuxAvailable,
    ...(refreshNonce != null ? { refreshNonce } : {}),
  }, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Playback-Cache": "MISS",
      "X-Playback-Id": tracker.playbackId,
      "X-Playback-Timing": tracker.getTimingHeaderValue(),
    },
  });
}

function withRuntimeProviderHealth(
  result: PlaybackResponse,
  viewerId: string,
  contentClass: MediaType,
  decideOptions: DecidePlaybackOptions,
  /** Per-title track record. Empty map = behave exactly as before. */
  memory: ReadonlyMap<string, SourceMemoryRecord> = new Map()
): PlaybackResponse {
  if (!result.sources?.length) return result;
  const healthy = sourcesWithProviderHealth(
    withCdnRates(result.sources),
    providerHealthRegistry,
    { contentClass, viewerId }
  );
  // Reorder by what these sources actually did for THIS title, but only within
  // an equal-resolution band — a fondly-remembered 1080p can never displace an
  // available 4K. Provider health above stays the cross-title signal; this is
  // the per-title one, and it runs last so it breaks ties health left open.
  const sources = memory.size
    ? applySourceMemory(healthy, memory, memorySourceKey)
    : healthy;
  // applySourceMemory only reorders the roster the UI sees.
  // decideImmediateSource re-sorts for start, so without this pick the
  // remembered source never actually plays. Proven 4K starts immediately;
  // a proven 1080 is ignored when any 4K is in the roster.
  const remembered = memory.size
    ? pickProvenSource(sources, memory, memorySourceKey)
    : null;
  // A file that played once is not proven on a CDN that has since slowed past carrying it.
  const proven = remembered && bitrateSustainabilityRank(remembered) >= 0 ? remembered : null;
  const best = proven ?? decideImmediateSource(sources, decideOptions);
  const ticketed = stampSourceUrlTickets(sources, viewerId);
  return {
    ...result,
    sources: ticketed,
    streamUrl: best?.url ?? result.streamUrl,
  };
}

async function resolveDebridSourcesSafely(req: {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  forceRefresh?: boolean;
  want4k?: boolean;
}): Promise<PlaybackSource[]> {
  try {
    const { resolveDebridSources } = await import("@/lib/playback/debrid");
    return await resolveDebridSources(req);
  } catch {
    return [];
  }
}

async function debridOutlookSafely(sources: PlaybackSource[]): Promise<{ fourKSettled: boolean; settled: boolean } | null> {
  try {
    const { debridOutlook } = await import("@/lib/playback/debrid");
    return debridOutlook(sources);
  } catch {
    return null;
  }
}

async function isIncompleteDebridRosterSafely(sources: PlaybackSource[]): Promise<boolean> {
  try {
    const { isIncompleteDebridRoster } = await import("@/lib/playback/debrid");
    return isIncompleteDebridRoster(sources);
  } catch {
    return false;
  }
}

async function resolveFastDebridSourcesSafely(req: {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
}): Promise<PlaybackSource[]> {
  try {
    const { resolveFastDebridSources } = await import("@/lib/playback/debrid");
    return await resolveFastDebridSources(req);
  } catch {
    return [];
  }
}

function mergeDebridSources(
  result: PlaybackResponse,
  debridSources: PlaybackSource[],
  decideOptions: DecidePlaybackOptions
): void {
  if (!debridSources.length) return;
  const merged = [...(result.sources ?? []), ...debridSources];
  result.sources = merged;
  const best =
    decideImmediateSource(merged, decideOptions) ??
    merged[0];
  if (!best) return;
  result.streamUrl = best.url;
  if (result.status === "error" || result.status === "not_configured") {
    result.status = "available";
    result.message = undefined;
    result.action = undefined;
  }
}

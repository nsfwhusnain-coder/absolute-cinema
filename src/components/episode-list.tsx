"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, Play } from "lucide-react";
import type { TmdbEpisode } from "@/lib/tmdb";
import { useNavigate } from "@/hooks/use-navigate";
import { useProgress } from "@/hooks/use-progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EpisodeStill } from "@/components/episode-still";
import { cn } from "@/lib/utils";

const SKELETON_ROWS = 5;

interface Props {
  tvId: number;
  season: number;
  seriesPosterPath?: string | null;
  seriesBackdropPath?: string | null;
}

function formatRuntime(minutes: number | null | undefined): string | null {
  if (minutes == null || minutes <= 0) return null;
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatAirDate(date: string | null): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function isUnaired(date: string | null): boolean {
  if (!date) return true;
  return new Date(`${date}T00:00:00`).getTime() > Date.now();
}

/** Full-width episode rows with synopsis, air date and resume progress — the season page layout. */
export function EpisodeList({ tvId, season, seriesPosterPath, seriesBackdropPath }: Props) {
  const navigate = useNavigate();
  const [newestFirst, setNewestFirst] = useState(false);
  const { items: progressItems } = useProgress();

  const { data, isLoading } = useQuery({
    queryKey: ["tmdb", "tv", "season", tvId, season],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/tv/${tvId}/season/${season}`);
      if (!res.ok) return null;
      return res.json() as Promise<{ poster_path?: string | null; episodes?: TmdbEpisode[] }>;
    },
  });

  const episodes = useMemo(() => {
    const list = [...(data?.episodes ?? [])].sort((a, b) => a.episode_number - b.episode_number);
    return newestFirst ? list.reverse() : list;
  }, [data?.episodes, newestFirst]);

  const progressByEpisode = useMemo(() => {
    const map = new Map<number, number>();
    for (const item of progressItems ?? []) {
      if (item.tmdbId === tvId && item.season === season && item.episode != null) {
        map.set(item.episode, item.progress);
      }
    }
    return map;
  }, [progressItems, tvId, season]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
          <div key={i} className="flex gap-4">
            <Skeleton className="aspect-video w-40 shrink-0 rounded-xl sm:w-56" />
            <div className="flex-1 space-y-2 py-1">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {episodes.length} episode{episodes.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          onClick={() => setNewestFirst((v) => !v)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-white/10 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowDownUp className="h-3.5 w-3.5" aria-hidden />
          {newestFirst ? "Newest first" : "Oldest first"}
        </button>
      </div>

      <ol className="divide-y divide-white/5">
        {episodes.map((ep) => {
          const duration = formatRuntime(ep.runtime);
          const aired = formatAirDate(ep.air_date);
          const upcoming = isUnaired(ep.air_date);
          const progress = progressByEpisode.get(ep.episode_number);
          return (
            <li key={ep.id}>
              <button
                type="button"
                disabled={upcoming}
                onClick={() => navigate(`/watch/tv/${tvId}?season=${season}&episode=${ep.episode_number}`)}
                className={cn(
                  "group flex w-full gap-4 rounded-xl p-2 text-left transition-colors sm:gap-5 sm:p-3",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  upcoming ? "cursor-default opacity-60" : "hover:bg-white/[0.04]",
                )}
                aria-label={`${upcoming ? "Upcoming" : "Play"} episode ${ep.episode_number}: ${ep.name}`}
              >
                <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-lg bg-muted sm:w-56">
                  <EpisodeStill
                    stillPath={ep.still_path}
                    seasonPosterPath={data?.poster_path ?? null}
                    seriesBackdropPath={seriesBackdropPath ?? null}
                    seriesPosterPath={seriesPosterPath ?? null}
                    episodeNumber={ep.episode_number}
                  />
                  {!upcoming && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/40">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-black opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                        <Play className="h-4 w-4 translate-x-0.5 fill-current" aria-hidden />
                      </span>
                    </div>
                  )}
                  {progress != null && progress > 0 && (
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                      <div className="h-full bg-primary" style={{ width: `${Math.min(100, progress * 100)}%` }} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 py-0.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="line-clamp-1 font-semibold text-white">
                      <span className="mr-2 tabular-nums text-muted-foreground">{ep.episode_number}</span>
                      {ep.name}
                    </h3>
                    {duration && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{duration}</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {upcoming ? (aired ? `Airs ${aired}` : "Coming soon") : aired}
                  </p>
                  {ep.overview && (
                    <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-white/70 sm:line-clamp-3">
                      {ep.overview}
                    </p>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

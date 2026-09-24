"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TmdbEpisode } from "@/lib/tmdb";
import { EpisodeStill } from "@/components/episode-still";
import { cn } from "@/lib/utils";
import { PlayerMenu } from "./ui";

export interface SeasonOption {
  season_number: number;
  name: string;
  episode_count?: number;
}

/** Season picker and episode list inside the player. */
export function EpisodesMenu({
  tvId,
  seasons,
  season,
  episode,
  onSelect,
}: {
  tvId: number;
  seasons: SeasonOption[];
  season: number;
  episode: number;
  onSelect: (season: number, episode: number) => void;
}) {
  const [viewSeason, setViewSeason] = useState(season);
  const { data, isLoading } = useQuery({
    queryKey: ["tmdb", "tv", "season", tvId, viewSeason],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/tv/${tvId}/season/${viewSeason}`);
      if (!res.ok) return null;
      return res.json() as Promise<{ poster_path?: string | null; episodes?: TmdbEpisode[] }>;
    },
    staleTime: 10 * 60 * 1000,
  });

  return (
    <PlayerMenu title="Episodes" className="w-[min(94vw,28rem)]">
      {seasons.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto px-2 pb-2">
          {seasons.map((s) => (
            <button
              key={s.season_number}
              type="button"
              onClick={() => setViewSeason(s.season_number)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                s.season_number === viewSeason ? "bg-white text-black" : "bg-[var(--mat-fill-hover)] text-white hover:bg-[var(--mat-fill-active)]"
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {isLoading && <p className="px-3 py-6 text-center text-sm text-white/60">Loading episodes…</p>}
      <ol className="space-y-1">
        {(data?.episodes ?? []).map((ep) => {
          const current = viewSeason === season && ep.episode_number === episode;
          return (
            <li key={ep.id}>
              <button
                type="button"
                onClick={() => onSelect(viewSeason, ep.episode_number)}
                aria-current={current ? "true" : undefined}
                className={cn(
                  "flex w-full gap-3 rounded-2xl p-2 text-left transition-colors hover:bg-[var(--mat-fill-hover)] focus-visible:bg-[var(--mat-fill-hover)] focus-visible:outline-none",
                  current && "bg-[var(--mat-fill-active)]"
                )}
              >
                <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-xl bg-white/5">
                  <EpisodeStill
                    stillPath={ep.still_path}
                    seasonPosterPath={data?.poster_path ?? null}
                    seriesBackdropPath={null}
                    seriesPosterPath={null}
                    episodeNumber={ep.episode_number}
                  />
                </div>
                <div className="min-w-0 flex-1 py-0.5">
                  <div className="truncate text-sm font-semibold">
                    {ep.episode_number}. {ep.name}
                  </div>
                  {ep.overview && <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-white/60">{ep.overview}</p>}
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </PlayerMenu>
  );
}

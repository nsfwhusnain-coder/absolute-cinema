"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useShowProgress } from "@/hooks/use-progress";
import { useQuery } from "@tanstack/react-query";
import type { TmdbEpisode } from "@/lib/tmdb";
import { EpisodeStill } from "@/components/episode-still";
import { cn } from "@/lib/utils";
import { PlayerMenu } from "./ui";
import { tvSeasonQuery } from "@/lib/tv-season-query";

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
    ...tvSeasonQuery<{ poster_path?: string | null; episodes?: TmdbEpisode[] }>(tvId, viewSeason),
  });
  const progress = useShowProgress(tvId);
  // Open on the episode playing, not at the top of a 20-episode season.
  const list = useRef<HTMLOListElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chips.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, []);
  const loaded = Boolean(data?.episodes?.length);
  useEffect(() => {
    if (!loaded) return;
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "center" });
  }, [loaded, viewSeason]);

  return (
    <PlayerMenu title="Episodes" className="w-[min(94vw,28rem)]">
      {seasons.length > 1 && (
        <div ref={chips} className="flex gap-1.5 overflow-x-auto px-2 pb-2">
          {seasons.map((s) => (
            <button
              key={s.season_number}
              type="button"
              onClick={() => setViewSeason(s.season_number)}
              data-active={s.season_number === viewSeason}
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
      <ol ref={list} className="space-y-1">
        {(data?.episodes ?? []).map((ep) => {
          const current = viewSeason === season && ep.episode_number === episode;
          const saved = progress.get(`${viewSeason}:${ep.episode_number}`);
          const watched = saved != null && saved.progress >= 0.95;
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
                  {watched ? (
                    <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white" title="Watched">
                      <Check className="h-3 w-3" aria-label="Watched" />
                    </span>
                  ) : saved && saved.progress > 0.02 && !current ? (
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                      <div className="h-full bg-white" style={{ width: `${Math.min(100, saved.progress * 100)}%` }} />
                    </div>
                  ) : null}
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

"use client";

import { useState } from "react";

import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/hooks/use-navigate";
import { tmdbImageUrl } from "@/lib/tmdb";
import { transitionContent } from "@/lib/motion";
import { ArrowLeft } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SeasonPicker } from "@/components/season-picker";
import { EpisodeList } from "@/components/episode-list";
import { BrowseError } from "@/components/empty-states";
import { tvSeasonQuery } from "@/lib/tv-season-query";
import { cn } from "@/lib/utils";

interface Props {
  tvId: number;
  season: number;
}

export function TvSeasonView({ tvId, season }: Props) {
  const navigate = useNavigate();

  const {
    data: show,
    isLoading: showLoading,
    isError: showFailed,
    refetch: refetchShow,
  } = useQuery({
    queryKey: ["tmdb", "tv", "details", tvId],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/tv/${tvId}`);
      if (!res.ok) throw new Error("Failed to load show");
      return res.json();
    },
  });

  const {
    data: seasonData,
    isError: seasonFailed,
    refetch: refetchSeason,
  } = useQuery({
    ...tvSeasonQuery<any>(tvId, season),
  });

  const poster = tmdbImageUrl(seasonData?.poster_path ?? show?.poster_path, "w342");

  // Show itself failed to load — nothing else on the page can render meaningfully.
  if (showFailed && !showLoading) {
    return (
      <div className="min-h-screen px-4 pt-24 pb-12 text-center sm:px-6 lg:px-8">
        <BrowseError label="this show" onRetry={() => refetchShow()} />
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 pt-20 pb-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <button
          onClick={() => navigate(`/tv/${tvId}`)}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <ArrowLeft className="h-4 w-4" /> Back to {show?.name || "show"}
        </button>

        <motion.div
          className="flex gap-4 sm:gap-6"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transitionContent}
        >
          <div className="hidden shrink-0 sm:block sm:w-40 lg:w-48">
            {poster ? (
              <img src={poster} alt={seasonData?.name} className="sticky top-24 w-full rounded-2xl shadow-lg" />
            ) : (
              <Skeleton className="w-32 h-48 rounded-2xl" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            {/* Sized while loading, so the name arriving doesn't push the page down. */}
            <h1 className="min-h-[2rem] font-display text-2xl font-bold sm:min-h-[2.5rem] sm:text-4xl">
              {show?.name ?? <span className="inline-block h-8 w-48 animate-pulse rounded-md bg-white/10 align-middle sm:h-10" />}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <h2 className="font-display text-sm font-semibold">Episodes</h2>
              {showLoading || !show?.seasons ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <SeasonPicker
                  seasons={show.seasons}
                  value={season}
                  onChange={(s) => navigate(`/tv/${tvId}/season/${s}`)}
                />
              )}
            </div>
            {seasonData ? (
              seasonData.overview ? <SeasonOverview text={seasonData.overview} /> : null
            ) : (
              // Room for three lines while the season loads: the overview and
              // the episodes arrive together, and the list used to jump down
              // under a long synopsis (a 0.22 layout shift on phones).
              <div className="mt-2 max-w-2xl space-y-1.5" aria-hidden>
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-11/12" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
            )}

            <div className="mt-5">
              {seasonFailed ? (
                <BrowseError label="episodes" onRetry={() => refetchSeason()} compact />
              ) : (
                <EpisodeList
                  tvId={tvId}
                  season={season}
                  seriesPosterPath={show?.poster_path}
                  seriesBackdropPath={show?.backdrop_path}
                />
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

/** The season synopsis in three lines, with the rest a tap away (some run to a whole screen on a phone). */
function SeasonOverview({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  return (
    <div className="mt-2 max-w-2xl">
      <p className={cn("text-sm text-muted-foreground", !open && long && "line-clamp-3")}>{text}</p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-xs font-semibold text-white/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          {open ? "Show less" : "More"}
        </button>
      )}
    </div>
  );
}

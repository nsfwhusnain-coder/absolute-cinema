"use client";

import { useQuery } from "@tanstack/react-query";
import { MovieRow } from "@/components/movie-row";
import { MovieCard } from "@/components/movie-card";
import { MovieRowSkeleton } from "@/components/skeletons";
import { useHideAdult } from "@/hooks/use-hide-adult";
import { showcase, withoutAdultTitles } from "@/lib/tmdb";
import { fetchTmdbPages, type MediaKind, type TmdbListItem } from "@/lib/tmdb-client";
import { providerPath, type StreamingService } from "@/lib/browse-categories";

const RAIL_CARD_LIMIT = 16;
const RAIL_PAGES = 2;
const RAIL_STALE_MS = 6 * 60 * 60 * 1000;

interface Source {
  path: string;
  mediaType: MediaKind;
}

/** Interleave several lists (movies, series) so neither type dominates the rail. */
function interleave(lists: TmdbListItem[][]): TmdbListItem[] {
  const out: TmdbListItem[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (list[i]) out.push(list[i]);
  }
  return out;
}

/**
 * A rail that fetches its own data. Meant to sit inside <LazyRail> so the
 * request only happens once the row scrolls near the viewport.
 */
export function CatalogRail({
  title,
  viewAllHref,
  sources,
  showcaseOnly = false,
}: {
  title: string;
  viewAllHref?: string;
  sources: Source[];
  /** Home rails: only popular, well-rated titles with artwork. */
  showcaseOnly?: boolean;
}) {
  const hideAdult = useHideAdult();
  const { data, isLoading } = useQuery({
    queryKey: ["tmdb", "catalog-rail", ...sources.map((s) => s.path)],
    queryFn: async () => {
      const lists = await Promise.all(
        sources.map(async (s) =>
          (await fetchTmdbPages(s.path, RAIL_PAGES)).map((m) => ({ ...m, media_type: s.mediaType })),
        ),
      );
      return interleave(lists);
    },
    staleTime: RAIL_STALE_MS,
  });

  if (isLoading) return <MovieRowSkeleton />;
  const all = withoutAdultTitles(data ?? [], hideAdult).filter((m) => m.poster_path);
  const items = showcaseOnly ? showcase(all) : all;
  if (items.length === 0) return null;

  return (
    <MovieRow title={title} viewAllHref={viewAllHref}>
      {items.slice(0, RAIL_CARD_LIMIT).map((m) => (
        <MovieCard
          key={`${m.media_type}-${m.id}`}
          movie={m}
          forceMediaType={m.media_type === "tv" ? "tv" : "movie"}
        />
      ))}
    </MovieRow>
  );
}

/** "On Disney+" etc. — movies and series from one streaming service. */
export function ServiceRail({ service }: { service: StreamingService }) {
  return (
    <CatalogRail
      title={`On ${service.name}`}
      viewAllHref={`/browse/${service.slug}-movies`}
      showcaseOnly
      sources={[
        { path: providerPath("movie", service.providerId, 1), mediaType: "movie" },
        { path: providerPath("tv", service.providerId, 1), mediaType: "tv" },
      ]}
    />
  );
}

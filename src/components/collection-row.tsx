"use client";

import { useQuery } from "@tanstack/react-query";
import { MovieCard, type MovieCardData } from "@/components/movie-card";
import { MovieRow } from "@/components/movie-row";
import { useHideAdult } from "@/hooks/use-hide-adult";
import { withoutAdultTitles } from "@/lib/tmdb-filters";

interface CollectionResponse {
  name: string;
  parts?: Array<MovieCardData & { release_date?: string | null }>;
}

/** Every film in the series a movie belongs to, in release order. */
export function CollectionRow({ collectionId }: { collectionId: number }) {
  const hideAdult = useHideAdult();
  const { data } = useQuery({
    queryKey: ["tmdb", "collection", collectionId],
    queryFn: async (): Promise<CollectionResponse> => {
      const res = await fetch(`/api/tmdb/collection/${collectionId}`);
      if (!res.ok) throw new Error("collection unavailable");
      return res.json();
    },
    staleTime: 24 * 60 * 60 * 1000,
  });
  const parts = withoutAdultTitles(data?.parts ?? [], hideAdult)
    .filter((part) => part.poster_path)
    .sort((a, b) => (a.release_date || "9999").localeCompare(b.release_date || "9999"));
  if (!data || parts.length < 2) return null;
  return (
    <MovieRow title={data.name}>
      {parts.map((part) => (
        <MovieCard key={part.id} movie={{ ...part, media_type: "movie" }} forceMediaType="movie" />
      ))}
    </MovieRow>
  );
}

/**
 * The rows on Home a profile can hide (Settings → Home). Continue Watching
 * and Top 10 always stay. Ids are stored per profile in `homeHidden`.
 */
import { STREAMING_SERVICES } from "@/lib/browse-categories";

export interface HomeRowOption {
  id: string;
  label: string;
}

export const HOME_ROWS: readonly HomeRowOption[] = [
  { id: "because", label: "Because you watched…" },
  { id: "trending-movies", label: "Trending Movies" },
  { id: "trending-series", label: "Trending Series" },
  { id: "new-digital", label: "New Movies" },
  { id: "new-series", label: "New Series" },
  { id: "acclaimed", label: "Acclaimed Right Now" },
  { id: "netflix-movies", label: "Movies on Netflix" },
  { id: "netflix-series", label: "TV Series on Netflix" },
  ...STREAMING_SERVICES.map((s) => ({ id: `service:${s.slug}`, label: s.name })),
  { id: "top-rated-movies", label: "Top Rated Movies" },
  { id: "top-rated-series", label: "Top Rated Series" },
];

/**
 * The one definition of the season query. Five places read a season (season
 * page, episode list, episode strip, player episodes menu, watch page) and
 * each had its own fetcher under the same key: some returned null on an
 * error and some threw, so whichever ran first decided what the others saw,
 * and a failed fetch could be cached as "a season with no episodes" with no
 * retry. Sharing one fetcher that throws keeps errors errors.
 */
export const TV_SEASON_STALE_MS = 10 * 60 * 1000;

export function tvSeasonQueryKey(tvId: number, season: number | undefined) {
  return ["tmdb", "tv", "season", tvId, season] as const;
}

export function tvSeasonQuery<T>(tvId: number, season: number | undefined) {
  return {
    queryKey: tvSeasonQueryKey(tvId, season),
    queryFn: async (): Promise<T> => {
      const res = await fetch(`/api/tmdb/tv/${tvId}/season/${season}`);
      if (!res.ok) throw Object.assign(new Error("Failed to load season"), { status: res.status });
      return (await res.json()) as T;
    },
    staleTime: TV_SEASON_STALE_MS,
  };
}

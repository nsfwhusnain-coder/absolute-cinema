/**
 * Which episode comes after the one playing: the next in its season, else the
 * first of the next regular season, never one that has not aired yet, and
 * never out of Specials into Season 1.
 */

export interface SeasonMeta {
  season_number: number;
  episode_count: number;
  name?: string;
}

export interface AiredEpisode {
  season_number: number;
  episode_number: number;
}

/** True when (season, episode) comes after the last episode that has aired. */
function afterLastAired(target: { season: number; episode: number }, lastAired: AiredEpisode | null | undefined): boolean {
  if (!lastAired || !(lastAired.season_number > 0)) return false;
  return target.season > lastAired.season_number || (target.season === lastAired.season_number && target.episode > lastAired.episode_number);
}

export function resolveNextEpisode(
  seasons: SeasonMeta[] | undefined,
  season: number,
  episode: number,
  lastAired?: AiredEpisode | null
): { season: number; episode: number } | null {
  // Soft fallback when seasons meta not loaded yet — prefer advancing in-season.
  if (!seasons?.length) {
    return { season, episode: episode + 1 };
  }
  // Specials (season 0) run on within their own list and never roll into
  // Season 1: the next special, or nothing.
  if (season === 0) {
    const specials = seasons.find((s) => s.season_number === 0)?.episode_count ?? 0;
    return episode < specials ? { season: 0, episode: episode + 1 } : null;
  }
  // Regular seasons only for rollover (skip specials / S0). A season's
  // episode_count includes announced episodes that have not aired yet, so the
  // last aired episode caps it: finishing the newest episode of a running show
  // must not count down into one that does not exist yet.
  const regular = seasons.filter((s) => s.season_number > 0 && s.episode_count > 0);
  const current = regular.find((s) => s.season_number === season);
  const count = current?.episode_count ?? 0;
  if (count > 0 && episode < count) {
    const next = { season, episode: episode + 1 };
    return afterLastAired(next, lastAired) ? null : next;
  }
  // Last ep of season → first ep of next regular season with content.
  const nextSeason = regular
    .filter((s) => s.season_number > season)
    .sort((a, b) => a.season_number - b.season_number)[0];
  if (nextSeason) {
    const next = { season: nextSeason.season_number, episode: 1 };
    return afterLastAired(next, lastAired) ? null : next;
  }
  // End of series (or only specials remaining).
  return null;
}

/**
 * Continue Watching: one card per title.
 * TV shows collapse to the most recently updated episode (resume point).
 */

export interface ContinueProgressLike {
  tmdbId: number;
  mediaType: string;
  season?: number | null;
  episode?: number | null;
}

/**
 * Keep movies as-is. For TV, keep only the latest-left episode per show
 * (first occurrence when items are already newest-first by updatedAt).
 */
export function collapseContinueItems<T extends ContinueProgressLike>(items: T[]): T[] {
  if (!items.length) return [];
  const seen = new Set<string>();
  const out: T[] = [];

  for (const item of items) {
    const mediaType = (item.mediaType || "movie").toLowerCase();
    const key =
      mediaType === "tv"
        ? `tv:${item.tmdbId}`
        : `movie:${item.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

export interface ResumeRow extends ContinueProgressLike {
  progress?: number;
  updatedAt?: string;
  /** The server's "next episode" for a show whose latest episode was finished. */
  upNext?: boolean;
}

/**
 * The episode Play should open for a show: the most recently watched
 * in-progress episode, or the next one after a finished episode. Null means
 * nothing to resume (the caller starts at S1E1). Season 0 (Specials) counts.
 */
export function resumeTvEpisode(rows: ResumeRow[] | undefined, tmdbId: number): { season: number; episode: number } | null {
  if (!rows?.length) return null;
  const candidates = rows
    .filter(
      (p) =>
        Number(p.tmdbId) === Number(tmdbId) &&
        p.mediaType === "tv" &&
        p.season != null &&
        Number(p.season) >= 0 &&
        p.episode != null &&
        Number(p.episode) > 0 &&
        (p.upNext === true || ((p.progress ?? 0) > 0.02 && (p.progress ?? 0) < 0.95))
    )
    .sort((a, b) => (b.updatedAt ? Date.parse(b.updatedAt) : 0) - (a.updatedAt ? Date.parse(a.updatedAt) : 0));
  const best = candidates[0];
  return best ? { season: Number(best.season), episode: Number(best.episode) } : null;
}

/** Saved positions this close to either end are a title not really begun, or finished. */
const RESUME_MIN_PROGRESS = 0.02;
const RESUME_MAX_PROGRESS = 0.95;
const RESUME_MIN_SECONDS = 5;

/** Where a saved row says to pick up from, in seconds; 0 to start from the beginning. */
export function resumeSeconds(row: { progress: number; position: number; duration: number } | undefined): number {
  if (!row || !(row.progress > RESUME_MIN_PROGRESS && row.progress < RESUME_MAX_PROGRESS && row.duration > 0)) return 0;
  const position = Number(row.position) || 0;
  const seconds = position > RESUME_MIN_SECONDS ? position : (Number(row.progress) || 0) * (Number(row.duration) || 0);
  return seconds > RESUME_MIN_SECONDS ? seconds : 0;
}

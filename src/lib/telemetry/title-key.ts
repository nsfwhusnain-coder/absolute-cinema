/** A title as the telemetry keys it: the same string wherever the same title is named. */
export interface TitleRef {
  mediaType: string;
  tmdbId: number;
  season?: number | null;
  episode?: number | null;
}

/**
 * The title as one string for a map key. Only a show has a season and an
 * episode: a film asked with a stray season reads as the same film, so the
 * debrid resolver and the answer that follows it always meet on one key.
 */
export function titleKey(title: TitleRef): string {
  const show = title.mediaType === "tv";
  const season = show ? (title.season ?? 0) : 0;
  const episode = show ? (title.episode ?? 0) : 0;
  return `${title.mediaType}:${title.tmdbId}:${season}:${episode}`;
}

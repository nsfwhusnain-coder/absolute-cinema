/**
 * The debrid tier's check that a file is the title that was asked for.
 *
 * See release-identity.ts for how a name is judged. This holds what each
 * title is known as (fetched once per title) and applies the judgement at the
 * three places a wrong file could get through: a candidate from the index, a
 * file a debrid service resolved it to, and a link read back from the cache.
 */

import { cachedFetch } from "@/lib/server-cache";
import { tmdb, type TmdbNames } from "@/lib/tmdb";
import { judgeRelease, type ReleaseVerdict, type TitleFacts } from "../release-identity";
import type { MediaType } from "../types";

const FACTS_TTL_MS = 6 * 60 * 60 * 1000;
/** Titles whose facts are kept by IMDb id, for the cache readers that are only handed that. */
const REMEMBERED = 400;

const byImdbId = new Map<string, TitleFacts>();

function yearOf(date: string | null | undefined): number | null {
  const year = Number((date ?? "").slice(0, 4));
  return Number.isInteger(year) && year > 1880 ? year : null;
}

/** The names and year of a title, from what the catalogue says of it. */
export function titleFactsFrom(names: TmdbNames): TitleFacts {
  const all = [
    names.title,
    names.name,
    names.original_title,
    names.original_name,
    ...(names.alternative_titles?.titles ?? names.alternative_titles?.results ?? []).map((entry) => entry.title),
    ...(names.translations?.translations ?? []).map((entry) => entry.data?.title ?? entry.data?.name),
  ];
  const titles = [...new Set(all.map((title) => (title ?? "").trim()).filter(Boolean))];
  return { titles, year: yearOf(names.release_date ?? names.first_air_date) };
}

/** Fetches (once per title) what a title is known as, and remembers it under its IMDb id. Null when the catalogue cannot be reached. */
export async function loadTitleFacts(imdbId: string, tmdbId: number, mediaType: MediaType): Promise<TitleFacts | null> {
  try {
    const names = await cachedFetch(`tmdb-names:${mediaType}:${tmdbId}`, () => tmdb.names(tmdbId, mediaType), FACTS_TTL_MS);
    const facts = titleFactsFrom(names);
    if (!facts.titles.length) return null;
    byImdbId.delete(imdbId);
    byImdbId.set(imdbId, facts);
    while (byImdbId.size > REMEMBERED) byImdbId.delete(byImdbId.keys().next().value as string);
    return facts;
  } catch {
    return null;
  }
}

export function titleFactsFor(imdbId: string): TitleFacts | null {
  return byImdbId.get(imdbId) ?? null;
}

/** The name of the file a link points at. */
export function linkFileName(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return "";
  }
}

const EPISODE_TAG = /(?<![a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?![0-9])/i;

/** True when a file name states an episode, and it is not the one asked for. */
export function isOtherEpisode(fileName: string, season: number | undefined, episode: number | undefined): boolean {
  if (!season || !episode) return false;
  const tag = fileName.match(EPISODE_TAG);
  return tag !== null && (Number(tag[1]) !== season || Number(tag[2]) !== episode);
}

export interface IdentityQuestion {
  mediaType: MediaType;
  /** The release (torrent) name. */
  release: string;
  /** The file inside it that would be played, when known: from the index's hint or the resolved link. */
  fileName?: string;
  season?: number;
  episode?: number;
}

/**
 * Whether a source is another title than the one asked for. The file's own
 * name is the better witness when it has one to read: a file named for the
 * film is the film, whatever collection it sits in, and a file named for
 * another is not, whatever the release was called.
 */
export function isWrongTitle(facts: TitleFacts | null, question: IdentityQuestion): boolean {
  if (question.mediaType === "tv" && isOtherEpisode(question.fileName ?? "", question.season, question.episode)) return true;
  if (!facts) return false;
  const file: ReleaseVerdict = question.fileName ? judgeRelease(question.fileName, facts, question.mediaType) : "unknown";
  if (file === "match") return false;
  // An episode's file is often named for the episode alone ("01 - Pilot"), which says nothing about the show.
  if (file === "mismatch" && question.mediaType === "movie") return true;
  return judgeRelease(question.release, facts, question.mediaType) === "mismatch";
}

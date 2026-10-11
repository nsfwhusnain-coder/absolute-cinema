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
import { countedEpisode, judgeReleaseName, type ReleaseJudgement, type TitleFacts } from "../release-identity";
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
  const seasonYears: Record<number, number> = {};
  for (const season of names.seasons ?? []) {
    const year = yearOf(season.air_date);
    if (season.season_number && year) seasonYears[season.season_number] = year;
  }
  return { titles, year: yearOf(names.release_date ?? names.first_air_date), ...(names.seasons?.length ? { seasonYears } : {}) };
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

/** "verified" names the title outright; "unverified" was kept for want of anything against it. */
export type Identity = "verified" | "unverified" | "wrong";

/**
 * Whether a film's file is the film, by its own name and its release's. The
 * file is the better witness when it has a name to read: one named for the
 * film is the film whatever collection it sits in, and one that says it is
 * another is not, whatever the release was called.
 */
function identifyFilm(file: ReleaseJudgement, release: ReleaseJudgement): Identity {
  if (file.contradicts) return "wrong";
  // Under a variation of the film's name, with its year: the film, out of a pack that names no one film.
  if (file.related) return release.verdict === "match" ? "verified" : "unverified";
  if (file.verdict !== "mismatch") return release.verdict === "mismatch" ? "wrong" : release.verdict === "match" ? "verified" : "unverified";
  // Under a name not on the list ("gfp1-tcr-1080p.mkv"): only a release that names the film vouches for it.
  return release.verdict === "match" || release.related ? "unverified" : "wrong";
}

/** A first season's episodes may be numbered on from a hundred: "Show.105" is its fifth. */
const FIRST_SEASON_HUNDRED = 100;

/**
 * True when a file counts itself, with no season tag, as another episode
 * ("One Piece 640" for the first). Only a first season is checked: later ones
 * may count on from the seasons before, and how far is not known here.
 */
function countsAnotherEpisode(facts: TitleFacts, question: IdentityQuestion): boolean {
  const episode = question.episode;
  if (question.season !== 1 || !episode || !question.fileName) return false;
  const counted = countedEpisode(question.fileName, facts);
  if (!counted) return false;
  const within = (number: number) => number >= counted.from && number <= counted.to;
  return !within(episode) && !within(FIRST_SEASON_HUNDRED + episode);
}

/** Whether a source is the title asked for. */
export function identify(facts: TitleFacts | null, question: IdentityQuestion): Identity {
  if (question.mediaType === "tv" && isOtherEpisode(question.fileName ?? "", question.season, question.episode)) return "wrong";
  if (!facts) return "unverified";
  if (question.mediaType === "tv" && countsAnotherEpisode(facts, question)) return "wrong";
  const asked = { season: question.season };
  const file = question.fileName ? judgeReleaseName(question.fileName, facts, question.mediaType, asked) : null;
  // A file of the right name is the show; a release that states it is a later show of that name still decides.
  const release = judgeReleaseName(question.release, facts, question.mediaType, asked);
  if (question.mediaType === "tv" && (file?.anotherYear || release.anotherYear)) return "wrong";
  if (file?.verdict === "match") return "verified";
  // An episode's file is often named for the episode alone ("01 - Pilot"), which says nothing about the show.
  if (file && question.mediaType === "movie") return identifyFilm(file, release);
  if (release.verdict === "mismatch") return "wrong";
  return release.verdict === "match" ? "verified" : "unverified";
}

export function isWrongTitle(facts: TitleFacts | null, question: IdentityQuestion): boolean {
  return identify(facts, question) === "wrong";
}

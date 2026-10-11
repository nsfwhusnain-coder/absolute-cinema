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
import { isTmdbAnimeTitle } from "@/lib/tmdb-anime";
import { countedEpisode, countsAnotherShow, judgeReleaseName, normalizeTitle, type ReleaseJudgement, type TitleFacts } from "../release-identity";
import type { MediaType } from "../types";

const FACTS_TTL_MS = 6 * 60 * 60 * 1000;
/** Titles whose facts are kept by IMDb id, for the cache readers that are only handed that. */
const REMEMBERED = 400;

const byImdbId = new Map<string, TitleFacts>();

/** The count after the name of a season that shares its name with the one before it. */
const SEASON_COUNT = /\s*\(\d+\)$/;
/** A season called by its number alone, which is no name to know it by. */
const GENERIC_SEASON = /^(?:season|series|saison|staffel|temporada|specials?|extras?)(?:\s+\d+)?$/i;

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
  // A season with a name of its own is released under the show's name and then its own: "Bleach: Thousand-Year Blood War".
  const show = names.name ?? names.title ?? "";
  const seasonNames: Record<number, string> = {};
  for (const season of names.seasons ?? []) {
    // "Dressrosa (2)" is the second season of that name; a season called what the show is called has no name of its own.
    const name = (season.name ?? "").replace(SEASON_COUNT, "").trim();
    const own = name && !GENERIC_SEASON.test(name) && normalizeTitle(name) !== normalizeTitle(show);
    if (season.season_number && own) seasonNames[season.season_number] = name;
  }
  all.push(...Object.values(seasonNames).map((season) => `${show} ${season}`));
  const titles = [...new Set(all.map((title) => (title ?? "").trim()).filter(Boolean))];
  const seasonYears: Record<number, number> = {};
  for (const season of names.seasons ?? []) {
    const year = yearOf(season.air_date);
    if (season.season_number && year) seasonYears[season.season_number] = year;
  }
  const anime = isTmdbAnimeTitle({ genres: names.genres, originalLanguage: names.original_language, originCountry: names.origin_country });
  return {
    titles,
    year: yearOf(names.release_date ?? names.first_air_date),
    ...(names.seasons?.length ? { seasonYears } : {}),
    ...(Object.keys(seasonNames).length ? { seasonNames } : {}),
    ...(anime ? { anime } : {}),
  };
}

/** Keeps a title's facts under its IMDb id, the newest few hundred titles. */
export function rememberTitleFacts(imdbId: string, facts: TitleFacts): void {
  byImdbId.delete(imdbId);
  byImdbId.set(imdbId, facts);
  while (byImdbId.size > REMEMBERED) byImdbId.delete(byImdbId.keys().next().value as string);
}

/** Fetches (once per title) what a title is known as, and remembers it under its IMDb id. Null when the catalogue cannot be reached. */
export async function loadTitleFacts(imdbId: string, tmdbId: number, mediaType: MediaType): Promise<TitleFacts | null> {
  try {
    const names = await cachedFetch(`tmdb-names:${mediaType}:${tmdbId}`, () => tmdb.names(tmdbId, mediaType), FACTS_TTL_MS);
    const facts = titleFactsFrom(names);
    if (!facts.titles.length) return null;
    rememberTitleFacts(imdbId, facts);
    return facts;
  } catch {
    return null;
  }
}

export function titleFactsFor(imdbId: string): TitleFacts | null {
  return byImdbId.get(imdbId) ?? null;
}

/**
 * Adds names a title turned out to go by to what is remembered of it: a
 * season or part of an anime is released under a name of its own ("Bleach:
 * Sennen Kessen-hen"), which only the anime's own catalogue lists. Every
 * later check of that title knows them.
 */
export function addTitleNames(imdbId: string, names: readonly string[]): TitleFacts | null {
  const facts = byImdbId.get(imdbId);
  if (!facts) return null;
  const titles = [...new Set([...facts.titles, ...names.map((name) => name.trim()).filter(Boolean)])];
  if (titles.length === facts.titles.length) return facts;
  const wider = { ...facts, titles };
  byImdbId.set(imdbId, wider);
  return wider;
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

/**
 * True when a file name states an episode, and it is not the one asked for.
 * Anime is cut into seasons differently from one catalogue to the next
 * ("S17E03" is the third episode of what this one calls the second season),
 * so for anime another season's number says nothing, except that a first
 * season is never a later one.
 */
export function isOtherEpisode(fileName: string, season: number | undefined, episode: number | undefined, anime = false): boolean {
  if (!season || !episode) return false;
  const tag = fileName.match(EPISODE_TAG);
  if (!tag) return false;
  if (Number(tag[1]) === season) return Number(tag[2]) !== episode;
  return !anime || season === 1;
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

/** A season's name shorter than this is too ordinary a word to find in a file's name ("Fire"). */
const SEASON_NAME_MIN_LENGTH = 6;

/**
 * True when a file is named for another season of the show than the one
 * asked for: "Dressrosa 02" is the second episode of that season, not of the
 * first. A release's name is not read this way: a pack lists every season it
 * holds.
 */
function namesAnotherSeason(facts: TitleFacts, question: IdentityQuestion): boolean {
  if (!question.season || !question.fileName) return false;
  const file = ` ${normalizeTitle(question.fileName)} `;
  const named = (season: string) => {
    const name = normalizeTitle(season);
    return name.length >= SEASON_NAME_MIN_LENGTH && file.includes(` ${name} `);
  };
  const seasons = Object.entries(facts.seasonNames ?? {});
  if (seasons.some(([number, name]) => Number(number) === question.season && named(name))) return false;
  return seasons.some(([number, name]) => Number(number) !== question.season && named(name));
}

/** Whether a source is the title asked for. */
export function identify(facts: TitleFacts | null, question: IdentityQuestion): Identity {
  if (question.mediaType === "tv" && isOtherEpisode(question.fileName ?? "", question.season, question.episode, facts?.anime)) return "wrong";
  if (!facts) return "unverified";
  if (question.mediaType === "tv" && (countsAnotherEpisode(facts, question) || namesAnotherSeason(facts, question))) return "wrong";
  // Anime batches carry specials and side series, each numbered from one like the show itself.
  if (question.mediaType === "tv" && facts.anime && question.fileName && countsAnotherShow(question.fileName, facts)) return "wrong";
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

/**
 * Releases that were opened as a title and could not be played as it: a file
 * nowhere near the title's length (see /api/vod/open), or one the remuxer
 * cannot start at all (see /api/vod/[id]/[file]). Dropping the cached link is
 * not enough for either: the release ranked first for a reason, and the next
 * lookup would pick it again, for the next viewer to wait on and lose.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forgetCachedPlayback } from "@/lib/server-cache";
import type { MediaType } from "../types";
import { getFreshCachedStream, invalidateCachedStream } from "./cached-stream";
import { parseDebridPlaybackSourceId } from "./debrid-source-id";

/** How long a refused release is kept from being offered as that title again. Neither fault mends itself: this only bounds the list. */
const REFUSED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const REFUSED_REMEMBERED = 500;
const refused = new Map<string, number>();
/** The links of refused releases: a player may still hold an answer that offers one. */
const refusedLinks = new Map<string, number>();

/** The title a player asked for, as the catalogue numbers it. */
export interface PlayedTitle {
  mediaType: MediaType;
  tmdbId: number;
  season?: number;
  episode?: number;
}

export interface OfferedAs {
  imdbId: string;
  season: number;
  episode: number;
}

function offerKey(offered: OfferedAs, release: string): string {
  return `${offered.imdbId}:${offered.season}:${offered.episode}:${release.split("\n")[0]?.trim().toLowerCase()}`;
}

/**
 * Kept beside the database, so a restart does not send the next viewer back
 * to every file already found out. Not kept under test.
 */
const STORE_FILE = join(existsSync("/app/db") ? "/app/db" : join(process.cwd(), "db"), "refused-releases.json");
const KEPT_ON_DISK = process.env.NODE_ENV !== "test";
let restored = false;

export interface RefusedSnapshot {
  releases: [string, number][];
  links: [string, number][];
}

/** What is refused as of `now`, in a form that can be written down. */
export function refusedSnapshot(now = Date.now()): RefusedSnapshot {
  const current = (store: Map<string, number>) => [...store].filter(([, until]) => until > now);
  return { releases: current(refused), links: current(refusedLinks) };
}

/** Takes back what a snapshot holds and has not run out. Anything malformed in it is passed over. */
export function restoreRefused(snapshot: unknown, now = Date.now()): void {
  const stored = (snapshot ?? {}) as Partial<Record<keyof RefusedSnapshot, unknown>>;
  for (const [store, entries] of [[refused, stored.releases], [refusedLinks, stored.links]] as const) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const [key, until] = Array.isArray(entry) ? entry : [];
      if (typeof key === "string" && typeof until === "number" && until > now) store.set(key, until);
    }
  }
}

function restoreOnce(): void {
  if (restored) return;
  restored = true;
  if (!KEPT_ON_DISK) return;
  try {
    restoreRefused(JSON.parse(readFileSync(STORE_FILE, "utf8")));
  } catch {
    // No file yet, or an unreadable one: nothing is refused.
  }
}

function remember(store: Map<string, number>, key: string): void {
  restoreOnce();
  store.delete(key);
  store.set(key, Date.now() + REFUSED_TTL_MS);
  while (store.size > REFUSED_REMEMBERED) store.delete(store.keys().next().value as string);
  if (!KEPT_ON_DISK) return;
  try {
    writeFileSync(STORE_FILE, JSON.stringify(refusedSnapshot()));
  } catch {
    // Kept in memory all the same.
  }
}

function remembers(store: Map<string, number>, key: string): boolean {
  restoreOnce();
  const until = store.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  store.delete(key);
  return false;
}

export function refuseRelease(offered: OfferedAs, release: string): void {
  remember(refused, offerKey(offered, release));
}

export function isRefusedRelease(offered: OfferedAs, release: string): boolean {
  return remembers(refused, offerKey(offered, release));
}

export function refuseLink(url: string): void {
  remember(refusedLinks, url);
}

export function isRefusedLink(url: string): boolean {
  return remembers(refusedLinks, url);
}

/**
 * Refuses the release behind a debrid source a player was given: forgets its
 * link, and the answers that offer it. Does nothing for a source that is not
 * a cached debrid link.
 */
export async function refuseSource(sourceId: string, title: PlayedTitle): Promise<void> {
  const key = parseDebridPlaybackSourceId(sourceId);
  if (!key) return;
  const cached = await getFreshCachedStream(key);
  if (cached) {
    refuseRelease({ imdbId: key.imdbId, season: key.season ?? 0, episode: key.episode ?? 0 }, cached.title);
    refuseLink(cached.url);
  }
  await invalidateCachedStream(key);
  forgetCachedPlayback(title.mediaType, title.tmdbId, title.season, title.episode);
}

/**
 * Opening a remuxed title before Play is pressed.
 *
 * A remux has to read the file's index and then wait out the debrid CDN's
 * slow first seconds before a frame exists: six or seven seconds if it all
 * starts at Play. On a title's page, or as the episode before ends, the
 * source Play would start is already known, so its session is opened then
 * and Play finds the first seconds made.
 */

import type { PlaybackSource } from "@/lib/playback/types";
import type { PlaybackQualityPreference } from "@/lib/profile-preferences";
import { sourceDelivery } from "@/lib/playback/source-quality";
import { getPreferredProvider, getPreferredQualityHeight } from "@/lib/player-preferences";
import { createRanker, remuxOpenQuery, startAudio, type AudioChoice, type TitleContext } from "./playable";

/** The server lets go of a prewarm nobody plays after 75 s; the same one is not asked for again sooner than this. */
const REPEAT_AFTER_MS = 45_000;
const REMEMBERED = 32;

const asked = new Map<string, number>();

export interface PrewarmArgs {
  sources: readonly PlaybackSource[];
  remuxAvailable: boolean;
  title: TitleContext;
  /** The profile's audio choice, as the player would be given it. */
  audio: AudioChoice;
  quality?: PlaybackQualityPreference;
  startAt: number;
}

function savesData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return Boolean(connection?.saveData);
}

/** The source the player would start for these arguments, when it is one that has to be remuxed. */
export function prewarmTarget(args: PrewarmArgs): PlaybackSource | null {
  const quality = args.quality ?? getPreferredQualityHeight();
  const best = createRanker(quality, args.remuxAvailable, getPreferredProvider()).pick(args.sources);
  return best && sourceDelivery(best) === "remux" ? best : null;
}

/** Asks the server to make the start of this title ready. Safe to call often: repeats are dropped. */
export function prewarmStart(args: PrewarmArgs): void {
  if (typeof window === "undefined" || !args.remuxAvailable || savesData()) return;
  const target = prewarmTarget(args);
  if (!target) return;
  const query = remuxOpenQuery(target, args.title, startAudio(args.title, args.audio), args.startAt);
  query.set("prewarm", "1");
  const key = query.toString();
  const now = Date.now();
  if (now - (asked.get(key) ?? 0) < REPEAT_AFTER_MS) return;
  asked.delete(key);
  asked.set(key, now);
  while (asked.size > REMEMBERED) asked.delete(asked.keys().next().value as string);
  void fetch(`/api/vod/open?${query}`, { cache: "no-store" }).catch(() => undefined);
}

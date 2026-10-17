/**
 * The laps of a debrid search, as the resolver logs them (`debrid_resolve_timing`):
 * observed as the live histogram, and kept a few minutes for the answer that
 * follows the search, which writes them into its discovery summary.
 */
import { ExpiringMap } from "./expiring-map";
import { debridResolveSeconds } from "./web-metrics";
import { titleKey, type TitleRef } from "./title-key";

/** Long enough for the answer that follows a search, short enough to forget a title's old search. */
const TIMINGS_KEPT_MS = 5 * 60 * 1000;
const TIMINGS_TITLES_MAX = 2000;

/** The laps a summary carries (see docs/TELEMETRY.md, `discovery_summary`'s timings). */
export interface DebridTimings {
  realDebridMs?: number;
  allDebridMs?: number;
  first1080Ms?: number;
  first2160Ms?: number;
}

export interface DebridSearchRecord {
  timings: DebridTimings;
  indexFailed: boolean;
}

/** The laps the resolver took, in milliseconds from the start of its search; only the known ones are set. */
export type DebridLaps = Readonly<Record<string, number | undefined>>;

const byTitle = new ExpiringMap<DebridSearchRecord>(TIMINGS_KEPT_MS, TIMINGS_TITLES_MAX);

function knownMs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function observe(service: "realdebrid" | "alldebrid" | "torbox", stage: "first1080" | "first2160" | "total", ms: number | undefined): void {
  const known = knownMs(ms);
  if (known !== undefined) debridResolveSeconds.observe({ service, stage }, known / 1000);
}

/**
 * Called where the resolver logs its timing. A Real-Debrid roster that was cut
 * short still gives its time, as the time it was given up. Never throws.
 */
export function recordDebridResolveTiming(title: TitleRef, laps: DebridLaps, indexFailed: boolean, now = Date.now()): void {
  try {
    const realDebridMs = knownMs(laps.realDebridMs) ?? knownMs(laps.realDebridPartialMs);
    observe("realdebrid", "first1080", laps.first1080Ms);
    observe("realdebrid", "first2160", laps.first2160Ms);
    observe("realdebrid", "total", realDebridMs);
    observe("alldebrid", "total", laps.allDebridMs);
    observe("torbox", "total", laps.torboxMs);
    const timings: DebridTimings = {};
    const kept: Array<[keyof DebridTimings, number | undefined]> = [
      ["realDebridMs", realDebridMs],
      ["allDebridMs", knownMs(laps.allDebridMs)],
      ["first1080Ms", knownMs(laps.first1080Ms)],
      ["first2160Ms", knownMs(laps.first2160Ms)],
    ];
    for (const [key, value] of kept) if (value !== undefined) timings[key] = Math.round(value);
    byTitle.set(titleKey(title), { timings, indexFailed }, now);
  } catch {
    // Telemetry never fails a search.
  }
}

/** The laps the last search of this title left, while they are fresh enough to be its answer's. */
export function debridTimingsOf(title: TitleRef, now = Date.now()): DebridSearchRecord | undefined {
  return byTitle.get(titleKey(title), now);
}

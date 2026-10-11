import type { MediaType } from "./types";

/**
 * Runtime comparisons are deliberately conservative. TMDB runtimes can vary
 * by cut and TV episodes can be much shorter than a series average, so this
 * rejects only gross mismatches: a trailer or an episode returned for a
 * feature, a film returned for an episode, several films in one file.
 */
const MIN_EXPECTED_DURATION_S = 10 * 60;
/** The shortest cuts in circulation run a little over half the catalogue's (a US cut of a European film); an hour-long episode under a film does not. */
const MOVIE_MIN_RUNTIME_RATIO = 0.5;
const EPISODE_MIN_RUNTIME_RATIO = 0.2;
const MOVIE_MIN_SHORTFALL_S = 15 * 60;
const EPISODE_MIN_SHORTFALL_S = 5 * 60;
/** The longest cuts run about a third over (an extended edition). Past this it is another film. */
const MOVIE_MAX_RUNTIME_RATIO = 1.6;
const MOVIE_MIN_EXCESS_S = 45 * 60;
/** A two-part episode shown as one is twice the length. A film filed under an episode is several times it. */
const EPISODE_MAX_RUNTIME_RATIO = 3;
const EPISODE_MIN_EXCESS_S = 30 * 60;

export interface MediaDurationAssessment {
  plausible: boolean;
  observedDurationS: number;
  expectedDurationS: number;
  minimumPlausibleDurationS: number;
  maximumPlausibleDurationS: number;
}

/**
 * Decide whether a measured stream can plausibly be the requested title.
 * Unknown/non-finite durations remain available; only conclusive mismatches
 * fail closed.
 */
export function assessMediaDuration(
  observedDurationS: number,
  expectedDurationS: number,
  mediaType: MediaType
): MediaDurationAssessment {
  const observed = Number.isFinite(observedDurationS)
    ? Math.max(0, observedDurationS)
    : 0;
  const expected = Number.isFinite(expectedDurationS)
    ? Math.max(0, expectedDurationS)
    : 0;
  const film = mediaType === "movie";
  const minimumPlausibleDurationS = expected * (film ? MOVIE_MIN_RUNTIME_RATIO : EPISODE_MIN_RUNTIME_RATIO);
  const maximumPlausibleDurationS = expected * (film ? MOVIE_MAX_RUNTIME_RATIO : EPISODE_MAX_RUNTIME_RATIO);
  const known = observed > 0 && expected >= MIN_EXPECTED_DURATION_S;
  const tooShort =
    expected - observed >= (film ? MOVIE_MIN_SHORTFALL_S : EPISODE_MIN_SHORTFALL_S) &&
    observed < minimumPlausibleDurationS;
  const tooLong =
    observed - expected >= (film ? MOVIE_MIN_EXCESS_S : EPISODE_MIN_EXCESS_S) &&
    observed > maximumPlausibleDurationS;
  return {
    plausible: !known || !(tooShort || tooLong),
    observedDurationS: observed,
    expectedDurationS: expected,
    minimumPlausibleDurationS,
    maximumPlausibleDurationS,
  };
}

/** Sum the advertised duration of an HLS media playlist. */
export function hlsMediaDurationSeconds(manifestText: string): number {
  let total = 0;
  let segments = 0;
  for (const rawLine of manifestText.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("#EXTINF:")) continue;
    const rawDuration = line.slice("#EXTINF:".length).split(",", 1)[0];
    const duration = Number(rawDuration);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    total += duration;
    segments += 1;
  }
  return segments > 0 ? total : 0;
}

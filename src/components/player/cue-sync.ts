import type { TimedCue } from "./vtt";

/** Label of the browser text track that mirrors our captions for the platform's own player. */
export const MIRROR_LABEL = "Absolute Cinema subtitles";

/** Stream cues are read again while the playhead is this close to the newest cue. */
const READ_AHEAD_S = 10;
/** Two reads of the stream cues are never closer together than this. */
const READ_AHEAD_GUARD_MS = 3_000;

/** The remuxer keeps a caption once per start time and text, so two cues with both are one caption. */
export function captionKey(cue: Pick<TimedCue, "start" | "text">): string {
  return `${cue.start.toFixed(3)}|${cue.text}`;
}

/** The captions in `wanted` that `existing` does not hold yet, each caption once, in the order given. */
export function cuesToAdd(existing: readonly TimedCue[], wanted: readonly TimedCue[]): TimedCue[] {
  const seen = new Set(existing.map(captionKey));
  const out: TimedCue[] = [];
  for (const cue of wanted) {
    const key = captionKey(cue);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cue);
  }
  return out;
}

/**
 * How the mirror track is shown. The platform's own player (iPhone fullscreen,
 * picture-in-picture) draws only native tracks, so the mirror shows there. In
 * a window our overlay draws the captions, so the mirror stays hidden, or the
 * same caption would be drawn twice.
 */
export function mirrorMode(state: { selected: boolean; nativeFullscreen: boolean; pip: boolean }): TextTrackMode {
  if (!state.selected) return "disabled";
  return state.nativeFullscreen || state.pip ? "showing" : "hidden";
}

/**
 * After a jump, or a new remux session, the run that now covers the playhead
 * has only just started: its cues are read again at these delays (ms), then
 * the usual cadence takes over.
 */
export function refreshDelaysAfterJump(): number[] {
  return [1_500, 4_000, 8_000];
}

/** Where the cues read so far end (the latest end, not the last one listed), or null when there are none. */
export function latestCueEnd(cues: readonly TimedCue[]): number | null {
  let latest: number | null = null;
  for (const cue of cues) {
    if (latest === null || cue.end > latest) latest = cue.end;
  }
  return latest;
}

/**
 * Whether to read the stream cues now. The playhead near the newest cue means
 * the remux run is producing right there, so the next cues are due. Nothing
 * is due once the newest cue reaches the end of the film, and reads are kept
 * a few seconds apart however the playhead moves.
 */
export function needsReadAhead(state: {
  time: number;
  lastCueEnd: number | null;
  duration: number;
  now: number;
  lastReadAt: number;
}): boolean {
  const { time, lastCueEnd, duration, now, lastReadAt } = state;
  if (lastCueEnd === null || now - lastReadAt < READ_AHEAD_GUARD_MS) return false;
  if (duration > 0 && lastCueEnd >= duration - READ_AHEAD_S) return false;
  return Math.abs(time - lastCueEnd) <= READ_AHEAD_S;
}

export function isMirrorTrack(track: TextTrack): boolean {
  return track.label === MIRROR_LABEL;
}

/** The mirror track of this element. Tracks cannot be removed, so each element gets one and keeps it. */
export function findMirrorTrack(video: HTMLVideoElement): TextTrack | undefined {
  for (let i = 0; i < video.textTracks.length; i++) {
    const track = video.textTracks[i]!;
    if (isMirrorTrack(track)) return track;
  }
  return undefined;
}

export function ensureMirrorTrack(video: HTMLVideoElement, language: string): TextTrack {
  return findMirrorTrack(video) ?? video.addTextTrack("subtitles", MIRROR_LABEL, language);
}

/** The cues on a track as caption text, tags stripped the way the overlay strips them. */
export function readTrackCues(track: TextTrack): TimedCue[] {
  const out: TimedCue[] = [];
  const cues = track.cues;
  for (let i = 0; cues && i < cues.length; i++) {
    const cue = cues[i] as VTTCue;
    const text = cue.text.replace(/<[^>]+>/g, "");
    if (text) out.push({ start: cue.startTime, end: cue.endTime, text });
  }
  return out;
}

export function clearTrackCues(track: TextTrack): void {
  const cues = track.cues;
  if (!cues) return;
  const held: TextTrackCue[] = [];
  for (let i = 0; i < cues.length; i++) held.push(cues[i]!);
  for (const cue of held) track.removeCue(cue);
}

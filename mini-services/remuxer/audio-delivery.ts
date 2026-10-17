/**
 * The audio a remuxed session carries, decided once per session from the
 * track the viewer hears and what their browser and audio output can take.
 *
 * A surround track is kept surround wherever the viewer can hear it: copied
 * when their browser decodes its Dolby codec, re-encoded to E-AC-3 for a
 * browser that decodes E-AC-3, and to 5.1 AAC for an output with six channels.
 * Everyone else gets the stereo AAC every session used to carry.
 */

import type { AudioCaps } from "../../src/lib/playback/decode-capability";

/**
 * "copy"   the track goes through untouched (its Dolby codec is decodable here)
 * "eac3"   re-encoded to E-AC-3 at 5.1 for a browser that decodes E-AC-3
 * "aac51"  re-encoded to AAC at 5.1 for an output that takes six channels
 * "aac20"  re-encoded to stereo AAC, for everyone else
 */
export type AudioDelivery = "copy" | "eac3" | "aac51" | "aac20";

/** The two facts about a track that decide its delivery. */
export interface AudioTrackFacts {
  /** Matroska codec id: `A_EAC3`, `A_AC3`, `A_DTS`, `A_TRUEHD` … */
  codecId: string;
  channels: number | null;
}

/** Six channels is 5.1: the smallest layout that is surround at all. */
const SURROUND_CHANNELS = 6;

/**
 * The delivery of a session's audio. A track the browser decodes as it is
 * is copied; a surround track is re-encoded surround for any viewer whose
 * decoder or output can carry it; anything else (including no track, and a
 * viewer who sent no capabilities) is stereo AAC.
 */
export function audioDelivery(track: AudioTrackFacts | null, caps: AudioCaps): AudioDelivery {
  if (track) {
    if (track.codecId === "A_EAC3" && caps.ec3) return "copy";
    if (track.codecId === "A_AC3" && caps.ac3) return "copy";
    const surround = (track.channels ?? 0) >= SURROUND_CHANNELS;
    if (surround && caps.ec3) return "eac3";
    if (surround && caps.channels >= SURROUND_CHANNELS) return "aac51";
  }
  return "aac20";
}

const AUDIO_ARGS: Record<AudioDelivery, readonly string[]> = {
  copy: ["-c:a", "copy"],
  eac3: ["-c:a", "eac3", "-b:a", "640k", "-ac", "6"],
  aac51: ["-c:a", "aac", "-b:a", "384k", "-ac", "6"],
  aac20: ["-c:a", "aac", "-b:a", "192k", "-ac", "2"],
};

/** The ffmpeg output options for one audio delivery, placed after the audio `-map`. */
export function audioArgs(delivery: AudioDelivery): string[] {
  return [...AUDIO_ARGS[delivery]];
}

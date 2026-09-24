"use client";

import { create } from "zustand";
import type { Phase } from "@/lib/playback/orchestrator";
import type { EngineAudioTrack, QualityLevel } from "./engine";

export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const VOLUME_KEY = "absolute-cinema:player-volume";
const FIT_KEY = "absolute-cinema:player-fit";

/** How the picture fills the screen: letterboxed, cropped to fill, or stretched. */
export type VideoFit = "contain" | "cover" | "fill";
export const VIDEO_FITS: { value: VideoFit; label: string; detail: string }[] = [
  { value: "contain", label: "Fit", detail: "Whole picture, black bars if needed" },
  { value: "cover", label: "Fill", detail: "Fills the screen, trims the edges" },
  { value: "fill", label: "Stretch", detail: "Fills the screen, distorts shape" },
];

function readFit(): VideoFit {
  try {
    const value = window.localStorage.getItem(FIT_KEY);
    return value === "cover" || value === "fill" ? value : "contain";
  } catch {
    return "contain";
  }
}

function readVolume(): number {
  try {
    const n = Number(window.localStorage.getItem(VOLUME_KEY) ?? "1");
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
  } catch {
    return 1;
  }
}

export interface SubtitleOption {
  id: string;
  label: string;
  language: string;
  /**
   * "embedded" = a text track the browser found in the stream; "stream" = a
   * subtitle track inside a remuxed MKV; "external" = downloaded VTT.
   */
  origin: "external" | "embedded" | "stream";
  /** Signs-and-songs / forced-only tracks: never picked automatically. */
  partial?: boolean;
}

/** Text subtitle tracks carried by the active remux session. */
export interface StreamSubtitleTrack {
  index: number;
  language: string | null;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
}

/** Audio tracks of the active remux session (only one is streamed at a time). */
export interface RemuxAudioTrack {
  index: number;
  language: string | null;
  name: string | null;
  channels: number | null;
}

export interface PlayerNotice {
  id: number;
  text: string;
  tone: "info" | "warning";
}

export interface PlayerState {
  phase: Phase;
  failureMessage: string | null;
  playing: boolean;
  buffering: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  rate: number;
  fullscreen: boolean;
  pip: boolean;
  controlsVisible: boolean;
  activeSourceId: string | null;
  decodedHeight: number;
  /** SDR, PQ or HLG for the active stream. */
  dynamicRange: string;
  levels: QualityLevel[];
  currentLevel: number;
  autoLevel: boolean;
  audioTracks: EngineAudioTrack[];
  activeAudio: number;
  subtitles: SubtitleOption[];
  activeSubtitle: string | null;
  /** Subtitle tracks of the active remux session, served from `base`. */
  streamSubtitles: { base: string; tracks: StreamSubtitleTrack[] } | null;
  remuxAudio: { tracks: RemuxAudioTrack[]; active: number | null } | null;
  cueText: string;
  videoFit: VideoFit;
  /** User's chosen maximum/target height; "auto" lets the player decide. */
  qualityChoice: "auto" | number;
  notice: PlayerNotice | null;
  /** Start-up note, e.g. that a server did not respond and the next is being tried. */
  startNote: string | null;
  /** The watch page's up-next card is showing (the player hides its own "Next Episode" button). */
  upNextVisible: boolean;
  set(partial: Partial<PlayerState>): void;
  showNotice(text: string, tone?: PlayerNotice["tone"]): void;
  reset(): void;
}

const initial = {
  phase: "resolving" as Phase,
  failureMessage: null,
  playing: false,
  buffering: true,
  currentTime: 0,
  duration: 0,
  bufferedEnd: 0,
  rate: 1,
  fullscreen: false,
  pip: false,
  controlsVisible: true,
  activeSourceId: null,
  decodedHeight: 0,
  dynamicRange: "SDR",
  levels: [],
  currentLevel: -1,
  autoLevel: true,
  audioTracks: [],
  activeAudio: -1,
  subtitles: [],
  activeSubtitle: null,
  streamSubtitles: null,
  remuxAudio: null,
  cueText: "",
  qualityChoice: "auto" as const,
  notice: null,
  startNote: null,
  upNextVisible: false,
};

let noticeSeq = 0;

export const usePlayerState = create<PlayerState>((set) => ({
  ...initial,
  volume: typeof window === "undefined" ? 1 : readVolume(),
  videoFit: typeof window === "undefined" ? "contain" : readFit(),
  muted: false,
  set: (partial) => {
    try {
      if (partial.volume !== undefined) window.localStorage.setItem(VOLUME_KEY, String(partial.volume));
      if (partial.videoFit !== undefined) window.localStorage.setItem(FIT_KEY, partial.videoFit);
    } catch {
      /* private mode: the change still applies to this session */
    }
    set(partial);
  },
  showNotice: (text, tone = "info") => set({ notice: { id: ++noticeSeq, text, tone } }),
  reset: () => set({ ...initial }),
}));

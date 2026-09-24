"use client";

import { create } from "zustand";
import type { Phase } from "@/lib/playback/orchestrator";
import type { EngineAudioTrack, QualityLevel } from "./engine";

export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const VOLUME_KEY = "absolute-cinema:player-volume";

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
  /** "external" = downloaded VTT; "embedded" = a track inside the stream. */
  origin: "external" | "embedded";
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
  cueText: string;
  /** User's chosen maximum/target height; "auto" lets the player decide. */
  qualityChoice: "auto" | number;
  notice: PlayerNotice | null;
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
  cueText: "",
  qualityChoice: "auto" as const,
  notice: null,
};

let noticeSeq = 0;

export const usePlayerState = create<PlayerState>((set) => ({
  ...initial,
  volume: typeof window === "undefined" ? 1 : readVolume(),
  muted: false,
  set: (partial) => {
    if (partial.volume !== undefined) {
      try {
        window.localStorage.setItem(VOLUME_KEY, String(partial.volume));
      } catch {
        /* private mode */
      }
    }
    set(partial);
  },
  showNotice: (text, tone = "info") => set({ notice: { id: ++noticeSeq, text, tone } }),
  reset: () => set({ ...initial }),
}));

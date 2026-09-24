"use client";

import { useEffect, useRef } from "react";
import type { PlaybackSource } from "@/lib/playback/types";
import { sourceDelivery } from "@/lib/playback/source-quality";
import { playableHere } from "./playable";
import { usePlayerState } from "./store";
import { hasFullEnglish } from "./subtitle-policy";

/** How long a playing source gets to show an English track (remux sessions list theirs a moment after opening). */
const SUBTITLE_WAIT_MS = 12_000;
/** Automatic moves per episode, so a title with no English anywhere cannot loop between servers. */
const MAX_SUBTITLE_SWITCHES = 2;

/**
 * When subtitles are required and the playing source has no English track
 * (neither in the stream nor downloadable), move to a server that is likely
 * to: a remuxed release, whose MKV carries its own subtitle tracks. Anime
 * releases almost always include full English subtitles.
 */
export function useSubtitleGuard(options: {
  required: boolean;
  sources: readonly PlaybackSource[];
  remuxAvailable: boolean;
  selectSource(id: string): void;
}) {
  const { required, sources, remuxAvailable, selectSource } = options;
  const phase = usePlayerState((s) => s.phase);
  const activeId = usePlayerState((s) => s.activeSourceId);
  const covered = usePlayerState((s) => hasFullEnglish(s.subtitles));
  const tried = useRef(new Set<string>());
  const switches = useRef(0);

  useEffect(() => {
    if (!required || phase !== "playing" || covered || !activeId) return;
    if (switches.current >= MAX_SUBTITLE_SWITCHES) return;
    const timer = setTimeout(() => {
      tried.current.add(activeId);
      const next = playableHere(sources, remuxAvailable).find(
        (s) => s.id !== activeId && !tried.current.has(s.id) && sourceDelivery(s) === "remux"
      );
      if (!next) return;
      switches.current += 1;
      usePlayerState.getState().showNotice("No English subtitles here — switching to a server that has them");
      selectSource(next.id);
    }, SUBTITLE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [required, phase, covered, activeId, sources, remuxAvailable, selectSource]);
}

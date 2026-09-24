"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { SubtitlePreference } from "@/lib/profile-preferences";
import { usePlayerState, type SubtitleOption } from "./store";

export interface ExternalSubtitle {
  id: string;
  label: string;
  language: string;
  vttUrl: string;
}

const EXTERNAL_LABEL_PREFIX = "ext:";

function isEnglish(language: string): boolean {
  return /^(en|eng|english)\b/i.test(language);
}

function trackId(track: TextTrack, index: number): string {
  return `emb:${track.id || index}:${track.language}:${track.label}`;
}

/**
 * Subtitles rendered by the player itself (not the browser's cue box), so
 * they look the same in every browser and in fullscreen. Offers subtitles
 * embedded in the stream plus downloaded ones, and follows the profile's
 * preference for the initial choice.
 */
export function useSubtitles(
  videoRef: RefObject<HTMLVideoElement | null>,
  external: readonly ExternalSubtitle[],
  preference: SubtitlePreference
) {
  const store = usePlayerState;
  const userChose = useRef(false);
  const externalEl = useRef<HTMLTrackElement | null>(null);

  const embeddedTracks = useCallback((video: HTMLVideoElement) => {
    const out: Array<{ track: TextTrack; option: SubtitleOption }> = [];
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i]!;
      if (track.label.startsWith(EXTERNAL_LABEL_PREFIX)) continue;
      if (track.kind !== "subtitles" && track.kind !== "captions") continue;
      out.push({
        track,
        option: { id: trackId(track, i), label: track.label || track.language || `Track ${i + 1}`, language: track.language, origin: "embedded" },
      });
    }
    return out;
  }, []);

  const select = useCallback(
    (id: string | null, byUser = true) => {
      const video = videoRef.current;
      if (!video) return;
      if (byUser) userChose.current = true;
      for (const { track } of embeddedTracks(video)) track.mode = "disabled";
      externalEl.current?.remove();
      externalEl.current = null;
      store.getState().set({ activeSubtitle: id, cueText: "" });
      if (!id) return;

      let track: TextTrack | null = null;
      const embedded = embeddedTracks(video).find((e) => e.option.id === id);
      if (embedded) {
        track = embedded.track;
      } else {
        const ext = external.find((x) => x.id === id);
        if (!ext) return;
        const el = document.createElement("track");
        el.kind = "subtitles";
        el.label = `${EXTERNAL_LABEL_PREFIX}${ext.label}`;
        el.srclang = ext.language.slice(0, 2) || "en";
        el.src = ext.vttUrl;
        video.appendChild(el);
        externalEl.current = el;
        track = el.track;
      }
      track.mode = "hidden";
      track.oncuechange = () => {
        const cues = track!.activeCues;
        const lines: string[] = [];
        for (let i = 0; cues && i < cues.length; i++) {
          const cue = cues[i] as VTTCue;
          if (cue.text) lines.push(cue.text.replace(/<[^>]+>/g, ""));
        }
        store.getState().set({ cueText: lines.join("\n") });
      };
    },
    [videoRef, external, embeddedTracks, store]
  );

  const refreshOptions = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const options: SubtitleOption[] = [
      ...embeddedTracks(video).map((e) => e.option),
      ...external.map((x) => ({ id: x.id, label: x.label, language: x.language, origin: "external" as const })),
    ];
    store.getState().set({ subtitles: options });
    if (!userChose.current && store.getState().activeSubtitle === null && preference !== "off") {
      const pick = options.find((o) => isEnglish(o.language) && o.origin === "embedded") ?? options.find((o) => isEnglish(o.language));
      if (pick) select(pick.id, false);
    }
  }, [videoRef, external, preference, embeddedTracks, store, select]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    refreshOptions();
    const onChange = () => refreshOptions();
    video.textTracks.addEventListener("addtrack", onChange);
    video.textTracks.addEventListener("removetrack", onChange);
    return () => {
      video.textTracks.removeEventListener("addtrack", onChange);
      video.textTracks.removeEventListener("removetrack", onChange);
    };
  }, [videoRef, refreshOptions]);

  useEffect(() => () => externalEl.current?.remove(), []);

  return { selectSubtitle: select };
}

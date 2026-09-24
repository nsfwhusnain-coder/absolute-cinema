"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { languageName } from "@/lib/language-name";
import type { SubtitlePreference } from "@/lib/profile-preferences";
import { usePlayerState, type StreamSubtitleTrack, type SubtitleOption } from "./store";

export interface ExternalSubtitle {
  id: string;
  label: string;
  language: string;
  vttUrl: string;
}

interface StreamCue {
  start: number;
  end: number;
  text: string;
}

const EXTERNAL_LABEL_PREFIX = "ext:";
const STREAM_PREFIX = "stream:";
/** Remux runs produce cues as they go; re-read the track this often while it is shown. */
const STREAM_CUE_REFRESH_MS = 15_000;
const PARTIAL_TRACK = /sign|song|forced/i;

function isEnglish(language: string): boolean {
  return /^(en|eng|english)\b/i.test(language);
}

function trackId(track: TextTrack, index: number): string {
  return `emb:${track.id || index}:${track.language}:${track.label}`;
}

function streamOption(track: StreamSubtitleTrack): SubtitleOption {
  const language = track.language ?? "und";
  const name = track.name?.trim();
  const base = languageName(language);
  return {
    id: `${STREAM_PREFIX}${track.index}`,
    label: name && name.toLowerCase() !== base.toLowerCase() ? `${base} · ${name}` : base,
    language,
    origin: "stream",
    partial: track.isForced || PARTIAL_TRACK.test(name ?? ""),
  };
}

/** Full English subtitles first: from inside the file, then the stream, then downloaded. */
function defaultPick(options: SubtitleOption[]): SubtitleOption | undefined {
  const english = options.filter((o) => isEnglish(o.language) && !o.partial);
  return (
    english.find((o) => o.origin === "embedded") ??
    english.find((o) => o.origin === "stream") ??
    english.find((o) => o.origin === "external")
  );
}

function activeText(cues: readonly StreamCue[], time: number): string {
  const lines: string[] = [];
  for (const cue of cues) {
    if (cue.start > time) break;
    if (cue.end > time) lines.push(cue.text);
  }
  return lines.join("\n");
}

/**
 * Subtitles rendered by the player itself (not the browser's cue box), so
 * they look the same in every browser and in fullscreen. Offers text tracks
 * found in the stream, subtitle tracks inside a remuxed MKV, and downloaded
 * ones, and follows the profile's preference for the initial choice.
 */
export function useSubtitles(
  videoRef: RefObject<HTMLVideoElement | null>,
  external: readonly ExternalSubtitle[],
  preference: SubtitlePreference
) {
  const store = usePlayerState;
  const streamSubtitles = usePlayerState((s) => s.streamSubtitles);
  const userChose = useRef(false);
  const externalEl = useRef<HTMLTrackElement | null>(null);
  const streamCues = useRef<StreamCue[]>([]);
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamAbort = useRef<AbortController | null>(null);

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

  const stopStream = useCallback(() => {
    if (streamTimer.current) clearInterval(streamTimer.current);
    streamTimer.current = null;
    streamAbort.current?.abort();
    streamAbort.current = null;
    streamCues.current = [];
  }, []);

  const startStream = useCallback(
    (index: number) => {
      const source = store.getState().streamSubtitles;
      if (!source) return;
      const load = async () => {
        streamAbort.current?.abort();
        const abort = new AbortController();
        streamAbort.current = abort;
        try {
          const res = await fetch(`${source.base}sub-${index}.json`, { signal: abort.signal, cache: "no-store" });
          if (!res.ok) return;
          const body = (await res.json()) as { cues?: StreamCue[] };
          streamCues.current = body.cues ?? [];
        } catch {
          /* aborted or offline: keep the cues we have */
        }
      };
      void load();
      streamTimer.current = setInterval(() => void load(), STREAM_CUE_REFRESH_MS);
    },
    [store]
  );

  const select = useCallback(
    (id: string | null, byUser = true) => {
      const video = videoRef.current;
      if (!video) return;
      if (byUser) userChose.current = true;
      for (const { track } of embeddedTracks(video)) track.mode = "disabled";
      externalEl.current?.remove();
      externalEl.current = null;
      stopStream();
      store.getState().set({ activeSubtitle: id, cueText: "" });
      if (!id) return;

      if (id.startsWith(STREAM_PREFIX)) {
        startStream(Number(id.slice(STREAM_PREFIX.length)));
        return;
      }
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
    [videoRef, external, embeddedTracks, store, startStream, stopStream]
  );

  const refreshOptions = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const options: SubtitleOption[] = [
      ...embeddedTracks(video).map((e) => e.option),
      ...(store.getState().streamSubtitles?.tracks ?? []).map(streamOption),
      ...external.map((x) => ({ id: x.id, label: x.label, language: x.language, origin: "external" as const })),
    ];
    store.getState().set({ subtitles: options });
    const active = store.getState().activeSubtitle;
    if (active && !options.some((o) => o.id === active)) select(null, false);
    if (!userChose.current && store.getState().activeSubtitle === null && preference !== "off") {
      const pick = defaultPick(options);
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

  // A new remux session (another server, or another audio track) has its own
  // subtitle URLs: rebuild the list and keep showing the same track number.
  useEffect(() => {
    const active = store.getState().activeSubtitle;
    refreshOptions();
    if (active?.startsWith(STREAM_PREFIX) && store.getState().activeSubtitle === active) select(active, false);
  }, [streamSubtitles, refreshOptions, select, store]);

  // Stream cues are drawn from the playback clock.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      if (!store.getState().activeSubtitle?.startsWith(STREAM_PREFIX)) return;
      const text = activeText(streamCues.current, video.currentTime);
      if (text !== store.getState().cueText) store.getState().set({ cueText: text });
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("seeked", onTime);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("seeked", onTime);
    };
  }, [videoRef, store]);

  useEffect(
    () => () => {
      externalEl.current?.remove();
      stopStream();
    },
    [stopStream]
  );

  return { selectSubtitle: select };
}

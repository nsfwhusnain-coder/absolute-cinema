"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { languageName } from "@/lib/language-name";
import type { SubtitlePreference } from "@/lib/profile-preferences";
import { usePlayerState, type StreamSubtitleTrack, type SubtitleOption } from "./store";
import { getTitleLanguage, rememberTitleLanguage } from "@/lib/title-language";
import { betterThanExternal } from "./subtitle-policy";
import { parseVtt } from "./vtt";

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

function sameLanguage(a: string, b: string): boolean {
  const base = (code: string) => code.toLowerCase().split("-")[0]!.replace(/^eng$/, "en").replace(/^jpn$/, "ja");
  return base(a) === base(b);
}

/** Full subtitles in `language` first: from inside the file, then the stream, then downloaded. */
function defaultPick(options: SubtitleOption[], language?: string): SubtitleOption | undefined {
  const matching = options.filter((o) => (language ? sameLanguage(o.language, language) : isEnglish(o.language)) && !o.partial);
  return (
    matching.find((o) => o.origin === "embedded") ??
    matching.find((o) => o.origin === "stream") ??
    matching.find((o) => o.origin === "external")
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
  preference: SubtitlePreference,
  /** Remembers the viewer's choice for this show (see title-language). */
  rememberKey: string,
  /** The audio is in a language the viewer does not read: show English even if the profile says off. */
  required = false
) {
  const store = usePlayerState;
  const streamSubtitles = usePlayerState((s) => s.streamSubtitles);
  const userChose = useRef(false);
  // Downloaded and remuxed subtitles are drawn from the playback clock, not
  // through a <track>: hls.js clears the cues of every text track on the
  // element whenever it loads a manifest, and toggles subtitle tracks off.
  const clockDriven = useRef(false);
  const streamCues = useRef<StreamCue[]>([]);
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamAbort = useRef<AbortController | null>(null);

  const embeddedTracks = useCallback((video: HTMLVideoElement) => {
    const out: Array<{ track: TextTrack; option: SubtitleOption }> = [];
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i]!;
      if (track.kind !== "subtitles" && track.kind !== "captions") continue;
      out.push({
        track,
        option: { id: trackId(track, i), label: track.label || track.language || `Track ${i + 1}`, language: track.language, origin: "embedded" },
      });
    }
    return out;
  }, []);

  const stopStream = useCallback(() => {
    clockDriven.current = false;
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

  const loadExternal = useCallback((vttUrl: string) => {
    const abort = new AbortController();
    streamAbort.current = abort;
    void fetch(vttUrl, { signal: abort.signal })
      .then((res) => (res.ok ? res.text() : ""))
      .then((text) => {
        if (!abort.signal.aborted) streamCues.current = parseVtt(text);
      })
      .catch(() => {
        /* aborted or offline: nothing to draw */
      });
  }, []);

  const select = useCallback(
    (id: string | null, byUser = true) => {
      const video = videoRef.current;
      if (!video) return;
      if (byUser) {
        userChose.current = true;
        const language = id ? store.getState().subtitles.find((o) => o.id === id)?.language ?? null : null;
        rememberTitleLanguage(rememberKey, { subtitle: language });
      }
      for (const { track } of embeddedTracks(video)) track.mode = "disabled";
      stopStream();
      store.getState().set({ activeSubtitle: id, cueText: "" });
      if (!id) return;

      if (id.startsWith(STREAM_PREFIX)) {
        clockDriven.current = true;
        startStream(Number(id.slice(STREAM_PREFIX.length)));
        return;
      }
      const ext = external.find((x) => x.id === id);
      if (ext) {
        clockDriven.current = true;
        loadExternal(ext.vttUrl);
        return;
      }
      const embedded = embeddedTracks(video).find((e) => e.option.id === id);
      if (!embedded) return;
      const track = embedded.track;
      track.mode = "hidden";
      track.oncuechange = () => {
        const cues = track.activeCues;
        const lines: string[] = [];
        for (let i = 0; cues && i < cues.length; i++) {
          const cue = cues[i] as VTTCue;
          if (cue.text) lines.push(cue.text.replace(/<[^>]+>/g, ""));
        }
        store.getState().set({ cueText: lines.join("\n") });
      };
    },
    [videoRef, external, embeddedTracks, store, startStream, stopStream, loadExternal, rememberKey]
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
    if (userChose.current) return;
    const current = store.getState().activeSubtitle;
    if (current === null) {
      // This show's remembered choice wins over the profile default, unless
      // the viewer could not follow the audio without subtitles.
      const remembered = getTitleLanguage(rememberKey)?.subtitle;
      if (!required && remembered === null) return;
      if (!required && remembered === undefined && preference === "off") return;
      const pick = defaultPick(options, remembered ?? undefined) ?? (required ? defaultPick(options) : undefined);
      if (pick) select(pick.id, false);
      return;
    }
    const upgrade = betterThanExternal(options, current);
    if (upgrade) select(upgrade.id, false);
  }, [videoRef, external, preference, embeddedTracks, store, select, rememberKey, required]);

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
      if (!clockDriven.current) return;
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

  useEffect(() => () => stopStream(), [stopStream]);

  return { selectSubtitle: select };
}

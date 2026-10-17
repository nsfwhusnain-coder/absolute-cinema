"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { languageName } from "@/lib/language-name";
import type { SubtitlePreference } from "@/lib/profile-preferences";
import { usePlayerState, type StreamSubtitleTrack, type SubtitleOption } from "./store";
import { getTitleLanguage, rememberTitleLanguage } from "@/lib/title-language";
import { betterThanExternal } from "./subtitle-policy";
import { parseVtt } from "./vtt";
import { baseLanguage } from "@/lib/language-name";
import {
  clearTrackCues,
  cuesToAdd,
  ensureMirrorTrack,
  findMirrorTrack,
  isMirrorTrack,
  latestCueEnd,
  mirrorMode,
  needsReadAhead,
  readTrackCues,
  refreshDelaysAfterJump,
} from "./cue-sync";

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

/** "spa" and "es", "ger" and "de", "pt-BR" and "por" are the same language. */
function sameLanguage(a: string, b: string): boolean {
  return baseLanguage(a) === baseLanguage(b);
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
  // The remux subtitle track being read (null when none), when it was last
  // read, where its newest cue ends, and the reads due soon after a jump.
  const streamIndex = useRef<number | null>(null);
  const streamLastRead = useRef(0);
  const streamFrontier = useRef<number | null>(null);
  const streamQuick = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  // The embedded track whose cues the mirror copies, and how many it held last time.
  const embeddedSource = useRef<TextTrack | null>(null);
  const embeddedCount = useRef(-1);
  // The platform's own player (iPhone fullscreen, picture-in-picture) is on screen.
  const nativeFullscreen = useRef(false);
  const pictureInPicture = useRef(false);

  const embeddedTracks = useCallback((video: HTMLVideoElement) => {
    const out: Array<{ track: TextTrack; option: SubtitleOption }> = [];
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i]!;
      if (isMirrorTrack(track)) continue;
      if (track.kind !== "subtitles" && track.kind !== "captions") continue;
      out.push({
        track,
        option: { id: trackId(track, i), label: track.label || track.language || `Track ${i + 1}`, language: track.language, origin: "embedded" },
      });
    }
    return out;
  }, []);

  /**
   * Keeps the mirror track in step with the selected subtitle. `reset` empties
   * it first, for a new selection. Otherwise only the cues it lacks are added,
   * because stream cues grow on every read.
   */
  const syncMirror = useCallback(
    (reset = false) => {
      const video = videoRef.current;
      if (!video) return;
      const { activeSubtitle, subtitles } = store.getState();
      if (!activeSubtitle) {
        const off = findMirrorTrack(video);
        if (off && off.mode !== "disabled") {
          clearTrackCues(off);
          off.mode = "disabled";
        }
        return;
      }
      const language = subtitles.find((o) => o.id === activeSubtitle)?.language ?? "und";
      const mirror = ensureMirrorTrack(video, language);
      // A track that was switched off may still hold cues from before: it starts empty.
      const wasOff = mirror.mode === "disabled";
      mirror.mode = mirrorMode({ selected: true, nativeFullscreen: nativeFullscreen.current, pip: pictureInPicture.current });
      if (wasOff || reset) clearTrackCues(mirror);
      // Embedded tracks keep their cues on the track; stream and downloaded cues are held here.
      const embedded = embeddedTracks(video).find((e) => e.option.id === activeSubtitle);
      const wanted = embedded ? readTrackCues(embedded.track) : streamCues.current;
      for (const cue of cuesToAdd(readTrackCues(mirror), wanted)) {
        mirror.addCue(new VTTCue(cue.start, cue.end, cue.text));
      }
    },
    [videoRef, store, embeddedTracks]
  );

  const clearQuickReads = useCallback(() => {
    for (const timer of streamQuick.current) clearTimeout(timer);
    streamQuick.current = [];
  }, []);

  const stopStream = useCallback(() => {
    clockDriven.current = false;
    if (streamTimer.current) clearInterval(streamTimer.current);
    streamTimer.current = null;
    clearQuickReads();
    streamIndex.current = null;
    streamFrontier.current = null;
    streamAbort.current?.abort();
    streamAbort.current = null;
    streamCues.current = [];
  }, [clearQuickReads]);

  /** Reads the cues the remux run has produced so far, and keeps the ones we have if the read fails. */
  const readStream = useCallback(() => {
    const index = streamIndex.current;
    const source = store.getState().streamSubtitles;
    if (index === null || !source) return;
    streamAbort.current?.abort();
    const abort = new AbortController();
    streamAbort.current = abort;
    streamLastRead.current = Date.now();
    const load = async () => {
      try {
        const res = await fetch(`${source.base}sub-${index}.json`, { signal: abort.signal, cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { cues?: StreamCue[] };
        if (abort.signal.aborted) return;
        streamCues.current = body.cues ?? [];
        streamFrontier.current = latestCueEnd(streamCues.current);
        syncMirror();
      } catch {
        /* aborted or offline: keep the cues we have */
      }
    };
    void load();
  }, [store, syncMirror]);

  // A jump starts a new remux run at the new position, so its first cues come
  // in over the next seconds: read again soon, before the usual cadence.
  const scheduleQuickReads = useCallback(() => {
    clearQuickReads();
    streamQuick.current = refreshDelaysAfterJump().map((ms) => setTimeout(readStream, ms));
  }, [clearQuickReads, readStream]);

  const startStream = useCallback(
    (index: number) => {
      if (!store.getState().streamSubtitles) return;
      streamIndex.current = index;
      readStream();
      streamTimer.current = setInterval(readStream, STREAM_CUE_REFRESH_MS);
      scheduleQuickReads();
    },
    [store, readStream, scheduleQuickReads]
  );

  const loadExternal = useCallback(
    (vttUrl: string) => {
      const abort = new AbortController();
      streamAbort.current = abort;
      void fetch(vttUrl, { signal: abort.signal })
        .then((res) => (res.ok ? res.text() : ""))
        .then((text) => {
          if (!abort.signal.aborted) {
            streamCues.current = parseVtt(text);
            syncMirror();
          }
        })
        .catch(() => {
          /* aborted or offline: nothing to draw */
        });
    },
    [syncMirror]
  );

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
      embeddedSource.current = null;
      store.getState().set({ activeSubtitle: id, cueText: "" });
      syncMirror(true);
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
      embeddedSource.current = track;
      embeddedCount.current = -1;
      syncMirror();
    },
    [videoRef, external, embeddedTracks, store, startStream, stopStream, loadExternal, rememberKey, syncMirror]
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
    // The player draws every caption itself. A track the stream marks as
    // default can be switched to "showing" by the engine after our choice,
    // and the browser then drew it too, a second copy under the controls.
    // The mirror track is the one exception while the platform's own player is on screen.
    const keepNativeHidden = () => {
      const onNativeScreen = nativeFullscreen.current || pictureInPicture.current;
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i]!;
        if (track.mode !== "showing") continue;
        if (onNativeScreen && isMirrorTrack(track)) continue;
        track.mode = "hidden";
      }
    };
    video.textTracks.addEventListener("addtrack", onChange);
    video.textTracks.addEventListener("removetrack", onChange);
    video.textTracks.addEventListener("change", keepNativeHidden);
    return () => {
      video.textTracks.removeEventListener("addtrack", onChange);
      video.textTracks.removeEventListener("removetrack", onChange);
      video.textTracks.removeEventListener("change", keepNativeHidden);
    };
  }, [videoRef, refreshOptions]);

  // iPhone fullscreen and picture-in-picture draw only native tracks, so the
  // mirror is shown while either is on screen.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    nativeFullscreen.current = (video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen === true;
    pictureInPicture.current = document.pictureInPictureElement === video;
    syncMirror();
    const beginFullscreen = () => {
      nativeFullscreen.current = true;
      syncMirror();
    };
    const endFullscreen = () => {
      nativeFullscreen.current = false;
      syncMirror();
    };
    const enterPip = () => {
      pictureInPicture.current = true;
      syncMirror();
    };
    const leavePip = () => {
      pictureInPicture.current = false;
      syncMirror();
    };
    video.addEventListener("webkitbeginfullscreen", beginFullscreen);
    video.addEventListener("webkitendfullscreen", endFullscreen);
    video.addEventListener("enterpictureinpicture", enterPip);
    video.addEventListener("leavepictureinpicture", leavePip);
    return () => {
      video.removeEventListener("webkitbeginfullscreen", beginFullscreen);
      video.removeEventListener("webkitendfullscreen", endFullscreen);
      video.removeEventListener("enterpictureinpicture", enterPip);
      video.removeEventListener("leavepictureinpicture", leavePip);
    };
  }, [videoRef, syncMirror]);

  // A new remux session (another server, or another audio track) has its own
  // subtitle URLs: rebuild the list and keep showing the same track number.
  useEffect(() => {
    const active = store.getState().activeSubtitle;
    refreshOptions();
    if (active?.startsWith(STREAM_PREFIX) && store.getState().activeSubtitle === active) select(active, false);
  }, [streamSubtitles, refreshOptions, select, store]);

  // Stream cues are drawn from the playback clock. An embedded track gains
  // cues as the browser parses them, so its new cues are mirrored here too.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const embedded = embeddedSource.current;
      if (embedded) {
        const count = embedded.cues?.length ?? 0;
        if (count !== embeddedCount.current) {
          embeddedCount.current = count;
          syncMirror();
        }
      }
      if (!clockDriven.current) return;
      const text = activeText(streamCues.current, video.currentTime);
      if (text !== store.getState().cueText) store.getState().set({ cueText: text });
      if (
        streamIndex.current !== null &&
        needsReadAhead({
          time: video.currentTime,
          lastCueEnd: streamFrontier.current,
          duration: video.duration,
          now: Date.now(),
          lastReadAt: streamLastRead.current,
        })
      ) {
        readStream();
      }
    };
    const onSeeked = () => {
      if (streamIndex.current !== null) scheduleQuickReads();
      onTime();
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("seeked", onSeeked);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [videoRef, store, syncMirror, readStream, scheduleQuickReads]);

  useEffect(() => () => stopStream(), [stopStream]);

  return { selectSubtitle: select };
}

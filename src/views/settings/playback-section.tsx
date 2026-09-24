"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { clearPlaybackPreresolveCache } from "@/lib/playback-preresolve";
import { setAutoplayNext, syncProfilePlaybackPreferences } from "@/lib/player-preferences";
import { PREFERENCES_QUERY_KEY, fetchPreferences, patchPreferences } from "@/lib/preferences-client";
import { Row, Section, Segmented, Toggle } from "./primitives";


const QUALITY_OPTIONS = [
  { value: "auto", label: "Best" },
  { value: "2160", label: "4K" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "Saver" },
];

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "hi", label: "Hindi" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
];


export function PlaybackSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: PREFERENCES_QUERY_KEY, queryFn: fetchPreferences });

  const save = useMutation({
    mutationFn: patchPreferences,
    onSuccess: (prefs) => {
      syncProfilePlaybackPreferences(prefs);
      setAutoplayNext(prefs.autoplayNext);
      qc.setQueryData(PREFERENCES_QUERY_KEY, prefs);
      clearPlaybackPreresolveCache();
      qc.removeQueries({ queryKey: ["playback"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const disabled = !data || save.isPending;
  const quality = String(data?.playbackQuality ?? "auto");

  return (
    <Section
      title="Playback"
      icon={<PlayCircle className="h-4 w-4 text-white/70" />}
      description="Saved to your profile, so every device you sign in on follows them."
    >
      <Row label="Quality" help="Best plays the highest quality this device can decode, 4K when there is one. Saver uses the least data.">
        <Segmented
          label="Quality"
          value={quality}
          options={QUALITY_OPTIONS}
          disabled={disabled}
          onChange={(v) => save.mutate({ playbackQuality: v === "auto" ? "auto" : Number(v) })}
        />
      </Row>
      <Row label="Audio" help="Commentary and audio-description tracks are skipped when a normal track exists.">
        <Segmented
          label="Audio"
          value={data?.audioPreference ?? "original"}
          options={[
            { value: "original", label: "Original" },
            { value: "english", label: "English" },
            { value: "preferred", label: "My language" },
          ]}
          disabled={disabled}
          onChange={(v) => save.mutate({ audioPreference: v })}
        />
      </Row>
      <Row label="My language" help="Used for “My language”, and as the fallback when the original isn't available.">
        <select
          aria-label="Preferred language"
          value={data?.audioLanguage ?? "en"}
          disabled={disabled}
          onChange={(e) => save.mutate({ audioLanguage: e.target.value })}
          className="h-10 rounded-full border border-white/12 bg-white/[0.06] px-4 text-sm text-white focus:border-white/45 focus:outline-none [&>option]:bg-neutral-900"
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Subtitles">
        <Segmented
          label="Subtitles"
          value={data?.subtitlePreference ?? "english"}
          options={[
            { value: "off", label: "Off" },
            { value: "english", label: "English" },
          ]}
          disabled={disabled}
          onChange={(v) => save.mutate({ subtitlePreference: v })}
        />
      </Row>
      <Row label="Subtitle size">
        <Segmented
          label="Subtitle size"
          value={data?.captionSize ?? "medium"}
          options={[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]}
          disabled={disabled}
          onChange={(v) => save.mutate({ captionSize: v })}
        />
      </Row>
      <Row label="Subtitle background" help="A dark box is easiest to read; a shadow keeps more of the picture.">
        <Segmented
          label="Subtitle background"
          value={data?.captionBackground ?? "box"}
          options={[
            { value: "box", label: "Box" },
            { value: "shadow", label: "Shadow" },
          ]}
          disabled={disabled}
          onChange={(v) => save.mutate({ captionBackground: v })}
        />
      </Row>
      <Row inline label="Autoplay next episode" help="Starts the next episode after a short countdown.">
        <Toggle
          label="Autoplay next episode"
          checked={data?.autoplayNext ?? true}
          disabled={disabled}
          onChange={(next) => save.mutate({ autoplayNext: next })}
        />
      </Row>
    </Section>
  );
}

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { clearPlaybackPreresolveCache } from "@/lib/playback-preresolve";
import { getAutoplayNext, setAutoplayNext, syncProfilePlaybackPreferences } from "@/lib/player-preferences";
import type { ProfilePlaybackPreferences } from "@/lib/profile-preferences";
import { Row, Section, Segmented, Toggle } from "./primitives";

export const PREFERENCES_QUERY_KEY = ["profile-playback-preferences"] as const;

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

export async function fetchPreferences(): Promise<ProfilePlaybackPreferences & { hideAdult?: boolean }> {
  const res = await fetch("/api/preferences", { cache: "no-store" });
  const json = (await res.json()) as ProfilePlaybackPreferences & { hideAdult?: boolean; error?: string };
  if (!res.ok) throw new Error(json.error || "Could not load preferences");
  return json;
}

export function PlaybackSection() {
  const qc = useQueryClient();
  const [autoplay, setAutoplay] = useState(getAutoplayNext);
  const { data } = useQuery({ queryKey: PREFERENCES_QUERY_KEY, queryFn: fetchPreferences });

  const save = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = (await res.json()) as ProfilePlaybackPreferences & { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not save");
      return json;
    },
    onSuccess: (prefs) => {
      syncProfilePlaybackPreferences(prefs);
      qc.setQueryData(PREFERENCES_QUERY_KEY, (old: object | undefined) => ({ ...old, ...prefs }));
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
      <Row label="Autoplay next episode" help="Starts the next episode after a short countdown. This device only." inline>
        <Toggle
          label="Autoplay next episode"
          checked={autoplay}
          onChange={(next) => {
            setAutoplay(next);
            setAutoplayNext(next);
          }}
        />
      </Row>
    </Section>
  );
}

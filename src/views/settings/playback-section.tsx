"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { clearPlaybackPreresolveCache } from "@/lib/playback-preresolve";
import { setAutoplayNext, syncProfilePlaybackPreferences } from "@/lib/player-preferences";
import { PREFERENCES_QUERY_KEY, fetchPreferences, patchPreferences, useProfilePreferences } from "@/lib/preferences-client";
import type { CaptionBackground, CaptionColor, CaptionFont, CaptionSize } from "@/lib/profile-extras";
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
  // Look-and-feel choices apply at once (optimistic); they don't touch stream discovery.
  const { save: saveExtra } = useProfilePreferences();

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
      <SubtitlePreview
        size={data?.captionSize ?? "medium"}
        background={data?.captionBackground ?? "box"}
        color={data?.captionColor ?? "white"}
        font={data?.captionFont ?? "sans"}
      />
      <Row label="Subtitle size">
        <Segmented
          label="Subtitle size"
          value={data?.captionSize ?? "medium"}
          options={[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
            { value: "xlarge", label: "Extra large" },
          ]}
          disabled={!data}
          onChange={(v: CaptionSize) => void saveExtra({ captionSize: v })}
        />
      </Row>
      <Row label="Subtitle colour">
        <Segmented
          label="Subtitle colour"
          value={data?.captionColor ?? "white"}
          options={[
            { value: "white", label: "White" },
            { value: "yellow", label: "Yellow" },
            { value: "cyan", label: "Cyan" },
            { value: "green", label: "Green" },
          ]}
          disabled={!data}
          onChange={(v: CaptionColor) => void saveExtra({ captionColor: v })}
        />
      </Row>
      <Row label="Subtitle font">
        <Segmented
          label="Subtitle font"
          value={data?.captionFont ?? "sans"}
          options={[
            { value: "sans", label: "Default" },
            { value: "serif", label: "Serif" },
            { value: "rounded", label: "Rounded" },
            { value: "mono", label: "Typewriter" },
          ]}
          disabled={!data}
          onChange={(v: CaptionFont) => void saveExtra({ captionFont: v })}
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
          disabled={!data}
          onChange={(v: CaptionBackground) => void saveExtra({ captionBackground: v })}
        />
      </Row>
      <Row label="Skip step" help="How far the arrow keys, the skip buttons and a double tap jump.">
        <Segmented
          label="Skip step"
          value={String(data?.seekStep ?? 10)}
          options={[
            { value: "5", label: "5 s" },
            { value: "10", label: "10 s" },
            { value: "15", label: "15 s" },
            { value: "30", label: "30 s" },
          ]}
          disabled={!data}
          onChange={(v) => void saveExtra({ seekStep: Number(v) as 5 | 10 | 15 | 30 })}
        />
      </Row>
      <Row inline label="Skip intros automatically" help="Openings and recaps with known times (most anime) are skipped as they start, with a button to go back.">
        <Toggle
          label="Skip intros automatically"
          checked={data?.autoSkipIntro ?? false}
          disabled={!data}
          onChange={(on) => void saveExtra({ autoSkipIntro: on })}
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
      <Row label="Ask “Still watching?”" help="After this many episodes start on their own with nobody touching anything.">
        <Segmented
          label="Ask Still watching"
          value={String(data?.stillWatchingAfter ?? 3)}
          options={[
            { value: "2", label: "2 episodes" },
            { value: "3", label: "3 episodes" },
            { value: "5", label: "5 episodes" },
            { value: "0", label: "Never" },
          ]}
          disabled={!data}
          onChange={(v) => void saveExtra({ stillWatchingAfter: Number(v) as 0 | 2 | 3 | 5 })}
        />
      </Row>
    </Section>
  );
}

/** A still with a line of dialogue in the chosen subtitle style, so a change is seen before playing anything. */
function SubtitlePreview({
  size,
  background,
  color,
  font,
}: {
  size: CaptionSize;
  background: CaptionBackground;
  color: CaptionColor;
  font: CaptionFont;
}) {
  return (
    <div className="py-3">
      <div
        aria-hidden
        className="relative flex aspect-[21/9] w-full items-end justify-center overflow-hidden rounded-2xl bg-[radial-gradient(ellipse_at_30%_20%,#f6c26b_0%,#c2553a_35%,#2a1b3d_75%,#0d0a14_100%)] px-6 pb-[7%]"
      >
        <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-black/30 to-transparent" />
        <p
          data-size={size}
          data-background={background}
          data-color={color}
          data-font={font}
          className="player-caption max-w-[85%] whitespace-pre-line rounded-lg bg-black/70 px-3 py-1 text-center font-medium leading-snug text-white"
        >
          {"I'll be right here.\nWhenever you're ready."}
        </p>
      </div>
    </div>
  );
}

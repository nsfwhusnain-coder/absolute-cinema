"use client";

import { useState } from "react";
import { FeedbackForm, deviceContext } from "@/components/feedback-form";
import type { FeedbackContext } from "@/lib/feedback";
import { deliveryOfSource } from "@/lib/playback/player-feedback";
import type { PlaybackSource } from "@/lib/playback/types";
import { qualityLabel, type TitleContext } from "./playable";
import { usePlayerState } from "./store";
import { PlayerMenu } from "./ui";

/**
 * "Report a problem" in the player's settings menu: the feedback form, with
 * what the player knows about this film filled in, so the admin can find the
 * moment the viewer means. It renders inside the player, so it stays on screen
 * in full screen.
 */
export function ReportMenu({
  title,
  displayTitle,
  episodeLabel,
  source,
  decodedHeight,
  engineKind,
  onBack,
  onSent,
}: {
  title: TitleContext;
  displayTitle: string;
  episodeLabel?: string;
  /** The file playing now, if any: its delivery and provider go with the report. */
  source: PlaybackSource | null;
  /** The picture's height as it is shown; 0 when not known yet. */
  decodedHeight: number;
  engineKind: () => string | null;
  onBack: () => void;
  onSent: () => void;
}) {
  // Read once, as the menu opens: by the time the viewer has typed, the film has moved on.
  const [context] = useState<FeedbackContext>(() => ({
    title: episodeLabel ? `${displayTitle} · ${episodeLabel}` : displayTitle,
    mediaType: title.mediaType,
    tmdbId: title.tmdbId,
    season: title.season,
    episode: title.episode,
    positionS: usePlayerState.getState().currentTime,
    quality: decodedHeight ? qualityLabel(decodedHeight) : undefined,
    delivery: source ? deliveryOfSource(source) : undefined,
    provider: source?.provider,
    engine: engineKind() ?? undefined,
    ...deviceContext(),
  }));

  return (
    <PlayerMenu title="Report a problem" onBack={onBack}>
      <div className="space-y-4 px-3 pb-3 pt-1">
        <p className="text-xs leading-relaxed text-white/60">The film and where you were in it go with the note.</p>
        <FeedbackForm initialCategory="playback" context={context} onSent={onSent} />
      </div>
    </PlayerMenu>
  );
}

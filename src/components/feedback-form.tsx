"use client";

import { useId, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { FeedbackContext } from "@/lib/feedback";
import { FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_LABELS, FEEDBACK_MESSAGE_MAX, type FeedbackCategory } from "@/lib/feedback-options";
import { detectDeviceClass } from "@/lib/playback/device-profile";
import { cn } from "@/lib/utils";
import { PrimaryButton } from "@/views/settings/primitives";

/** The device and browser this page runs on, as a report records them. Safe to call while the page is rendered on the server. */
export function deviceContext(): Pick<FeedbackContext, "device" | "userAgent"> {
  return { device: detectDeviceClass(), userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent };
}

/**
 * A note for the admin: what kind of thing it is, and what happened or what
 * would be better. `context` is what the page knew (the film, the moment, the
 * device) and goes with the note; the server keeps only the fields it knows.
 * Used in the player's "Report a problem" menu and in Settings.
 */
export function FeedbackForm({
  initialCategory,
  context,
  onSent,
}: {
  initialCategory: FeedbackCategory;
  context?: FeedbackContext;
  /** Called once the note is kept, for a player menu to close itself. */
  onSent?: () => void;
}) {
  const groupId = useId();
  const messageId = useId();
  const [category, setCategory] = useState<FeedbackCategory>(initialCategory);
  const [message, setMessage] = useState("");
  const ready = message.trim().length > 0;

  const send = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, message: message.trim(), context }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not send your feedback");
    },
    onSuccess: () => {
      toast.success("Thanks — your feedback was sent.");
      setMessage("");
      setCategory(initialCategory);
      onSent?.();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not send your feedback"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !send.isPending) send.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p id={groupId} className="text-sm font-medium text-white">
        What is it about?
      </p>
      <div role="group" aria-labelledby={groupId} className="flex flex-wrap gap-1.5">
        {FEEDBACK_CATEGORIES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={category === option}
            onClick={() => setCategory(option)}
            className={cn(
              "h-9 rounded-full px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
              category === option ? "bg-white text-black" : "bg-white/[0.06] text-white/75 hover:bg-white/10 hover:text-white"
            )}
          >
            {FEEDBACK_CATEGORY_LABELS[option]}
          </button>
        ))}
      </div>
      <label htmlFor={messageId} className="sr-only">
        Your feedback
      </label>
      <textarea
        id={messageId}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        maxLength={FEEDBACK_MESSAGE_MAX}
        rows={4}
        placeholder="What happened, or what would make it better?"
        className="w-full resize-y rounded-2xl border border-white/12 bg-white/[0.06] px-4 py-3 text-sm leading-relaxed text-white placeholder:text-white/35 focus:border-white/45 focus:outline-none focus:ring-2 focus:ring-white/25"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs tabular-nums text-white/45">
          {message.length}/{FEEDBACK_MESSAGE_MAX}
        </span>
        <PrimaryButton type="submit" disabled={!ready} busy={send.isPending}>
          Send
        </PrimaryButton>
      </div>
    </form>
  );
}

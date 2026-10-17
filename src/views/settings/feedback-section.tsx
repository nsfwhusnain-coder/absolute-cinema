"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { FeedbackForm, deviceContext } from "@/components/feedback-form";
import type { FeedbackContext, FeedbackItem } from "@/lib/feedback";
import { FEEDBACK_CATEGORY_LABELS, type FeedbackCategory } from "@/lib/feedback-options";
import { ago, clock } from "@/lib/hub/format";
import { cn } from "@/lib/utils";
import { Section } from "./primitives";

const FEEDBACK_KEY = ["admin", "feedback"] as const;

/** Any signed-in profile can send feedback from here: the note goes to the server's admin. */
export function FeedbackSection() {
  return (
    <Section
      title="Send feedback"
      icon={<MessageSquare className="h-4 w-4 text-white/70" />}
      description="Tell the admin of this server what went wrong, or what would make it better. Only the admin reads it."
    >
      <FeedbackForm initialCategory="idea" context={{ path: "/settings", ...deviceContext() }} />
    </Section>
  );
}

const BADGE_TONE: Record<FeedbackCategory, string> = {
  playback: "bg-amber-500/15 text-amber-300",
  broken: "bg-red-500/15 text-red-300",
  idea: "bg-emerald-500/15 text-emerald-300",
  other: "bg-white/10 text-white/70",
};

/** A quiet line for the report's context, e.g. "Inception · 1080p · remux · realdebrid · hlsjs · at 12:34 · desktop", with only the parts it has. */
function contextLine(context: FeedbackContext | undefined): string {
  if (!context) return "";
  return [
    context.title ?? context.path,
    context.quality,
    context.delivery,
    context.provider,
    context.engine,
    context.positionS !== undefined ? `at ${clock(context.positionS)}` : undefined,
    context.device,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Everything testers have sent, newest first, for the admin to read and delete. */
export function FeedbackInbox() {
  const qc = useQueryClient();
  const { data } = useQuery<{ items: FeedbackItem[] }>({
    queryKey: FEEDBACK_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/feedback", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load feedback");
      return res.json();
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/feedback?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not delete that feedback");
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: FEEDBACK_KEY }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete that feedback"),
  });

  const items = data?.items ?? [];
  return (
    <Section
      title="Feedback from viewers"
      icon={<MessageSquare className="h-4 w-4 text-white/70" />}
      description="What testers sent from the player's menu and from Settings."
    >
      {data && items.length === 0 && (
        <p className="py-4 text-sm text-white/55">Nothing yet. Testers can send feedback from the player's menu or from Settings.</p>
      )}
      {items.length > 0 && (
        <ul className="space-y-2 py-4 first:pt-0 last:pb-0">
          {items.map((item) => {
            const line = contextLine(item.context);
            return (
              <li key={item.id} className="flex gap-3 rounded-2xl bg-white/[0.04] px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-white/55">
                    <span className="text-sm font-medium text-white">{item.name}</span>
                    <span className={cn("rounded-full px-2 py-0.5 font-semibold", BADGE_TONE[item.category])}>{FEEDBACK_CATEGORY_LABELS[item.category]}</span>
                    <span>{ago(item.at)}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-white/90 [overflow-wrap:anywhere]">{item.message}</p>
                  {line && (
                    <p className="mt-2 text-xs text-white/50 [overflow-wrap:anywhere]" title={item.context?.userAgent}>
                      {line}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => remove.mutate(item.id)}
                  disabled={remove.isPending}
                  aria-label={`Delete feedback from ${item.name}`}
                  className="self-start rounded-full p-2 text-white/45 transition hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import { signIn, useSession } from "next-auth/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Library, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { HIDE_ADULT_QUERY_KEY } from "@/hooks/use-hide-adult";
import { useNavigate } from "@/hooks/use-navigate";
import {
  clearWatchedHistory,
  loadWatchedHistory,
  removeFromWatched,
  type WatchedHistoryItem,
} from "@/lib/watched-history";
import { tmdbImageUrl } from "@/lib/tmdb";
import { cn } from "@/lib/utils";
import { PREFERENCES_QUERY_KEY, fetchPreferences, type ProfilePreferences } from "@/lib/preferences-client";
import { PrimaryButton, Row, Section, Toggle, inputClass } from "./primitives";
import { useOwnProfile } from "./profile-section";

export function LibrarySection() {
  return (
    <Section title="Library" icon={<Library className="h-4 w-4 text-white/70" />}>
      <ContentFilterRow />
      <WatchedRow />
    </Section>
  );
}

function ContentFilterRow() {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [pin, setPin] = useState("");
  const [checking, setChecking] = useState(false);
  const { data } = useQuery({ queryKey: PREFERENCES_QUERY_KEY, queryFn: fetchPreferences });
  const hideAdult = data ? data.hideAdult !== false : true;
  const { data: profile } = useOwnProfile();
  const locked = Boolean(profile?.pinRequired);

  const save = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideAdult: next }),
      });
      const json = (await res.json()) as { hideAdult?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error || "Could not save");
      return json.hideAdult !== false;
    },
    onSuccess: (next) => {
      qc.setQueryData(HIDE_ADULT_QUERY_KEY, next);
      qc.setQueryData(PREFERENCES_QUERY_KEY, (old: ProfilePreferences | undefined) => (old ? { ...old, hideAdult: next } : old));
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  // Turning the filter off is gated by this profile's PIN, checked by signing in again.
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    const name = session?.user?.name;
    if (!name || pin.length < 4) return;
    setChecking(true);
    const res = await signIn("credentials", { name, pin, redirect: false });
    setChecking(false);
    if (res?.error) {
      toast.error("That PIN isn't right");
      return;
    }
    save.mutate(false);
    setConfirming(false);
    setPin("");
  };

  return (
    <Row
      inline={!confirming}
      label="Hide adult titles"
      help={`Hides titles TMDB flags as adult. R and TV-MA titles still show.${locked ? " Turning it off asks for your PIN." : ""}`}
    >
      {confirming ? (
        <form onSubmit={confirm} className="flex w-full gap-2 sm:w-72">
          <input
            className={cn(inputClass, "sm:w-auto sm:flex-1")}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={pin}
            placeholder="Your PIN"
            autoFocus
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 10))}
            aria-label="Your PIN"
          />
          <PrimaryButton tone="subtle" onClick={() => setConfirming(false)}>
            Cancel
          </PrimaryButton>
          <PrimaryButton type="submit" disabled={pin.length < 4} busy={checking}>
            OK
          </PrimaryButton>
        </form>
      ) : (
        <Toggle
          label="Hide adult titles"
          checked={hideAdult}
          disabled={!data || save.isPending}
          onChange={(next) => (next || !locked ? save.mutate(next) : setConfirming(true))}
        />
      )}
    </Row>
  );
}

function WatchedRow() {
  const navigate = useNavigate();
  const [items, setItems] = useState<WatchedHistoryItem[]>(loadWatchedHistory);
  const [open, setOpen] = useState(false);

  const remove = (item: WatchedHistoryItem) => {
    removeFromWatched(item.tmdbId, item.mediaType);
    setItems(loadWatchedHistory());
  };

  return (
    <div className="py-4 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium text-white">Already watched</div>
          <div className="mt-0.5 text-xs text-white/55">
            {items.length
              ? `${items.length} title${items.length === 1 ? "" : "s"} you marked with ✓ on My List. This device only.`
              : "Titles you mark with ✓ on My List appear here."}
          </div>
        </div>
        <div className="flex gap-2">
          {items.length > 0 && (
            <PrimaryButton tone="subtle" onClick={() => setOpen((v) => !v)}>
              <History className="h-4 w-4" />
              {open ? "Hide" : "Show"}
            </PrimaryButton>
          )}
          {items.length === 0 && (
            <PrimaryButton tone="subtle" onClick={() => navigate("/watchlist")}>
              Open My List
            </PrimaryButton>
          )}
        </div>
      </div>
      {open && items.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {items.map((item) => (
              <div key={`${item.mediaType}-${item.tmdbId}`} className="group relative">
                <button
                  type="button"
                  onClick={() => navigate(`/${item.mediaType}/${item.tmdbId}`)}
                  className="block aspect-[2/3] w-full overflow-hidden rounded-xl bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  aria-label={item.title}
                >
                  {item.poster ? (
                    <img src={tmdbImageUrl(item.poster, "w342") ?? undefined} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <span className="flex h-full items-center justify-center p-2 text-center text-xs text-white/60">{item.title}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => remove(item)}
                  className="glass-icon absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full text-white opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Remove ${item.title}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <PrimaryButton
              tone="danger"
              onClick={() => {
                clearWatchedHistory();
                setItems([]);
                setOpen(false);
              }}
            >
              Clear all
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

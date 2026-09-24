"use client";

import { MessageCard } from "@/components/message-card";
import { Bookmark, Clock, Search, AlertCircle, LayoutGrid, User, KeyRound } from "lucide-react";

export function EmptyWatchlist() {
  return (
    <div className="py-12">
      <MessageCard icon={<Bookmark className="h-6 w-6" />} title="Your list is empty" actions={[{ label: "Find something to watch", href: "/", primary: true }]}>
        Tap + on any title to save it here for later.
      </MessageCard>
    </div>
  );
}

export function EmptyContinue() {
  return (
    <div className="py-12">
      <MessageCard icon={<Clock className="h-6 w-6" />} title="Nothing in progress" actions={[{ label: "Browse titles", href: "/", primary: true }]}>
        Titles you start watching show up here so you can pick up where you left off.
      </MessageCard>
    </div>
  );
}

export function EmptySearch({ query }: { query: string }) {
  return (
    <div className="py-12">
      <MessageCard icon={<Search className="h-6 w-6" />} title={`No results for "${query}"`}>
        Check the spelling, or try the title in its original language.
      </MessageCard>
    </div>
  );
}

export function NoProvider() {
  return (
    <MessageCard icon={<KeyRound className="h-6 w-6" />} title="Playback is switched off" actions={[{ label: "Open settings", href: "/settings?tab=server", primary: true }]}>
      An admin can switch it back on in Settings → Server → System → Advanced → Playback source.
    </MessageCard>
  );
}

export function EmptyBrowse({ label }: { label: string }) {
  return (
    <div className="py-12">
      <MessageCard icon={<LayoutGrid className="h-6 w-6" />} title={`Nothing in ${label}`} actions={[{ label: "Go home", href: "/", primary: true }]}>
        There are no titles here right now.
      </MessageCard>
    </div>
  );
}

export function PersonError({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="py-12">
      <MessageCard
        icon={<User className="h-6 w-6" />}
        title="Couldn't load this person"
        actions={[...(onRetry ? [{ label: "Try again", onClick: onRetry, primary: true }] : []), { label: "Go home", href: "/" }]}
      >
        The movie database didn&apos;t answer. Try again in a moment.
      </MessageCard>
    </div>
  );
}

export function BrowseError({
  label,
  onRetry,
  compact = false,
  hint,
}: {
  label: string;
  onRetry?: () => void;
  compact?: boolean;
  hint?: string;
}) {
  if (compact) {
    return (
      <div className="glass flex items-center gap-3 rounded-2xl px-4 py-3 text-sm text-white">
        <AlertCircle className="h-5 w-5 shrink-0 text-amber-300" />
        <span className="flex-1">Couldn&apos;t load {label}.</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black">
            Retry
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="py-12">
      <MessageCard
        icon={<AlertCircle className="h-6 w-6 text-amber-300" />}
        title={`Couldn't load ${label}`}
        actions={onRetry ? [{ label: "Try again", onClick: onRetry, primary: true }] : []}
      >
        {hint ?? "The movie database didn't answer. It's usually brief — try again in a moment."}
      </MessageCard>
    </div>
  );
}

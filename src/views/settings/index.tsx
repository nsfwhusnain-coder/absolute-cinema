"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { transitionView } from "@/lib/motion";
import { Skeleton } from "@/components/ui/skeleton";
import { AppSection } from "./app-section";
import { AppearanceSection } from "./appearance-section";
import { ConnectionsSection } from "./connections-section";
import { LibrarySection } from "./library-section";
import { PlaybackSection } from "./playback-section";
import { Segmented } from "./primitives";
import { ProfileSection } from "./profile-section";
import { ProfilesSection } from "./profiles-section";
import { SystemSection } from "./system-section";

interface SettingsData {
  settings: Record<string, string>;
  status: { tmdb: boolean };
  isAdmin: boolean;
  providers: { id: string; name: string }[];
}

type Tab = "you" | "server";

function initialTab(): Tab {
  if (typeof window === "undefined") return "you";
  const requested = new URLSearchParams(window.location.search).get("tab");
  return requested === "server" || requested === "connections" ? "server" : "you";
}

function SettingsSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-44 w-full rounded-3xl" />
      <Skeleton className="h-72 w-full rounded-3xl" />
      <Skeleton className="h-40 w-full rounded-3xl" />
    </div>
  );
}

export function SettingsView() {
  const { status: sessionStatus } = useSession();
  const [tab, setTab] = useState<Tab>(initialTab);
  const { data } = useQuery<SettingsData>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Could not load settings");
      return res.json();
    },
    enabled: sessionStatus === "authenticated",
  });

  const isAdmin = Boolean(data?.isAdmin);
  const showServer = isAdmin && tab === "server";

  return (
    <div className="min-h-screen px-4 pb-16 pt-24 sm:px-6 lg:px-8">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionView}
        className="mx-auto max-w-3xl space-y-5"
      >
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-white">Settings</h1>
          {isAdmin && (
            <Segmented
              label="Settings group"
              value={tab}
              onChange={setTab}
              options={[
                { value: "you", label: "You" },
                { value: "server", label: "Server" },
              ]}
            />
          )}
        </header>

        {!data ? (
          <SettingsSkeleton />
        ) : showServer ? (
          <>
            <ConnectionsSection tmdbConfigured={data.status.tmdb} tmdbMasked={data.settings.tmdb_api_key ?? ""} />
            <ProfilesSection settings={data.settings} />
            <SystemSection settings={data.settings} providers={data.providers} />
          </>
        ) : (
          <>
            <ProfileSection />
            <PlaybackSection />
            <AppearanceSection />
            <LibrarySection />
            <AppSection />
          </>
        )}
      </motion.div>
    </div>
  );
}

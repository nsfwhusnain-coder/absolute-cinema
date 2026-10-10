"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUIStore } from "@/stores/ui-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import dynamic from "next/dynamic";

/**
 * A dialog that only ever appears after someone presses "?". Loading its markup,
 * its Radix dialog dependency and its shortcut table in the initial bundle taxes
 * every route including the sign-in form, which measured 865 KB of JavaScript to
 * render two text fields. ssr:false because it renders nothing until opened.
 */
const KeyboardShortcutsHelp = dynamic(
  () =>
    import("@/components/keyboard-shortcuts-help").then(
      (m) => m.KeyboardShortcutsHelp
    ),
  { ssr: false }
);
import { ErrorBoundary } from "@/components/error-boundary";
import { ProfileSync } from "@/components/profile-sync";

function GlobalShortcuts() {
  const setShortcutsHelpOpen = useUIStore((s) => s.setShortcutsHelpOpen);
  const router = useRouter();
  // The player has its own keys (its "?" opens its own list), so these stand down while it is open.
  const shortcuts = useMemo(
    () => ({
      "?": (e: KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".player-shell")) return;
        setShortcutsHelpOpen(true);
      },
      "/": (e: KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".player-shell")) return;
        e.preventDefault();
        const field = document.querySelector<HTMLInputElement>('input[type="search"]');
        if (field) field.focus();
        else router.push("/search");
      },
    }),
    [router, setShortcutsHelpOpen]
  );
  useKeyboardShortcuts(shortcuts);
  return <KeyboardShortcutsHelp />;
}

export function Providers({ children, session }: { children: React.ReactNode; session?: Session | null }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );

  return (
    <SessionProvider session={session}>
      <QueryClientProvider client={client}>
        {/* "user" — every motion component below respects prefers-reduced-motion
            automatically, no per-component useReducedMotion() checks needed. */}
        <MotionConfig reducedMotion="user">
          <ErrorBoundary>{children}</ErrorBoundary>
          <GlobalShortcuts />
          <ProfileSync />
        </MotionConfig>
      </QueryClientProvider>
    </SessionProvider>
  );
}

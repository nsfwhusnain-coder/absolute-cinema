"use client";

import { usePathname } from "next/navigation";
import {
  Home,
  Film,
  Tv,
  Bookmark,
  Search,
  Sparkles,
} from "lucide-react";
import { useNavigate } from "@/hooks/use-navigate";
import { cn } from "@/lib/utils";
import { isNavPathActive } from "@/lib/nav";

const DOCK_ITEMS = [
  { label: "Home", icon: Home, path: "/" },
  { label: "Movies", icon: Film, path: "/movies" },
  { label: "Shows", icon: Tv, path: "/shows" },
  { label: "Anime", icon: Sparkles, path: "/anime" },
  { label: "My List", icon: Bookmark, path: "/watchlist" },
  { label: "Search", icon: Search, path: "/search" },
] as const;

interface MobileDockProps {
  /** When false, Movies/Shows hub icons are hidden. */
  hubsEnabled?: boolean;
}

/**
 * Fixed bottom icon dock — mobile only.
 * Hidden on desktop (md+) and on immersive /watch/* (watch lives outside main layout;
 * pathname guard is defensive if this mounts elsewhere).
 */
export function MobileDock({ hubsEnabled = true }: MobileDockProps) {
  const navigate = useNavigate();
  const pathname = usePathname();

  if (pathname.startsWith("/watch") || pathname === "/login") return null;

  const items = hubsEnabled
    ? DOCK_ITEMS
    : DOCK_ITEMS.filter((item) => item.path !== "/movies" && item.path !== "/shows" && item.path !== "/anime");

  return (
    <nav
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 px-3 md:hidden"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      aria-label="Primary"
    >
      <div className="glass-clear pointer-events-auto flex h-16 items-center justify-around rounded-[1.75rem] px-1.5">
        {items.map((item) => {
          const active = isNavPathActive(pathname, item.path);
          return (
            <button
              key={item.path}
              type="button"
              onClick={() => navigate(item.path)}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[1.25rem] py-1.5 text-[10px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                active ? "bg-white/15 text-white" : "text-white/65 hover:text-white"
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" aria-hidden />
              <span className="max-w-full truncate px-0.5">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

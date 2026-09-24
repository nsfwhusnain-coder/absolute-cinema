"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LogOut, Search, Settings, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { PRIMARY_NAV, isNavPathActive } from "@/lib/nav";
import { NavLettermark } from "@/components/brand-mark";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { ProfileAvatar } from "@/views/login";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";


const SCROLL_SCRIM_THRESHOLD_PX = 24;

/** True once the page has scrolled past the hero edge; updates only on threshold crossings. */
function useScrolledPast(threshold: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      setPast(window.scrollY > threshold);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [threshold]);
  return past;
}

interface NavbarProps {
  bottomNavEnabled?: boolean;
  hubsEnabled?: boolean;
}

/**
 * Two floating islands: logo lockup (left) + clear glass nav pill (right).
 * No full-bleed bar.
 */
export function Navbar({ bottomNavEnabled = true, hubsEnabled = true }: NavbarProps) {
  const pathname = usePathname();
  // useSession() returns undefined outside a SessionProvider, which is the case
  // while Next prerenders /_not-found - destructuring it directly broke the
  // build there. Read defensively; no provider means no session.
  const sessionStatus = useSession()?.status;
  const scrolled = useScrolledPast(SCROLL_SCRIM_THRESHOLD_PX);

  if (pathname.startsWith("/watch") || pathname === "/login") return null;

  // Every destination in this bar is behind auth, so rendering it to a
  // signed-out visitor offers six links that all redirect straight back to
  // sign-in. On a television it is worse than useless: the D-pad has to walk
  // past all of them before reaching the PIN field. Unauthenticated and
  // still-loading both hide it, so it cannot flash in during session probe.
  if (sessionStatus !== "authenticated") return null;

  const navItems = PRIMARY_NAV.filter(
    (item) => hubsEnabled || (item.path !== "/movies" && item.path !== "/shows")
  );

  return (
    <header
      className="pointer-events-none fixed inset-x-0 top-0 z-50 w-full"
      style={{ background: "none", backdropFilter: "none", WebkitBackdropFilter: "none" }}
    >
      {/* Scrim keeps the logo and pill legible over rails once scrolled. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[#050508] via-[#050508]/75 to-transparent transition-opacity duration-300",
          scrolled ? "opacity-100" : "opacity-0",
        )}
      />
      <div className="relative z-10 mx-auto flex h-[72px] max-w-none items-center justify-between gap-4 pl-5 pr-5 sm:pl-6 sm:pr-7 lg:pr-8">
        {/* Island A — logo lockup */}
        <Link
          href="/"
          className={cn(
            "pointer-events-auto relative z-20 flex shrink-0 items-center rounded-lg",
            FOCUS_RING
          )}
          aria-label="Absolute Cinema home"
        >
          <NavLettermark />
        </Link>

        {/* Island B — clear glass pill */}
        <div className="glass pointer-events-auto relative flex h-12 shrink-0 items-center gap-0.5 rounded-full p-1">

          <nav
            className="relative z-[1] hidden items-center gap-0.5 md:flex"
            aria-label="Primary"
          >
            {navItems.map((item) => {
              const active = isNavPathActive(pathname, item.path);
              return (
                <Link
                  key={item.path}
                  href={item.path}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-10 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors duration-200",
                    FOCUS_RING,
                    active
                      ? "bg-white text-black shadow-sm"
                      : "text-white/85 hover:bg-white/10 hover:text-white"
                  )}
                >
                  {active && item.path === "/" ? (
                    <Home className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
                  ) : null}
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <span
            className="relative z-[1] mx-0.5 hidden h-4 w-px shrink-0 md:block"
            style={{ background: "rgba(255,255,255,0.2)" }}
            aria-hidden
          />

          <Link
            href="/search"
            className={cn(
              "relative z-[1] inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-200",
              FOCUS_RING,
              isNavPathActive(pathname, "/search")
                ? "bg-white text-black shadow-sm"
                : "text-white/85 hover:bg-white/10 hover:text-white",
              bottomNavEnabled && "max-md:hidden"
            )}
            aria-label="Search"
          >
            <Search className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          </Link>

          <ProfileMenu />
        </div>
      </div>
    </header>
  );
}

/** Avatar button with Switch profile, Settings and Sign out. */
function ProfileMenu() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const name = session?.user?.name ?? "";
  const item =
    "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm text-white hover:bg-[var(--mat-fill-hover)] focus-visible:bg-[var(--mat-fill-hover)] focus-visible:outline-none";
  return (
    <div ref={ref} className="relative z-[1]">
      <button
        type="button"
        aria-label="Profile menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn("ml-0.5 inline-flex h-10 w-10 items-center justify-center rounded-full", FOCUS_RING)}
      >
        <ProfileAvatar name={name || "?"} color={session?.user?.avatarColor ?? "#e50914"} size="sm" />
      </button>
      {open && (
        <div role="menu" className="glass-strong absolute right-0 top-12 w-56 rounded-3xl p-2">
          <div className="flex items-center gap-3 px-3 pb-2 pt-1">
            <ProfileAvatar name={name || "?"} color={session?.user?.avatarColor ?? "#e50914"} size="sm" />
            <span className="min-w-0 truncate text-sm font-semibold text-white">{name}</span>
          </div>
          <Link href="/login" role="menuitem" className={item} onClick={() => setOpen(false)}>
            <Users className="h-4 w-4" /> Switch profile
          </Link>
          <Link href="/settings" role="menuitem" className={item} onClick={() => setOpen(false)}>
            <Settings className="h-4 w-4" /> Settings
          </Link>
          <button type="button" role="menuitem" className={item} onClick={() => void signOut({ callbackUrl: "/login" })}>
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

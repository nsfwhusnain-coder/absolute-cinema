import { useId } from "react";
import { cn } from "@/lib/utils";

export type BrandMarkSize = "nav" | "header" | "hero" | "lg";

const SIZE_REM: Record<BrandMarkSize, number> = {
  nav: 2.25,
  lg: 4.5,
  header: 8.75,
  hero: 32,
};

/** The "A" whose counter is a play button — used alone or inside the tile. */
export function LogoGlyph({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <svg viewBox="104 88 304 336" className={className} aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff3b4a" />
          <stop offset="1" stopColor="#d10f25" />
        </linearGradient>
      </defs>
      <path d="M256 104 L392 408 H330 L256 232 L182 408 H120 Z" fill="currentColor" />
      <path d="M236 304 L236 372 L294 338 Z" fill={`url(#${gradient})`} />
    </svg>
  );
}

/** App icon: the glyph on a dark rounded tile. Sized in rem so it scales on TVs. */
export function BrandMark({ size = "nav", className }: { size?: BrandMarkSize; className?: string }) {
  const background = useId();
  return (
    <svg
      role="img"
      aria-label="Absolute Cinema"
      viewBox="0 0 512 512"
      className={cn("shrink-0", className)}
      style={{ width: `${SIZE_REM[size]}rem`, height: `${SIZE_REM[size]}rem` }}
    >
      <defs>
        <linearGradient id={background} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1c1c24" />
          <stop offset="1" stopColor="#08080b" />
        </linearGradient>
      </defs>
      <rect x="16" y="16" width="480" height="480" rx="112" fill={`url(#${background})`} />
      <rect x="16.5" y="16.5" width="479" height="479" rx="111.5" fill="none" stroke="#fff" strokeOpacity="0.12" />
      <g color="#f5f5f7">
        <svg x="104" y="88" width="304" height="336" viewBox="104 88 304 336">
          <LogoGlyphPaths />
        </svg>
      </g>
    </svg>
  );
}

function LogoGlyphPaths() {
  const gradient = useId();
  return (
    <>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff3b4a" />
          <stop offset="1" stopColor="#d10f25" />
        </linearGradient>
      </defs>
      <path d="M256 104 L392 408 H330 L256 232 L182 408 H120 Z" fill="currentColor" />
      <path d="M236 304 L236 372 L294 338 Z" fill={`url(#${gradient})`} />
    </>
  );
}

/** Mark + "Absolute Cinema" wordmark. The wordmark hides on narrow screens. */
export function BrandLockup({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark size="nav" />
      <span
        className={cn(
          "font-[family-name:var(--font-montserrat)] text-[1.05rem] font-extrabold tracking-tight text-white",
          compact ? "hidden" : "hidden sm:inline",
        )}
      >
        Absolute <span className="text-white/60">Cinema</span>
      </span>
    </span>
  );
}

/** Navbar logo. */
export function NavLettermark({ className }: { className?: string }) {
  return <BrandLockup className={className} />;
}

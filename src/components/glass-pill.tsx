"use client";

import { cn } from "@/lib/utils";
import type { ReactNode } from "react";


const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

interface GlassPillRootProps {
  children: ReactNode;
  className?: string;
}

/** Outer glass capsule container. */
export function GlassPill({ children, className }: GlassPillRootProps) {
  return (
    <div
      className={cn(
        "glass relative inline-flex h-12 shrink-0 items-center gap-0.5 rounded-full p-1",
        className
      )}
    >
      <div className="relative z-[1] flex items-center gap-0.5">{children}</div>
    </div>
  );
}

interface GlassPillSegmentProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  type?: "button" | "submit";
  "aria-label"?: string;
}

/** Inset segment — white when active, ghost when idle. */
export function GlassPillSegment({
  active,
  onClick,
  children,
  className,
  type = "button",
  "aria-label": ariaLabel,
}: GlassPillSegmentProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={cn(
        "inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-medium transition-colors duration-200",
        FOCUS,
        active
          ? "bg-white text-black shadow-sm"
          : "text-white/85 hover:bg-white/10 hover:text-white",
        className
      )}
    >
      {children}
    </button>
  );
}

export function GlassPillDivider({ className }: { className?: string }) {
  return (
    <span
      className={cn("mx-0.5 h-4 w-px shrink-0", className)}
      style={{ background: "rgba(255,255,255,0.2)" }}
      aria-hidden
    />
  );
}

interface GlassPillTabsProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}

/** Controlled tab strip in the glass pill look. */
export function GlassPillTabs<T extends string>({
  value,
  options,
  onChange,
  className,
}: GlassPillTabsProps<T>) {
  return (
    <GlassPill className={className}>
      {options.map((opt) => (
        <GlassPillSegment
          key={opt.value}
          active={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </GlassPillSegment>
      ))}
    </GlassPill>
  );
}

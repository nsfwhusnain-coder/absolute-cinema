"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** A group of related settings on one glass card. */
export function Section({
  title,
  description,
  icon,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="glass rounded-3xl p-5 sm:p-6">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight text-white">
            {icon}
            {title}
          </h2>
          {description && <p className="mt-1 text-sm leading-relaxed text-white/60">{description}</p>}
        </div>
        {action}
      </header>
      <div className="divide-y divide-white/[0.07]">{children}</div>
    </section>
  );
}

/** One setting: label and help text on the left, the control on the right (stacked on phones). */
export function Row({
  label,
  help,
  inline,
  children,
}: {
  label: string;
  help?: ReactNode;
  /** Keep a small control (a switch) beside the label on phones too. */
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex gap-3 py-4 first:pt-0 last:pb-0 sm:gap-6",
        inline ? "items-center justify-between" : "flex-col sm:flex-row sm:items-center sm:justify-between"
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-white">{label}</div>
        {help && <div className="mt-0.5 text-xs leading-relaxed text-white/55">{help}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Segmented choice (a small glass capsule of options). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-white/[0.06] p-1 [scrollbar-width:none]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 text-sm font-medium transition-colors sm:px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-50",
            value === option.value ? "bg-white text-black" : "text-white/75 hover:bg-white/10 hover:text-white"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-50",
        checked ? "bg-[var(--primary)]" : "bg-white/15"
      )}
    >
      <span className={cn("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-6" : "translate-x-1")} />
    </button>
  );
}

export const inputClass =
  "h-11 w-full rounded-2xl border border-white/12 bg-white/[0.06] px-4 text-sm text-white placeholder:text-white/35 focus:border-white/45 focus:outline-none sm:w-72";

export function PrimaryButton({
  children,
  onClick,
  disabled,
  busy,
  type = "button",
  tone = "light",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  tone?: "light" | "subtle" | "danger";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40",
        tone === "light" && "bg-white text-black hover:bg-white/90",
        tone === "subtle" && "bg-white/10 text-white hover:bg-white/15",
        tone === "danger" && "bg-red-500/15 text-red-300 hover:bg-red-500/25"
      )}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function StatusPill({ tone, children }: { tone: "ok" | "warn" | "off"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
        tone === "ok" && "bg-emerald-500/15 text-emerald-300",
        tone === "warn" && "bg-amber-500/15 text-amber-300",
        tone === "off" && "bg-white/10 text-white/60"
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", tone === "ok" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-400" : "bg-white/40")} />
      {children}
    </span>
  );
}

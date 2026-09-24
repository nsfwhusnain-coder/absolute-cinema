import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface MessageAction {
  label: string;
  onClick?: () => void;
  href?: string;
  primary?: boolean;
}

const actionClass = (primary?: boolean) =>
  cn(
    "inline-flex h-11 items-center justify-center rounded-full px-6 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
    primary ? "bg-white text-black hover:bg-white/90" : "bg-[var(--mat-fill-hover)] text-white hover:bg-[var(--mat-fill-active)]"
  );

/**
 * The one way the app shows a problem or an empty state: a glass card with an
 * icon, a short title, a plain-language explanation and up to two actions.
 */
export function MessageCard({
  icon,
  title,
  children,
  actions = [],
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: MessageAction[];
  className?: string;
}) {
  return (
    <div role="status" className={cn("glass-strong mx-auto w-full max-w-md rounded-3xl p-7 text-center text-white", className)}>
      {icon && <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--mat-fill-hover)]">{icon}</div>}
      <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
      {children && <div className="mt-2 text-sm leading-relaxed text-white/70">{children}</div>}
      {actions.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {actions.map((action) =>
            action.href ? (
              <Link key={action.label} href={action.href} className={actionClass(action.primary)}>
                {action.label}
              </Link>
            ) : (
              <button key={action.label} type="button" onClick={action.onClick} className={actionClass(action.primary)}>
                {action.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

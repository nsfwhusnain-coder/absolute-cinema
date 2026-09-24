"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { AVATAR_COLORS } from "@/lib/avatar-colors";
import { AVATAR_GROUPS, avatarSrc } from "@/lib/avatars";
import { cn } from "@/lib/utils";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const SIZES = {
  xs: "h-7 w-7 text-xs",
  sm: "h-9 w-9 text-sm",
  md: "h-16 w-16 text-2xl",
  lg: "h-20 w-20 text-3xl sm:h-32 sm:w-32 sm:text-4xl",
} as const;

/** A profile's picture on its colour, or its initials when it has no picture. */
export function ProfileAvatar({
  name,
  color,
  avatar,
  size = "lg",
  className,
}: {
  name: string;
  color: string;
  avatar?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const src = avatar ? avatarSrc(avatar) : null;
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-[28%] font-display font-bold text-white shadow-lg",
        SIZES[size],
        className
      )}
      style={{ background: `linear-gradient(145deg, color-mix(in srgb, ${color} 85%, #fff), color-mix(in srgb, ${color} 60%, #000))` }}
    >
      {src ? (
        <img src={src} alt="" draggable={false} className="h-[92%] w-[92%] translate-y-[6%] object-contain" />
      ) : (
        initials(name)
      )}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]" />
    </span>
  );
}

/** Picture and colour chooser used when creating or editing a profile. */
export function AvatarPicker({
  name,
  avatar,
  color,
  onChange,
}: {
  name: string;
  avatar: string;
  color: string;
  onChange: (next: { avatar?: string; color?: string }) => void;
}) {
  const [group, setGroup] = useState(() => Math.max(0, AVATAR_GROUPS.findIndex((g) => (g.ids as readonly string[]).includes(avatar))));
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-full bg-white/[0.06] p-1" role="tablist" aria-label="Picture style">
        {AVATAR_GROUPS.map((g, i) => (
          <button
            key={g.label}
            type="button"
            role="tab"
            aria-selected={group === i}
            onClick={() => setGroup(i)}
            className={cn(
              "h-8 flex-1 rounded-full text-xs font-semibold transition-colors",
              group === i ? "bg-white text-black" : "text-white/70 hover:text-white"
            )}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-2.5" role="radiogroup" aria-label="Picture">
        {AVATAR_GROUPS[group]!.ids.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={avatar === id}
            aria-label={`Picture ${id.split("-")[1]}`}
            onClick={() => onChange({ avatar: id })}
            className={cn(
              "rounded-[30%] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              avatar === id ? "ring-2 ring-white ring-offset-2 ring-offset-black/50" : "opacity-80 hover:opacity-100"
            )}
          >
            <ProfileAvatar name={name || "?"} color={color} avatar={id} size="md" className="h-auto w-full aspect-square shadow-none" />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="Colour">
        {AVATAR_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={`Colour ${c}`}
            onClick={() => onChange({ color: c })}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              color === c && "ring-2 ring-white ring-offset-2 ring-offset-black/50"
            )}
            style={{ background: c }}
          >
            {color === c && <Check className="h-4 w-4 text-white" />}
          </button>
        ))}
      </div>
    </div>
  );
}

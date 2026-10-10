"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ImagePlus, Loader2, Pipette, Search, Shuffle, Trash2 } from "lucide-react";
import { AVATAR_COLORS } from "@/lib/avatar-colors";
import {
  AVATAR_EMOJI,
  AVATAR_GROUPS,
  EMOJI_PREFIX,
  TMDB_PREFIX,
  UPLOAD_PREFIX,
  allBundledAvatars,
  isSingleEmoji,
  resolveAvatar,
} from "@/lib/avatars";
import { useDebounce } from "@/hooks/use-debounce";
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
  xl: "h-28 w-28 text-4xl sm:h-36 sm:w-36 sm:text-5xl",
} as const;

/** A profile's picture on its colour: an illustration, an emoji, a photo, or its initials. */
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
  const resolved = resolveAvatar(avatar);
  const src = resolved.kind === "image" ? resolved.src : null;
  // A face whose photo went missing upstream falls back to initials, not a broken image.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const showImage = resolved.kind === "image" && brokenSrc !== src;
  return (
    <span
      aria-hidden
      className={cn(
        "avatar-box relative flex shrink-0 items-center justify-center overflow-hidden rounded-[28%] font-display font-bold text-white shadow-lg",
        SIZES[size],
        className
      )}
      style={{ background: `linear-gradient(145deg, color-mix(in srgb, ${color} 85%, #fff), color-mix(in srgb, ${color} 60%, #000))` }}
    >
      {showImage && resolved.kind === "image" ? (
        <img
          src={resolved.src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={() => setBrokenSrc(resolved.src)}
          className={cn(
            resolved.fullBleed ? "h-full w-full" : "h-[92%] w-[92%] translate-y-[6%]",
            resolved.fit === "cover" ? "object-cover" : "object-contain"
          )}
        />
      ) : resolved.kind === "emoji" ? (
        <span className="avatar-emoji select-none leading-none">{resolved.emoji}</span>
      ) : (
        initials(name)
      )}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]" />
    </span>
  );
}

type PickerTab = "art" | "emoji" | "faces" | "photo";

interface PhotoActions {
  /** Uploads a photo and makes it the picture. */
  upload(file: File): Promise<void>;
  remove(): Promise<void>;
}

/**
 * Picture and colour chooser used when creating or editing a profile:
 * 140-odd illustrations in thirteen styles, any emoji, famous faces from
 * TMDB and (once signed in) a photo of your own.
 */
export function AvatarPicker({
  name,
  avatar,
  color,
  onChange,
  signedIn = false,
  photo,
}: {
  name: string;
  avatar: string;
  color: string;
  onChange: (next: { avatar?: string; color?: string }) => void;
  /** Famous faces search TMDB, which needs a signed-in profile. */
  signedIn?: boolean;
  /** Offered only where the profile exists already (Settings). */
  photo?: PhotoActions;
}) {
  const kind = avatar.startsWith(EMOJI_PREFIX) ? "emoji" : avatar.startsWith(TMDB_PREFIX) ? "faces" : avatar.startsWith(UPLOAD_PREFIX) ? "photo" : "art";
  const [tab, setTab] = useState<PickerTab>(() => (kind === "faces" && !signedIn) || (kind === "photo" && !photo) ? "art" : kind);
  const tabs: { id: PickerTab; label: string }[] = [
    { id: "art", label: "Illustrations" },
    { id: "emoji", label: "Emoji" },
    ...(signedIn ? [{ id: "faces" as const, label: "Famous faces" }] : []),
    ...(photo ? [{ id: "photo" as const, label: "Your photo" }] : []),
  ];

  const surprise = () => {
    const all = allBundledAvatars();
    const pick = all[Math.floor(Math.random() * all.length)]!;
    const hue = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
    onChange({ avatar: pick, color: hue });
    setTab("art");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-full bg-white/[0.06] p-1 scrollbar-hide" role="tablist" aria-label="Picture type">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "h-8 shrink-0 grow whitespace-nowrap rounded-full px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                tab === t.id ? "bg-white text-black" : "text-white/70 hover:text-white"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={surprise}
          aria-label="Surprise me: a random picture and colour"
          title="Surprise me"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-white/80 transition hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <Shuffle className="h-4 w-4" />
        </button>
      </div>

      {tab === "art" && <IllustrationGrid name={name} avatar={avatar} color={color} onPick={(id) => onChange({ avatar: id })} />}
      {tab === "emoji" && <EmojiGrid avatar={avatar} color={color} onPick={(value) => onChange({ avatar: value })} />}
      {tab === "faces" && signedIn && <FacesGrid avatar={avatar} color={color} onPick={(value) => onChange({ avatar: value })} />}
      {tab === "photo" && photo && <PhotoPanel name={name} avatar={avatar} color={color} actions={photo} />}

      <ColourRow color={color} onPick={(c) => onChange({ color: c })} muted={kind === "faces" || kind === "photo"} />
    </div>
  );
}

function IllustrationGrid({ name, avatar, color, onPick }: { name: string; avatar: string; color: string; onPick(id: string): void }) {
  const [group, setGroup] = useState(() => Math.max(0, AVATAR_GROUPS.findIndex((g) => g.ids.includes(avatar))));
  const chips = useRef<HTMLDivElement>(null);
  // Bring the chosen style's chip into view when the picker opens on it.
  useEffect(() => {
    chips.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, []);
  return (
    <div className="space-y-3">
      <div ref={chips} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-hide" role="tablist" aria-label="Illustration style">
        {AVATAR_GROUPS.map((g, i) => (
          <button
            key={g.label}
            type="button"
            role="tab"
            aria-selected={group === i}
            onClick={() => setGroup(i)}
            className={cn(
              "flex h-9 shrink-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              group === i ? "border-white/70 bg-white/15 text-white" : "border-white/10 text-white/65 hover:border-white/25 hover:text-white"
            )}
          >
            <ProfileAvatar name="" color={color} avatar={g.ids[0]} size="xs" className="shadow-none" />
            {g.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6" role="radiogroup" aria-label={`${AVATAR_GROUPS[group]!.label} pictures`}>
        {AVATAR_GROUPS[group]!.ids.map((id) => (
          <PickTile key={id} selected={avatar === id} label={`Picture ${id.split("-").slice(1).join(" ")}`} onClick={() => onPick(id)}>
            <ProfileAvatar name={name || "?"} color={color} avatar={id} size="md" className="aspect-square h-auto w-full shadow-none" />
          </PickTile>
        ))}
      </div>
    </div>
  );
}

function EmojiGrid({ avatar, color, onPick }: { avatar: string; color: string; onPick(value: string): void }) {
  const [typed, setTyped] = useState("");
  const typedOk = isSingleEmoji(typed.trim());
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-6 gap-2 sm:grid-cols-8" role="radiogroup" aria-label="Emoji">
        {AVATAR_EMOJI.map((emoji) => {
          const value = `${EMOJI_PREFIX}${emoji}`;
          return (
            <PickTile key={emoji} selected={avatar === value} label={`Emoji ${emoji}`} onClick={() => onPick(value)}>
              <ProfileAvatar name="" color={color} avatar={value} size="md" className="aspect-square h-auto w-full shadow-none" />
            </PickTile>
          );
        })}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typedOk) onPick(`${EMOJI_PREFIX}${typed.trim()}`);
        }}
      >
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Or type any emoji"
          aria-label="Any emoji"
          className="h-10 min-w-0 flex-1 rounded-full border border-white/10 bg-white/[0.06] px-4 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!typedOk}
          className="h-10 rounded-full bg-white px-4 text-sm font-semibold text-black transition disabled:opacity-40"
        >
          Use
        </button>
      </form>
    </div>
  );
}

interface PersonRow {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department?: string;
}

function FacesGrid({ avatar, color, onPick }: { avatar: string; color: string; onPick(value: string): void }) {
  const [query, setQuery] = useState("");
  const q = useDebounce(query.trim(), 350);
  const { data, isFetching, isError } = useQuery({
    queryKey: ["avatar-faces", q],
    queryFn: async (): Promise<PersonRow[]> => {
      const pages = q ? [`search/person?query=${encodeURIComponent(q)}`] : ["person/popular?page=1", "person/popular?page=2"];
      const rows = await Promise.all(
        pages.map(async (path) => {
          const res = await fetch(`/api/tmdb/${path}`);
          if (!res.ok) throw new Error("Could not load faces");
          return ((await res.json()) as { results?: PersonRow[] }).results ?? [];
        })
      );
      return rows.flat().filter((p) => p.profile_path);
    },
    staleTime: 60 * 60 * 1000,
  });
  const people = useMemo(() => (data ?? []).slice(0, 30), [data]);
  return (
    <div className="space-y-3">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search actors and directors"
          aria-label="Search famous faces"
          className="h-10 w-full rounded-full border border-white/10 bg-white/[0.06] pl-10 pr-4 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
        />
      </label>
      {isError ? (
        <p className="py-6 text-center text-sm text-white/55">Faces couldn&apos;t load right now.</p>
      ) : !data && isFetching ? (
        <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-[28%] bg-white/[0.06]" />
          ))}
        </div>
      ) : people.length === 0 ? (
        <p className="py-6 text-center text-sm text-white/55">No faces found for &ldquo;{q}&rdquo;.</p>
      ) : (
        <div className="grid max-h-72 grid-cols-4 gap-x-2.5 gap-y-3 overflow-y-auto pr-1 sm:grid-cols-6" role="radiogroup" aria-label="Famous faces">
          {people.map((p) => {
            const value = `${TMDB_PREFIX}${p.profile_path}`;
            return (
              <div key={p.id} className="min-w-0">
                <PickTile selected={avatar === value} label={p.name} onClick={() => onPick(value)}>
                  <ProfileAvatar name={p.name} color={color} avatar={value} size="md" className="aspect-square h-auto w-full shadow-none" />
                </PickTile>
                <div className="mt-1 truncate text-center text-[11px] text-white/60">{p.name}</div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-white/35">Photos from TMDB.</p>
    </div>
  );
}

/** Scales a photo down in the browser before upload (any format the browser can open, iPhone HEIC included). */
async function shrinkPhoto(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const target = Math.min(768, side);
    const canvas = document.createElement("canvas");
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // Centre square; the server refines the crop around the subject.
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, target, target);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return blob ?? file;
  } catch {
    return file;
  }
}

function PhotoPanel({ name, avatar, color, actions }: { name: string; avatar: string; color: string; actions: PhotoActions }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [dragging, setDragging] = useState(false);
  const hasPhoto = avatar.startsWith(UPLOAD_PREFIX);

  const send = async (file: File | undefined) => {
    if (!file) return;
    setBusy("upload");
    try {
      const shrunk = await shrinkPhoto(file);
      await actions.upload(new File([shrunk], file.name, { type: shrunk.type || file.type }));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        void send(e.dataTransfer.files?.[0]);
      }}
      className={cn(
        "flex flex-col items-center gap-4 rounded-3xl border border-dashed px-4 py-6 text-center transition-colors sm:flex-row sm:text-left",
        dragging ? "border-white/60 bg-white/[0.08]" : "border-white/15 bg-white/[0.03]"
      )}
    >
      <ProfileAvatar name={name || "?"} color={color} avatar={hasPhoto ? avatar : ""} size="md" className="shadow-none" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-white">{hasPhoto ? "Your photo" : "Use a photo of your own"}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-white/55">
          Drop one here or choose a file: JPG, PNG or WebP up to 8 MB (photos picked on an iPhone or iPad work too). It&apos;s cropped to a square around the face.
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={busy !== null}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-white px-4 text-xs font-semibold text-black transition hover:bg-white/90 disabled:opacity-60"
          >
            {busy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
            {hasPhoto ? "Choose another" : "Choose a photo"}
          </button>
          {hasPhoto && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("remove");
                try {
                  await actions.remove();
                } finally {
                  setBusy(null);
                }
              }}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-white/10 px-4 text-xs font-medium text-white transition hover:bg-white/15 disabled:opacity-60"
            >
              {busy === "remove" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Remove photo
            </button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e: ChangeEvent<HTMLInputElement>) => void send(e.target.files?.[0])}
      />
    </div>
  );
}

function ColourRow({ color, onPick, muted }: { color: string; onPick(color: string): void; muted: boolean }) {
  const custom = !(AVATAR_COLORS as readonly string[]).includes(color.toLowerCase());
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs font-medium text-white/60">Colour</span>
        {muted && <span className="text-[11px] text-white/35">Shows behind illustrations, emoji and initials</span>}
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
        {AVATAR_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color.toLowerCase() === c}
            aria-label={`Colour ${c}`}
            onClick={() => onPick(c)}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full transition hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              color.toLowerCase() === c && "ring-2 ring-white ring-offset-2 ring-offset-black/50"
            )}
            style={{ background: c }}
          >
            {color.toLowerCase() === c && <Check className="h-4 w-4 text-white" />}
          </button>
        ))}
        <label
          title="Any colour"
          className={cn(
            "relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition hover:scale-110 focus-within:ring-2 focus-within:ring-white/70",
            custom && "ring-2 ring-white ring-offset-2 ring-offset-black/50"
          )}
          style={{ background: custom ? color : "conic-gradient(#f43f5e, #eab308, #22c55e, #06b6d4, #6366f1, #d946ef, #f43f5e)" }}
        >
          {custom ? <Check className="h-4 w-4 text-white" /> : <Pipette className="h-3.5 w-3.5 text-white drop-shadow" />}
          <input
            type="color"
            aria-label="Pick any colour"
            value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#e50914"}
            onChange={(e) => onPick(e.target.value.toLowerCase())}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
      </div>
    </div>
  );
}

function PickTile({ selected, label, onClick, children }: { selected: boolean; label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "block w-full rounded-[30%] transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        selected ? "scale-[1.04] ring-2 ring-white ring-offset-2 ring-offset-black/50" : "opacity-85 hover:scale-[1.04] hover:opacity-100"
      )}
    >
      {children}
    </button>
  );
}

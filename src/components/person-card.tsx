"use client";

import { useState } from "react";
import Link from "next/link";
import { tmdbImageUrl } from "@/lib/tmdb";

interface Props {
  id: number;
  name: string;
  character?: string;
  profilePath: string | null;
  /** "poster" matches MovieCard's 2:3 tile so people sit cleanly in mixed grids. */
  variant?: "avatar" | "poster";
  department?: string;
}

export function PersonCard({ id, name, character, profilePath, variant = "avatar", department }: Props) {
  const img = tmdbImageUrl(profilePath, variant === "poster" ? "w342" : "w185");
  const [imgFailed, setImgFailed] = useState(false);
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  if (variant === "poster") {
    return (
      <Link
        href={`/person/${id}`}
        className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={`View ${name}`}
      >
        <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-gradient-to-br from-[#1a1a22] to-[#0e0e14] ring-1 ring-white/5">
          {img && !imgFailed ? (
            <img
              src={img}
              alt=""
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-2xl font-semibold text-white/30">
              {initials}
            </div>
          )}
        </div>
        <div className="mt-2 truncate font-semibold text-white">{name}</div>
        <div className="mt-0.5 truncate text-sm text-muted-foreground">{department || "Person"}</div>
      </Link>
    );
  }

  return (
    <Link
      href={`/person/${id}`}
      className="group flex flex-col items-center gap-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-xl"
      aria-label={`View ${name}`}
    >
      <div className="relative aspect-square w-full max-w-24 overflow-hidden rounded-full bg-muted ring-1 ring-border transition-all duration-300 group-hover:ring-2 group-hover:ring-primary">
        {img && !imgFailed ? (
          <img
            src={img}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-muted-foreground">
            {initials}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium line-clamp-1">{name}</div>
        {character && <div className="text-[10px] text-muted-foreground line-clamp-1">{character}</div>}
      </div>
    </Link>
  );
}

"use client";

import { MovieCard, type MovieCardData } from "@/components/movie-card";
import { MovieRow } from "@/components/movie-row";

const TOP_TEN = 10;

/** Netflix-style "Top 10" rail: a large outlined rank behind each poster. */
export function TopTenRow({ title, items }: { title: string; items: Array<MovieCardData & { media_type: "movie" | "tv" }> }) {
  if (items.length < 3) return null;
  return (
    <MovieRow title={title}>
      {items.slice(0, TOP_TEN).map((item, index) => (
        <div key={`${item.media_type}-${item.id}`} className="relative flex shrink-0 items-end pl-[3.25rem] sm:pl-[4.5rem]">
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-0 select-none font-display text-[7.5rem] font-black leading-[0.8] tracking-tighter text-transparent sm:text-[10rem]"
            style={{ WebkitTextStroke: "3px rgba(255,255,255,0.55)" }}
          >
            {index + 1}
          </span>
          <MovieCard movie={item} forceMediaType={item.media_type} hideMeta />
        </div>
      ))}
    </MovieRow>
  );
}

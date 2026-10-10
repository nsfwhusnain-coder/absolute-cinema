import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { parseRouteId, parseRouteIndex } from "@/lib/route-params";
import { WatchView } from "@/views/watch";
import { resolvePlayableTitle } from "@/lib/catalog/title-alias.server";
import { playableHref } from "@/lib/catalog/title-alias";
import { tmdb } from "@/lib/tmdb";

interface SearchParams {
  season?: string;
  episode?: string;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const { type, id } = await params;
  const { season, episode } = await searchParams;
  const mediaType = type === "tv" ? "tv" : "movie";
  const tmdbId = parseRouteId(id);
  if (!tmdbId) return { title: "Watch" };
  try {
    if (mediaType === "movie") {
      const data = await tmdb.movieDetails(tmdbId);
      const name = data.title || "Movie";
      return { title: `Watch ${name}` };
    }
    const data = await tmdb.tvDetails(tmdbId);
    const name = data.name || "Series";
    if (season != null && episode != null) {
      return { title: `Watch ${name} S${season}E${episode}` };
    }
    return { title: `Watch ${name}` };
  } catch {
    return { title: "Watch" };
  }
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { type, id } = await params;
  const { season, episode } = await searchParams;
  if (type !== "tv" && type !== "movie") notFound();
  const mediaType = type;
  const tmdbId = parseRouteId(id);
  if (!tmdbId) notFound();
  const playable = await resolvePlayableTitle(mediaType, tmdbId);
  if (playable.mediaType !== mediaType || playable.tmdbId !== tmdbId) {
    redirect(playableHref(playable));
  }

  return (
    <WatchView
      mediaType={mediaType}
      id={tmdbId}
      season={parseRouteIndex(season) ?? undefined}
      episode={parseRouteIndex(episode) ?? undefined}
    />
  );
}

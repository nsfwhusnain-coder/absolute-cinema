import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TvSeasonView } from "@/views/tv-season";
import { tmdb } from "@/lib/tmdb";
import { parseRouteId, parseRouteIndex } from "@/lib/route-params";

export async function generateMetadata({ params }: { params: Promise<{ id: string; n: string }> }): Promise<Metadata> {
  const { id, n } = await params;
  const tvId = parseRouteId(id);
  const season = parseRouteIndex(n);
  if (!tvId || season === null) return { title: "Season" };
  try {
    const data = await tmdb.tvDetails(tvId);
    return { title: `${data.name || "Series"} · ${season === 0 ? "Specials" : `Season ${season}`}` };
  } catch {
    return { title: season === 0 ? "Specials" : `Season ${season}` };
  }
}

export default async function Page({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  const tvId = parseRouteId(id);
  const season = parseRouteIndex(n);
  if (!tvId || season === null) notFound();
  return <TvSeasonView tvId={tvId} season={season} />;
}

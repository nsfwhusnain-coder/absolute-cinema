import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DetailView } from "@/views/movie-detail";
import { parseRouteId } from "@/lib/route-params";
import { tmdb } from "@/lib/tmdb";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const tvId = parseRouteId(id);
  if (!tvId) return { title: "Series" };
  try {
    const data = await tmdb.tvDetails(tvId);
    const title = data.name || "Series";
    const year = data.first_air_date?.slice(0, 4) || null;
    return {
      title: year ? `${title} (${year})` : title,
      description: data.overview?.slice(0, 160) || `Watch ${title} on Absolute Cinema.`,
    };
  } catch {
    return { title: "Series" };
  }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tvId = parseRouteId(id);
  if (!tvId) notFound();
  const data = await tmdb.tvDetails(tvId).catch(() => undefined);
  return <DetailView mediaType="tv" id={tvId} initialData={data} />;
}

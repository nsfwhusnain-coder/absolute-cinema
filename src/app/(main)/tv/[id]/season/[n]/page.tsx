import type { Metadata } from "next";
import { TvSeasonView } from "@/views/tv-season";
import { tmdb } from "@/lib/tmdb";

export async function generateMetadata({ params }: { params: Promise<{ id: string; n: string }> }): Promise<Metadata> {
  const { id, n } = await params;
  try {
    const data = await tmdb.tvDetails(Number(id));
    return { title: `${data.name || "Series"} · Season ${Number(n)}` };
  } catch {
    return { title: `Season ${Number(n)}` };
  }
}

export default async function Page({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  return <TvSeasonView tvId={Number(id)} season={Number(n)} />;
}

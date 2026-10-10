import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PersonView } from "@/views/person";
import { tmdb } from "@/lib/tmdb";
import { parseRouteId } from "@/lib/route-params";

function personId(raw: string): number {
  return parseRouteId(raw) ?? 0;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const numericId = personId(id);
  if (!numericId) return { title: "Person" };
  try {
    const data = await tmdb.personDetails(numericId);
    return {
      title: data.name || "Person",
      description: data.biography?.slice(0, 160) || `${data.name} on Absolute Cinema.`,
    };
  } catch {
    return { title: "Person" };
  }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = personId(id);
  if (!numericId) notFound();
  const [person, credits] = await Promise.all([
    tmdb.personDetails(numericId).catch(() => null),
    tmdb.personCredits(numericId).catch(() => null),
  ]);
  return <PersonView id={numericId} initialPerson={person} initialCredits={credits} />;
}

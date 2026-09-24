import type { Metadata } from "next";
import { BrowseHub } from "@/views/browse-hub";
import { animeHubRows } from "@/lib/browse-categories";

export const metadata: Metadata = {
  title: "Anime",
};

export default function AnimePage() {
  return <BrowseHub mediaType="tv" title="Anime" heroFrom="anime" rows={animeHubRows()} />;
}

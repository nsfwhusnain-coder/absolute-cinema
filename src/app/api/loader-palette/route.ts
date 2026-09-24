import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { getAuthenticatedUserId } from "@/lib/auth";
import { cachedFetch } from "@/lib/server-cache";
import { tmdb } from "@/lib/tmdb";
import { clusterPixels, derivePalette, type LoaderPalette } from "@/lib/loader/palette";

const IMAGE_BASE = "https://image.tmdb.org/t/p";
const SAMPLE_SIZE = 48;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

/** Used when a title has no usable artwork: a neutral night-blue set. */
const DEFAULT_PALETTE: LoaderPalette = { background: "#05070f", main: "#3d7bd9", accent: "#9ad8f0", highlight: "#e8f1ff" };

async function samplePixels(path: string | null | undefined, size: string): Promise<Array<[number, number, number]>> {
  if (!path) return [];
  const res = await fetch(`${IMAGE_BASE}/${size}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return [];
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i + 2 < data.length; i += info.channels) out.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  return out;
}

/**
 * GET /api/loader-palette?type=movie|tv&id= → { palette, genres }
 * Colours for the loading scene, from the title's poster and backdrop.
 */
export async function GET(req: NextRequest) {
  if (!(await getAuthenticatedUserId())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const type = req.nextUrl.searchParams.get("type");
  const id = Number(req.nextUrl.searchParams.get("id"));
  if ((type !== "movie" && type !== "tv") || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  try {
    const result = await cachedFetch(
      `loader-palette:${type}:${id}`,
      async () => {
        const details = type === "movie" ? await tmdb.movieDetails(id) : await tmdb.tvDetails(id);
        const [poster, backdrop] = await Promise.all([
          samplePixels(details.poster_path, "w185").catch(() => []),
          samplePixels(details.backdrop_path, "w300").catch(() => []),
        ]);
        return {
          palette: derivePalette(clusterPixels([...poster, ...backdrop]), DEFAULT_PALETTE),
          genres: (details.genres ?? []).map((g) => g.id),
        };
      },
      TTL_MS
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=86400" } });
  } catch {
    return NextResponse.json({ palette: DEFAULT_PALETTE, genres: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}

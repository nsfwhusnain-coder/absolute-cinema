import type { ProviderStream } from "./types";
import { rethrowIfProviderOutage, throwIfHttpOutage } from "./provider-outage";

const BASE_URL = "https://vixsrc.to";
const VIXSRC_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BASE_URL,
  Origin: BASE_URL,
};

function extractTokenData(html: string): { token: string; expires: string; playlist: string } | null {
  const token = html.match(/token["']\s*:\s*["']([^"']+)/)?.[1];
  const expires = html.match(/expires["']\s*:\s*["']([^"']+)/)?.[1];
  const playlist = html.match(/url\s*:\s*["']([^"']+)/)?.[1];
  if (!token || !expires || !playlist) return null;
  if (parseInt(expires, 10) * 1000 - 60_000 < Date.now()) return null;
  return { token, expires, playlist };
}

function parseBestQuality(content: string): number {
  const variantRegex = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)[^\n]*/g;
  let match: RegExpExecArray | null;
  let best = 0;
  while ((match = variantRegex.exec(content)) !== null) {
    const res = parseInt(match[1], 10);
    if (res > best) best = res;
  }
  return best;
}

/**
 * The language a viewer gets from this master playlist. Vixsrc lists Italian
 * as the default audio and English (when it has it) as an option, and the
 * player switches to the viewer's language on load, so a playlist that offers
 * English counts as English. One that does not is labelled with what it does
 * carry, so it never stands in for an English source by being "unlabelled".
 */
export function parseAudioLanguage(content: string): string | undefined {
  const languages: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith("#EXT-X-MEDIA:") || !/TYPE=AUDIO/.test(line)) continue;
    const language = line.match(/LANGUAGE="([^"]+)"/)?.[1]?.toLowerCase();
    if (language) languages.push(language);
  }
  if (languages.length === 0) return undefined;
  if (languages.some((l) => l === "eng" || l === "en" || l.startsWith("en-"))) return "en";
  return languages[0];
}

export async function resolveVixsrc(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<ProviderStream[]> {
  const apiUrl =
    mediaType === "movie"
      ? `${BASE_URL}/api/movie/${tmdbId}`
      : `${BASE_URL}/api/tv/${tmdbId}/${season}/${episode}`;

  try {
    const apiRes = await fetch(apiUrl, { headers: VIXSRC_HEADERS, signal: AbortSignal.timeout(10000) });
    throwIfHttpOutage(apiRes.status, "vixsrc");
    if (!apiRes.ok) return [];
    const apiData = (await apiRes.json()) as { src?: string };
    if (!apiData.src) return [];

    const embedRes = await fetch(`${BASE_URL}${apiData.src}`, {
      headers: { ...VIXSRC_HEADERS, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: AbortSignal.timeout(10000),
    });
    throwIfHttpOutage(embedRes.status, "vixsrc");
    if (!embedRes.ok) return [];
    const html = await embedRes.text();

    const tokenData = extractTokenData(html);
    if (!tokenData) return [];

    const sep = tokenData.playlist.includes("?") ? "&" : "?";
    const masterUrl = `${tokenData.playlist}${sep}token=${tokenData.token}&expires=${tokenData.expires}&h=1`;

    const playlistRes = await fetch(masterUrl, {
      headers: { ...VIXSRC_HEADERS, Referer: apiUrl },
      signal: AbortSignal.timeout(10000),
    });
    throwIfHttpOutage(playlistRes.status, "vixsrc");
    if (!playlistRes.ok) return [];
    const playlistContent = await playlistRes.text();

    const bestRes = parseBestQuality(playlistContent);
    if (bestRes === 0) return [];

    console.log(`[vixsrc] ${bestRes}p stream for ${tmdbId}`);
    return [
      {
        url: masterUrl,
        quality: `${bestRes}p`,
        label: "Luna",
        provider: "Vixsrc",
        referer: apiUrl,
        origin: BASE_URL,
        userAgent: VIXSRC_HEADERS["User-Agent"],
        audioLanguage: parseAudioLanguage(playlistContent),
      },
    ];
  } catch (err) {
    rethrowIfProviderOutage(err, "vixsrc");
    return [];
  }
}
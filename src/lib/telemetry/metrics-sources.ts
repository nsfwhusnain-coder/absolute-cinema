/** Where the scraper's own metrics are read, when the web app's `SCRAPER_URL` is not set. Same default as src/lib/playback/scraper.ts. */
const SCRAPER_DEFAULT_URL = "http://127.0.0.1:3030/scrape";
const SCRAPER_FALLBACK_METRICS_URL = "http://127.0.0.1:3030/metrics";

/** Prometheus scrapes every 15 s: a process that does not answer within this is left out of the scrape. */
export const SOURCE_TIMEOUT_MS = 2_000;

/**
 * The scraper's `/metrics` address, from the URL the web app scrapes (`…/scrape`
 * or `…/prefetch`, with an optional prefix before them).
 */
export function scraperMetricsUrl(scraperUrl: string | undefined = process.env.SCRAPER_URL): string {
  try {
    const url = new URL(scraperUrl || SCRAPER_DEFAULT_URL);
    const base = url.pathname.replace(/\/(scrape|prefetch)\/?$/, "").replace(/\/+$/, "");
    url.pathname = `${base}/metrics`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return SCRAPER_FALLBACK_METRICS_URL;
  }
}

/**
 * One process's metrics text, or null when it cannot be read in time: a
 * process that is down or slow is left out of the scrape, not waited for.
 */
export async function fetchMetricsText(
  url: string,
  timeoutMs = SOURCE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

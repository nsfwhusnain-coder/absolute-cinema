/**
 * The scraper's live numbers (see docs/TELEMETRY.md), served at GET /metrics
 * on its own port and passed on by the web app's /api/metrics.
 */

import { metrics } from "../../src/lib/metrics";

const registry = metrics();

export const providerResults = registry.counter(
  "ac_scraper_provider_results_total",
  "Each web provider's answer, by status (hit, empty, error) and mode (fast, full).",
  ["provider", "status", "mode"]
);
export const providerSeconds = registry.histogram("ac_scraper_provider_seconds", "A web provider's time to answer.", ["provider", "mode"]);
export const providerStreams = registry.counter("ac_scraper_provider_streams_total", "Streams a web provider found, by quality bucket.", ["provider", "quality"]);
export const scrapeRequests = registry.counter("ac_scraper_requests_total", "Scrape requests, by mode and cache outcome.", ["mode", "cache"]);
export const browserScrapes = registry.counter("ac_scraper_browser_scrapes_total", "Headless-browser scrapes, by outcome.", ["outcome"]);

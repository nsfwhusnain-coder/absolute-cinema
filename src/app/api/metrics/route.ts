import { NextRequest, NextResponse } from "next/server";
import { metrics } from "@/lib/metrics";
import { REMUXER_URL } from "@/lib/playback/remuxer";
import { metricsSourceUp } from "@/lib/telemetry/web-metrics";
import { checkMetricsAccess } from "@/lib/telemetry/metrics-access";
import { fetchMetricsText, scraperMetricsUrl } from "@/lib/telemetry/metrics-sources";

export const dynamic = "force-dynamic";

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * GET /api/metrics: every process's live numbers in Prometheus' text format,
 * the web app's first, then the remuxer's and the scraper's (see docs/TELEMETRY.md).
 * It answers 404 while METRICS_TOKEN is not set, and 401 to a request that
 * does not carry it as a bearer token.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const access = checkMetricsAccess(req.headers.get("authorization"), process.env.METRICS_TOKEN);
  if (access === "disabled") return new NextResponse("Not found\n", { status: 404 });
  if (access === "denied") {
    return new NextResponse("Unauthorized\n", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="metrics"' },
    });
  }

  const [remuxer, scraper] = await Promise.all([
    fetchMetricsText(`${REMUXER_URL.replace(/\/+$/, "")}/metrics`),
    fetchMetricsText(scraperMetricsUrl()),
  ]);
  // Set before the web app's own text is rendered, so the gauges are in it.
  metricsSourceUp.set({ source: "remuxer" }, remuxer === null ? 0 : 1);
  metricsSourceUp.set({ source: "scraper" }, scraper === null ? 0 : 1);

  const parts = [metrics().render(), remuxer, scraper].filter((part): part is string => part !== null);
  return new NextResponse(parts.map(withNewline).join(""), {
    headers: { "Content-Type": CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}

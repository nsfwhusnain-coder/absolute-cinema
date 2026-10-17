import { describe, expect, it } from "bun:test";
import { fetchMetricsText, scraperMetricsUrl } from "./metrics-sources";

describe("scraperMetricsUrl", () => {
  it("is the scraper's own metrics address, from the URL the web app scrapes", () => {
    expect(scraperMetricsUrl("http://127.0.0.1:3030/scrape")).toBe("http://127.0.0.1:3030/metrics");
    expect(scraperMetricsUrl("http://scraper:3030/prefetch?x=1")).toBe("http://scraper:3030/metrics");
    expect(scraperMetricsUrl("http://scraper:3030/scrape/")).toBe("http://scraper:3030/metrics");
  });

  it("keeps a path before the scrape path", () => {
    expect(scraperMetricsUrl("http://host/prefix/scrape")).toBe("http://host/prefix/metrics");
  });

  it("works from a bare origin, too", () => {
    expect(scraperMetricsUrl("http://scraper:3030")).toBe("http://scraper:3030/metrics");
  });

  it("falls back to the default port when the URL is not one", () => {
    expect(scraperMetricsUrl("not a url")).toBe("http://127.0.0.1:3030/metrics");
  });

  it("uses the default scrape address when SCRAPER_URL is unset", () => {
    const saved = process.env.SCRAPER_URL;
    delete process.env.SCRAPER_URL;
    try {
      expect(scraperMetricsUrl()).toBe("http://127.0.0.1:3030/metrics");
    } finally {
      if (saved !== undefined) process.env.SCRAPER_URL = saved;
    }
  });
});

describe("fetchMetricsText", () => {
  it("is the text of a process that answers", async () => {
    const answers = (async () => new Response("ac_x_total 1\n", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchMetricsText("http://remuxer/metrics", 2000, answers)).toBe("ac_x_total 1\n");
  });

  it("is null for an answer that is not OK, or a request that fails", async () => {
    const refused = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect(await fetchMetricsText("http://remuxer/metrics", 2000, refused)).toBeNull();
    const down = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await fetchMetricsText("http://remuxer/metrics", 2000, down)).toBeNull();
  });

  it("gives up on a process that does not answer within the timeout", async () => {
    const hangs = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await fetchMetricsText("http://scraper/metrics", 20, hangs)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

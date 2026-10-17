import { afterEach, describe, expect, it } from "bun:test";
import { metrics } from "../../src/lib/metrics";
import { __setLinkPacingForTests, isRefusal, linkRefused, linkTurn } from "./link-pacer";

afterEach(() => __setLinkPacingForTests(null));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Milliseconds after `since` at which each of `count` turns on `link` came. */
async function turnTimes(link: string, count: number, since = Date.now()): Promise<number[]> {
  return Promise.all(Array.from({ length: count }, () => linkTurn(link).then(() => Date.now() - since)));
}

describe("linkTurn", () => {
  it("gives a link its burst at once, then turns at its rate", async () => {
    __setLinkPacingForTests({ burst: 3, ratePerS: 20 });
    const times = await turnTimes("https://a.debrid.it/1", 5);
    for (const t of times.slice(0, 3)) expect(t).toBeLessThan(30);
    // One turn every 50 ms once the burst is spent.
    expect(times[3]!).toBeGreaterThanOrEqual(40);
    expect(times[4]!).toBeGreaterThanOrEqual(90);
    expect(times[4]!).toBeLessThan(250);
  });

  it("keeps each link's turns its own", async () => {
    __setLinkPacingForTests({ burst: 2, ratePerS: 1 });
    await turnTimes("https://a.debrid.it/1", 2);
    const [other] = await turnTimes("https://a.debrid.it/2", 1);
    expect(other!).toBeLessThan(30);
  });

  it("gives a link that refused no turn for the pause, then half its rate", async () => {
    __setLinkPacingForTests({ burst: 4, ratePerS: 20, refusalPauseMs: 200, slowForMs: 10_000 });
    const link = "https://a.debrid.it/1";
    const since = Date.now();
    linkRefused(link);
    const times = await turnTimes(link, 4, since);
    // At half the rate (10 a second), two turns build up over the pause.
    expect(times[0]!).toBeGreaterThanOrEqual(190);
    expect(times[1]!).toBeLessThan(times[0]! + 40);
    expect(times[2]!).toBeGreaterThanOrEqual(times[0]! + 70);
    expect(times[3]!).toBeGreaterThanOrEqual(times[0]! + 170);
  });

  it("reports the refusal that starts a pause, and not the ones during it", () => {
    __setLinkPacingForTests({ refusalPauseMs: 1_000 });
    const now = Date.now();
    expect(linkRefused("https://a.debrid.it/1", now)).toBe(true);
    expect(linkRefused("https://a.debrid.it/1", now + 10)).toBe(false);
    expect(linkRefused("https://a.debrid.it/1", now + 1_001)).toBe(true);
  });

  it("gives up a turn nobody wants any more without using it", async () => {
    __setLinkPacingForTests({ burst: 1, ratePerS: 2 });
    const link = "https://a.debrid.it/1";
    await linkTurn(link);
    let wanted = true;
    const dropped = linkTurn(link, () => !wanted);
    const kept = linkTurn(link).then(() => Date.now());
    await sleep(50);
    wanted = false;
    const since = Date.now();
    expect(await dropped).toBe(false);
    // The dropped turn did not use the token due at 500 ms: the next one has it.
    expect((await kept) - since).toBeLessThan(600);
  });
});

describe("which links are paced", () => {
  it("leaves a link on a CDN that has never refused alone, and paces it once its CDN refuses", async () => {
    __setLinkPacingForTests({ burst: 1, ratePerS: 1, refusalPauseMs: 150 });
    const link = "https://syd1-4.download.real-debrid.com/d/a/file.mkv";
    const free = await turnTimes(link, 5);
    for (const t of free) expect(t).toBeLessThan(30);
    const since = Date.now();
    linkRefused("https://syd2-4.download.real-debrid.com/d/b/other.mkv");
    // Another link on the same CDN now waits for its turns too: its burst, then one a second.
    const [first, second] = await turnTimes(link, 2, since);
    expect(first!).toBeLessThan(30);
    expect(second!).toBeGreaterThanOrEqual(900);
  });

  it("paces AllDebrid's links from the start", async () => {
    __setLinkPacingForTests({ burst: 2, ratePerS: 20 });
    const times = await turnTimes("https://x9.debrid.it/dl/a/file.mkv", 3);
    expect(times[2]!).toBeGreaterThanOrEqual(40);
  });
});

describe("isRefusal", () => {
  it("takes AllDebrid's 204, 429 and 503 as refusals, and not a range or a whole file", () => {
    expect(isRefusal(204)).toBe(true);
    expect(isRefusal(429)).toBe(true);
    expect(isRefusal(503)).toBe(true);
    expect(isRefusal(206)).toBe(false);
    expect(isRefusal(200)).toBe(false);
    expect(isRefusal(500)).toBe(false);
    expect(isRefusal(404)).toBe(false);
  });
});

describe("linkTurn's wait metric", () => {
  /** The count of one series in the scrape text, or 0 before it has been written. */
  function waitsCounted(cdn: string): number {
    const series = `ac_proxy_turn_wait_seconds_count{cdn="${cdn}"}`;
    const line = metrics().render().split("\n").find((l) => l.startsWith(`${series} `));
    return line ? Number(line.slice(series.length + 1)) : 0;
  }

  it("times each turn on a paced link, and none on a link that is not paced", async () => {
    __setLinkPacingForTests({ burst: 1, ratePerS: 50 });
    const paced = waitsCounted("debrid.it");
    await linkTurn("https://metrics-pacer.debrid.it/1");
    await linkTurn("https://metrics-pacer.debrid.it/1");
    expect(waitsCounted("debrid.it") - paced).toBe(2);

    const unpaced = waitsCounted("unpaced-pacer.example");
    await linkTurn("https://metrics-pacer.unpaced-pacer.example/1");
    expect(waitsCounted("unpaced-pacer.example")).toBe(unpaced);
  });
});

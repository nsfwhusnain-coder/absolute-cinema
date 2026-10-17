import { describe, expect, it } from "bun:test";
import { metrics } from "../metrics";
import { recordVodOpen, vodOpenOutcome } from "./vod-open";

/** The value of one series in the live metrics text, or 0 while it has not been seen. */
function sample(series: string): number {
  const row = metrics().render().split("\n").find((line) => line.startsWith(`${series} `));
  return row === undefined ? 0 : Number(row.slice(series.length + 1));
}

describe("vodOpenOutcome", () => {
  it("is ok only for a file the remuxer opened and the route answered with", () => {
    expect(vodOpenOutcome({ status: 200, opened: true })).toBe("ok");
    expect(vodOpenOutcome({ status: 503, capacity: true })).toBe("capacity");
  });

  it("is remuxer_unavailable when the remuxer could not be reached", () => {
    expect(vodOpenOutcome({ status: null })).toBe("remuxer_unavailable");
  });

  it("is expired for a source whose link is gone", () => {
    expect(vodOpenOutcome({ status: 409 })).toBe("expired");
  });

  it("is refused for a source that does not play, a length that is not the title's, or one the remuxer will never start", () => {
    expect(vodOpenOutcome({ status: 415 })).toBe("refused");
    expect(vodOpenOutcome({ status: 415, opened: true })).toBe("refused");
    expect(vodOpenOutcome({ status: 500, unusable: true })).toBe("refused");
  });

  it("is error for any other failure, including a 200 that opened nothing", () => {
    expect(vodOpenOutcome({ status: 200 })).toBe("error");
    expect(vodOpenOutcome({ status: 500 })).toBe("error");
    expect(vodOpenOutcome({ status: 502 })).toBe("error");
    expect(vodOpenOutcome({ status: 404 })).toBe("error");
  });
});

describe("recordVodOpen", () => {
  it("counts the open by outcome and prewarm, and times it", () => {
    const counter = 'ac_web_vod_opens_total{outcome="ok",prewarm="true"}';
    const seconds = 'ac_web_vod_open_seconds_count{prewarm="true"}';
    const before = [sample(counter), sample(seconds)];
    recordVodOpen("ok", true, 1.5);
    expect(sample(counter) - before[0]!).toBe(1);
    expect(sample(seconds) - before[1]!).toBe(1);
  });

  it("counts an open with no time (refused or expired before the remuxer was asked) without timing it", () => {
    const counter = 'ac_web_vod_opens_total{outcome="expired",prewarm="false"}';
    const seconds = 'ac_web_vod_open_seconds_count{prewarm="false"}';
    const before = [sample(counter), sample(seconds)];
    recordVodOpen("expired", false);
    expect(sample(counter) - before[0]!).toBe(1);
    expect(sample(seconds) - before[1]!).toBe(0);
  });
});

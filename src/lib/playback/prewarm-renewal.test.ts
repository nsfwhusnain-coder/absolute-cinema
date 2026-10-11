import { describe, expect, it } from "bun:test";
import { PREWARM_RENEWALS_MAX, keepsWarm } from "./prewarm-renewal";

describe("keepsWarm", () => {
  it("renews while the page is on screen, up to the limit", () => {
    expect(keepsWarm(0, false)).toBe(true);
    expect(keepsWarm(PREWARM_RENEWALS_MAX - 1, false)).toBe(true);
    expect(keepsWarm(PREWARM_RENEWALS_MAX, false)).toBe(false);
  });

  it("does not renew for a page nobody is looking at", () => {
    expect(keepsWarm(0, true)).toBe(false);
  });
});

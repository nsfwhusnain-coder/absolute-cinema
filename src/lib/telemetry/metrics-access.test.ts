import { describe, expect, it } from "bun:test";
import { checkMetricsAccess } from "./metrics-access";

const TOKEN = "s3cret-token-value";

describe("checkMetricsAccess", () => {
  it("is disabled while no token is set, or only an empty or blank one", () => {
    expect(checkMetricsAccess(`Bearer ${TOKEN}`, undefined)).toBe("disabled");
    expect(checkMetricsAccess(`Bearer ${TOKEN}`, "")).toBe("disabled");
    expect(checkMetricsAccess(`Bearer ${TOKEN}`, "   ")).toBe("disabled");
    expect(checkMetricsAccess(null, undefined)).toBe("disabled");
  });

  it("allows a request whose bearer token is the token set", () => {
    expect(checkMetricsAccess(`Bearer ${TOKEN}`, TOKEN)).toBe("allowed");
    expect(checkMetricsAccess(`bearer ${TOKEN}`, TOKEN)).toBe("allowed");
    expect(checkMetricsAccess(`Bearer  ${TOKEN}  `, TOKEN)).toBe("allowed");
  });

  it("allows the token when it was set with stray spaces around it", () => {
    expect(checkMetricsAccess(`Bearer ${TOKEN}`, `  ${TOKEN}\n`)).toBe("allowed");
  });

  it("denies a request with no header, another scheme, or the wrong token", () => {
    expect(checkMetricsAccess(null, TOKEN)).toBe("denied");
    expect(checkMetricsAccess("", TOKEN)).toBe("denied");
    expect(checkMetricsAccess(`Basic ${TOKEN}`, TOKEN)).toBe("denied");
    expect(checkMetricsAccess(TOKEN, TOKEN)).toBe("denied");
    expect(checkMetricsAccess("Bearer", TOKEN)).toBe("denied");
    expect(checkMetricsAccess("Bearer wrong-token", TOKEN)).toBe("denied");
  });

  it("denies a token that is only a prefix of the right one, or the right one with more after it", () => {
    expect(checkMetricsAccess(`Bearer ${TOKEN.slice(0, 5)}`, TOKEN)).toBe("denied");
    expect(checkMetricsAccess(`Bearer ${TOKEN}x`, TOKEN)).toBe("denied");
    expect(checkMetricsAccess(`Bearer ${TOKEN} extra`, TOKEN)).toBe("denied");
  });
});

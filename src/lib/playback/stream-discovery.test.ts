/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { streamsDiscovering, type StreamDiscoveryInput } from "./stream-discovery";

const pending: StreamDiscoveryInput = { hasFullData: false, fullStatus: "pending", fullFetching: false, partialWithinWindow: false };

describe("streamsDiscovering", () => {
  it("is true while the full answer has not come yet", () => {
    expect(streamsDiscovering(pending)).toBe(true);
  });

  it("is false once the full answer has failed and there is no partial answer", () => {
    expect(streamsDiscovering({ ...pending, fullStatus: "error" })).toBe(false);
  });

  it("is true while the full answer is being fetched again", () => {
    expect(streamsDiscovering({ ...pending, hasFullData: true, fullStatus: "success", fullFetching: true })).toBe(true);
  });

  it("is true while a partial answer is inside its polling window", () => {
    expect(streamsDiscovering({ ...pending, hasFullData: true, fullStatus: "success", partialWithinWindow: true })).toBe(true);
  });

  it("is false once a complete answer is in and nothing is being fetched", () => {
    expect(streamsDiscovering({ ...pending, hasFullData: true, fullStatus: "success" })).toBe(false);
  });
});

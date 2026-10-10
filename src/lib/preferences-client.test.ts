/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { PreferencesError, fetchPreferences, isSignedOutError } from "./preferences-client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: string): void {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("isSignedOutError", () => {
  it("is true only for a 401 from the preferences request", () => {
    expect(isSignedOutError(new PreferencesError("Unauthorized", 401))).toBe(true);
    expect(isSignedOutError(new PreferencesError("Server error", 500))).toBe(false);
    expect(isSignedOutError(new Error("Failed to fetch"))).toBe(false);
    expect(isSignedOutError(null)).toBe(false);
  });
});

describe("fetchPreferences", () => {
  it("reports the status when the server no longer knows the profile", async () => {
    answer(401, JSON.stringify({ error: "Unauthorized" }));
    const error = await fetchPreferences().catch((e: unknown) => e);
    expect(isSignedOutError(error)).toBe(true);
  });

  it("does not mistake a failing server, or a body that is not JSON, for a dead session", async () => {
    answer(502, "<html>Bad Gateway</html>");
    const error = await fetchPreferences().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreferencesError);
    expect(isSignedOutError(error)).toBe(false);
  });

  it("returns the preferences when the request succeeds", async () => {
    answer(200, JSON.stringify({ seekStep: 10 }));
    expect((await fetchPreferences()).seekStep).toBe(10);
  });
});

/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { timeoutSignal } from "./abort";

describe("timeoutSignal", () => {
  it("aborts after the timeout", async () => {
    const { signal } = timeoutSignal(10);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(true);
  });

  it("follows its parent", () => {
    const parent = new AbortController();
    const { signal, done } = timeoutSignal(10_000, parent.signal);
    parent.abort();
    expect(signal.aborted).toBe(true);
    done();
  });

  it("is already aborted when the parent was", () => {
    const parent = new AbortController();
    parent.abort();
    expect(timeoutSignal(10_000, parent.signal).signal.aborted).toBe(true);
  });

  it("does not fire after done()", async () => {
    const { signal, done } = timeoutSignal(10);
    done();
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(false);
  });
});

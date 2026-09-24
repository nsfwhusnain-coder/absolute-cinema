/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  hlsWorkerSupportedHere,
  resetHlsWorkerSupportCache,
} from "./player-engine";

describe("hlsWorkerSupportedHere", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const realWorker = globals.Worker;
  const realBlob = globals.Blob;
  const realURL = globals.URL;

  class ConstructibleWorker {
    constructor(_scriptUrl: string | URL) {}
    terminate(): void {}
  }

  class ThrowingWorker {
    constructor(_scriptUrl: string | URL) {
      throw new Error("worker construct blocked");
    }
    terminate(): void {}
  }

  afterEach(() => {
    globals.Worker = realWorker;
    globals.Blob = realBlob;
    globals.URL = realURL;
    resetHlsWorkerSupportCache();
  });

  it("returns false when Worker is missing", () => {
    globals.Worker = undefined;
    expect(hlsWorkerSupportedHere()).toBe(false);
  });

  it("returns true when a blob Worker constructs and terminates", () => {
    globals.Worker = ConstructibleWorker;
    expect(hlsWorkerSupportedHere()).toBe(true);
  });

  it("returns false when Worker construct throws", () => {
    globals.Worker = ThrowingWorker;
    expect(hlsWorkerSupportedHere()).toBe(false);
  });

  it("caches the first capability answer", () => {
    let constructed = 0;
    globals.Worker = class {
      constructor(_scriptUrl: string | URL) {
        constructed += 1;
      }
      terminate(): void {}
    };
    expect(hlsWorkerSupportedHere()).toBe(true);
    expect(hlsWorkerSupportedHere()).toBe(true);
    expect(constructed).toBe(1);
  });

  it("does not use navigator.userAgent as a capability signal", () => {
    const previousNavigator = globals.navigator;
    globals.navigator = { userAgent: "CustomFork/1.0 (capability-check-regression)" };
    globals.Worker = ConstructibleWorker;
    try {
      expect(hlsWorkerSupportedHere()).toBe(true);
    } finally {
      globals.navigator = previousNavigator;
    }
  });
});

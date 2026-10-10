/**
 * Abort helpers that work on every browser the app supports. AbortSignal.any
 * (Chrome 116, Safari 17.4) and AbortSignal.timeout (Chrome 103, Safari 16)
 * are missing on older iPads, TV browsers and WebViews, where calling them
 * throws and the request never starts.
 */

/** A signal that aborts after `ms`, and/or when `parent` aborts. Call `done()` to clear the timer. */
export function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  const onParent = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParent, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

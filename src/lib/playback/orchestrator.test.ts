import { describe, expect, it } from "bun:test";
import type { PlaybackSource } from "./types";
import {
  PLAYED_FAIL_COOLDOWN_MS,
  START_FAIL_COOLDOWN_MS,
  initialOrchestratorState,
  onFirstFrame,
  onPlaybackError,
  onRetryAll,
  onRoster,
  onStartFailed,
  onUserSelect,
  type OrchestratorState,
  type Ranker,
} from "./orchestrator";

const src = (id: string): PlaybackSource => ({ id, url: `https://x/${id}`, provider: id, quality: "1080p", label: `${id} • 1080p`, type: "hls" });
const A = src("a"), B = src("b"), C = src("c");
// Ranks by roster order.
const ranker: Ranker = { pick: (c) => c[0] ?? null };
const T0 = 1_000_000;

function playing(on: PlaybackSource, sources = [A, B, C]): OrchestratorState {
  const started = onRoster(initialOrchestratorState, [on, ...sources.filter((s) => s !== on)], false, ranker, T0).state;
  return onFirstFrame(started);
}

describe("orchestrator", () => {
  it("starts on the best source when the roster arrives", () => {
    const { state, command } = onRoster(initialOrchestratorState, [A, B], false, ranker, T0);
    expect(state.phase).toBe("starting");
    expect(command).toEqual({ type: "attach", sourceId: "a", keepPosition: false, refresh: false });
  });

  it("waits while discovery continues and nothing is available", () => {
    expect(onRoster(initialOrchestratorState, [], true, ranker, T0).command.type).toBe("wait");
    expect(onRoster(initialOrchestratorState, [], false, ranker, T0).command.type).toBe("fail");
  });

  it("never switches a playing source when better sources arrive", () => {
    const state = playing(B);
    const { command } = onRoster(state, [A, B, C], true, ranker, T0);
    expect(command.type).toBe("none");
  });

  it("fails over to the next source when one never starts, and cools the failed one", () => {
    const starting = onRoster(initialOrchestratorState, [A, B], false, ranker, T0).state;
    const { state, command } = onStartFailed(starting, [A, B], "timeout", false, ranker, T0);
    expect(command).toMatchObject({ type: "attach", sourceId: "b" });
    expect(state.health.a!.failures).toBe(1);
    // Still cooling down: a fresh roster does not bring it back immediately.
    const retry = onStartFailed({ ...state }, [A, B], "timeout", false, ranker, T0 + 1000);
    expect(retry.command.type).toBe("fail");
    // After the cooldown it is eligible again: never permanently dead.
    const later = onRoster({ ...retry.state }, [A, B], false, ranker, T0 + START_FAIL_COOLDOWN_MS + 1);
    expect(later.command).toMatchObject({ type: "attach", sourceId: "a" });
  });

  it("retries the same source twice at the same position before failing over", () => {
    let state = playing(A);
    const first = onPlaybackError(state, [A, B], "stall", ranker, T0);
    expect(first.command).toEqual({ type: "attach", sourceId: "a", keepPosition: true, refresh: false });
    const second = onPlaybackError(first.state, [A, B], "stall", ranker, T0);
    expect(second.command).toEqual({ type: "attach", sourceId: "a", keepPosition: true, refresh: true });
    const third = onPlaybackError(second.state, [A, B], "stall", ranker, T0);
    expect(third.command).toMatchObject({ type: "attach", sourceId: "b", keepPosition: true });
    expect((third.command as { notice?: string }).notice).toContain("continuing on b");
    state = third.state;
    // The source that played only cools briefly.
    expect(state.health.a!.played).toBe(true);
    const back = onStartFailed(state, [A, B], "timeout", false, ranker, T0 + PLAYED_FAIL_COOLDOWN_MS + 1);
    expect(back.command).toMatchObject({ type: "attach", sourceId: "a" });
  });

  it("a successful recovery resets the retry budget", () => {
    const recovering = onPlaybackError(playing(A), [A, B], "error", ranker, T0).state;
    const recovered = onFirstFrame(recovering);
    expect(recovered.retries).toBe(0);
    expect(onPlaybackError(recovered, [A, B], "error", ranker, T0).command).toMatchObject({ sourceId: "a" });
  });

  it("keeps retrying the only source rather than giving up after it worked", () => {
    let state = playing(A, [A]);
    for (let i = 0; i < 3; i++) state = onPlaybackError(state, [A], "error", ranker, T0).state;
    const again = onPlaybackError(state, [A], "error", ranker, T0);
    expect(again.command).toMatchObject({ type: "attach", sourceId: "a", keepPosition: true });
  });

  it("honours a user pick and explains a fallback if it fails", () => {
    const picked = onUserSelect(playing(A), "c");
    expect(picked.command).toEqual({ type: "attach", sourceId: "c", keepPosition: true, refresh: false });
    const failed = onStartFailed(picked.state, [A, B, C], "timeout", false, ranker, T0);
    expect((failed.command as { notice?: string }).notice).toContain("didn't load");
  });

  it("retry-all clears cooldowns", () => {
    const failed = onStartFailed(onRoster(initialOrchestratorState, [A], false, ranker, T0).state, [A], "x", false, ranker, T0);
    expect(failed.command.type).toBe("fail");
    const reset = onRetryAll(failed.state);
    expect(onRoster(reset, [A], false, ranker, T0).command).toMatchObject({ sourceId: "a" });
  });
});

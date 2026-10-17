import { describe, expect, it } from "bun:test";
import type { PlaybackSource } from "./types";
import {
  LOW_QUALITY_GRACE_MS,
  hasAlternative,
  PLAYED_FAIL_COOLDOWN_MS,
  START_FAIL_COOLDOWN_MS,
  START_WAIT_MS,
  initialOrchestratorState,
  onFirstFrame,
  onPlaybackError,
  onRetryAll,
  onRoster,
  onStartFailed,
  onUserSelect,
  onAwaitRefresh,
  RETRIES_FORGIVEN_AFTER_MS,
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
  describe("start wait for a better source", () => {
    const low: PlaybackSource = { ...src("low"), quality: "480p", label: "low • 480p" };
    const hd: PlaybackSource = { ...src("hd"), quality: "1080p" };
    const picky: Ranker = { pick: (c) => [...c].sort((x, y) => parseInt(y.quality) - parseInt(x.quality))[0] ?? null, targetHeight: 1080 };
    const settled = { fourKSettled: true, debridSettled: true };

    it("waits briefly while only a low-quality source has been found and debrid has settled", () => {
      const { state, command } = onRoster(initialOrchestratorState, [low], true, picky, T0, settled);
      expect(command).toEqual({ type: "wait", recheckInMs: LOW_QUALITY_GRACE_MS });
      expect(state.firstCandidateAt).toBe(T0);
      const later = onRoster(state, [low], true, picky, T0 + 2_000, settled);
      expect(later.command).toEqual({ type: "wait", recheckInMs: LOW_QUALITY_GRACE_MS - 2_000 });
    });

    it("starts the better source if it arrives within the short wait", () => {
      const waiting = onRoster(initialOrchestratorState, [low], true, picky, T0, settled).state;
      expect(onRoster(waiting, [low, hd], true, picky, T0 + 1_000, settled).command).toMatchObject({ type: "attach", sourceId: "hd" });
    });

    it("starts the low-quality source once the short wait runs out or the search ends", () => {
      const waiting = onRoster(initialOrchestratorState, [low], true, picky, T0, settled).state;
      expect(onRoster(waiting, [low], true, picky, T0 + LOW_QUALITY_GRACE_MS, settled).command).toMatchObject({ type: "attach", sourceId: "low" });
      expect(onRoster(waiting, [low], false, picky, T0 + 1, settled).command).toMatchObject({ type: "attach", sourceId: "low" });
    });

    it("waits up to START_WAIT_MS for a low-quality source while debrid may still bring one", () => {
      const { state, command } = onRoster(initialOrchestratorState, [low], true, picky, T0);
      expect(command).toEqual({ type: "wait", recheckInMs: START_WAIT_MS });
      expect(onRoster(state, [low], true, picky, T0 + START_WAIT_MS).command).toMatchObject({ type: "attach", sourceId: "low" });
    });

    it("waits to replace a source the server has seen failing", () => {
      const flaky: Ranker = { ...picky, isSuspect: (s) => s.id === "hd" };
      expect(onRoster(initialOrchestratorState, [hd], true, flaky, T0).command.type).toBe("wait");
      expect(onRoster(initialOrchestratorState, [hd], false, flaky, T0).command).toMatchObject({ type: "attach", sourceId: "hd" });
    });

    it("holds out the full wait for 4K when the viewer wants the best quality", () => {
      const best: Ranker = { ...picky, targetHeight: 2160 };
      expect(onRoster(initialOrchestratorState, [hd], true, best, T0).command).toEqual({ type: "wait", recheckInMs: START_WAIT_MS });
      expect(onRoster(initialOrchestratorState, [hd], false, best, T0).command).toMatchObject({ type: "attach", sourceId: "hd" });
    });

    it("does not wait when the viewer asked for low quality", () => {
      const saver: Ranker = { ...picky, targetHeight: 480 };
      const lowDebrid: PlaybackSource = { ...low, origin: "debrid" };
      expect(onRoster(initialOrchestratorState, [lowDebrid], true, saver, T0).command).toMatchObject({ type: "attach", sourceId: "low" });
      expect(onRoster(initialOrchestratorState, [low], true, saver, T0, settled).command).toMatchObject({ type: "attach", sourceId: "low" });
    });
  });

  describe("what the server says can still arrive", () => {
    const best: Ranker = { pick: (c) => [...c].sort((x, y) => parseInt(y.quality) - parseInt(x.quality))[0] ?? null, targetHeight: 2160 };
    const file: PlaybackSource = { ...src("file"), origin: "debrid" };
    const file4k: PlaybackSource = { ...src("file4k"), quality: "2160p", origin: "debrid" };
    const lowFile: PlaybackSource = { ...src("low-file"), quality: "720p", origin: "debrid" };
    const web: PlaybackSource = { ...src("web"), origin: "embed" };
    const lowWeb: PlaybackSource = { ...web, id: "low-web", quality: "720p" };
    const noFourK = { fourKSettled: true, debridSettled: false };
    const nothingMore = { fourKSettled: true, debridSettled: true };
    const start = (sources: PlaybackSource[], outlook: typeof noFourK, ranker = best) =>
      onRoster(initialOrchestratorState, sources, true, ranker, T0, outlook).command;

    it("starts a 1080p debrid file at once when no 4K can come", () => {
      expect(start([file], noFourK)).toMatchObject({ type: "attach", sourceId: "file" });
    });

    it("still holds a web stream back while debrid files may come", () => {
      expect(start([web], noFourK)).toEqual({ type: "wait", recheckInMs: START_WAIT_MS });
    });

    it("holds a web 1080p stream back while debrid is unsettled, even with 4K settled", () => {
      expect(start([web], { fourKSettled: true, debridSettled: false })).toEqual({ type: "wait", recheckInMs: START_WAIT_MS });
    });

    it("starts the best there is once debrid has nothing more to give", () => {
      expect(start([web], nothingMore)).toMatchObject({ type: "attach", sourceId: "web" });
    });

    it("starts a debrid 4K file at once", () => {
      expect(start([file4k], noFourK)).toMatchObject({ type: "attach", sourceId: "file4k" });
    });

    it("gives the web providers the short wait when only less than 1080p is in hand", () => {
      expect(start([lowWeb], nothingMore)).toEqual({ type: "wait", recheckInMs: LOW_QUALITY_GRACE_MS });
    });

    it("gives a debrid file under 1080p the short wait once debrid has nothing more", () => {
      expect(start([lowFile], nothingMore)).toEqual({ type: "wait", recheckInMs: LOW_QUALITY_GRACE_MS });
    });

    it("waits no longer than the short wait on a doubted source once debrid has nothing more", () => {
      const doubting: Ranker = { ...best, isSuspect: () => true };
      expect(start([file], nothingMore, doubting)).toEqual({ type: "wait", recheckInMs: LOW_QUALITY_GRACE_MS });
    });

    it("waits for a debrid 1080p file while a 4K file may still come", () => {
      expect(onRoster(initialOrchestratorState, [file], true, best, T0).command).toEqual({ type: "wait", recheckInMs: START_WAIT_MS });
    });

    it("counts the wait from the first roster, not from the first source", () => {
      const first = onRoster(initialOrchestratorState, [], true, best, T0);
      expect(first.command).toEqual({ type: "wait" });
      const late = onRoster(first.state, [web], true, best, T0 + 3_000);
      expect(late.command).toEqual({ type: "wait", recheckInMs: START_WAIT_MS - 3_000 });
      expect(onRoster(late.state, [web], true, best, T0 + START_WAIT_MS).command).toMatchObject({ type: "attach", sourceId: "web" });
    });
  });

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

  it("a recovery that holds gives the retries back", () => {
    const recovering = onPlaybackError(playing(A), [A, B], "error", ranker, T0).state;
    const recovered = onFirstFrame(recovering, T0 + 1_000);
    // Steady play for longer than RETRIES_FORGIVEN_AFTER_MS: the next error starts the count again.
    const later = T0 + RETRIES_FORGIVEN_AFTER_MS + 2_000;
    const next = onPlaybackError(recovered, [A, B], "error", ranker, later);
    expect(next.command).toMatchObject({ sourceId: "a" });
    expect(next.state.retries).toBe(1);
  });

  it("a source that fails again straight after each recovery is left for another", () => {
    // Shows a frame, fails a second later, recovers, shows a frame, fails: a file the device cannot decode steadily.
    let state = playing(A);
    let now = T0;
    const commands: string[] = [];
    for (let round = 0; round < 3; round++) {
      now += 2_000;
      const failed = onPlaybackError(state, [A, B], "media:3", ranker, now);
      commands.push((failed.command as { sourceId?: string }).sourceId ?? failed.command.type);
      if (failed.state.activeId !== "a") break;
      state = onFirstFrame(failed.state, now + 500);
    }
    expect(commands).toEqual(["a", "a", "b"]);
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

  it("upgrades once to a higher resolution that arrives before the first frame", () => {
    const hd = { ...src("hd"), maxHeight: 1080, origin: "debrid" as const };
    const uhd = { ...src("uhd"), maxHeight: 2160, origin: "debrid" as const };
    const starting = onRoster(initialOrchestratorState, [hd], true, ranker, T0).state;
    const byHeight: Ranker = { pick: (c) => [...c].sort((a, b) => (b.maxHeight ?? 0) - (a.maxHeight ?? 0))[0] ?? null };
    const upgraded = onRoster(starting, [hd, uhd], true, byHeight, T0);
    expect(upgraded.command).toMatchObject({ type: "attach", sourceId: "uhd" });
    // Not twice, and never once playing.
    const again = onRoster(upgraded.state, [hd, uhd, { ...src("x"), maxHeight: 4320 }], true, byHeight, T0);
    expect(again.command.type).toBe("none");
    const playingState = onFirstFrame(starting);
    expect(onRoster(playingState, [hd, uhd], true, byHeight, T0).command.type).toBe("none");
  });

  it("can wait for a refreshed roster instead of failing, keeping cooldowns", () => {
    const failed = onStartFailed(onRoster(initialOrchestratorState, [A], false, ranker, T0).state, [A], "x", false, ranker, T0);
    const waiting = onAwaitRefresh(failed.state);
    expect(waiting.phase).toBe("resolving");
    expect(onRoster(waiting, [A, B], false, ranker, T0).command).toMatchObject({ sourceId: "b" });
  });

  it("moves straight to another server when the current one stalls", () => {
    const stalled = onPlaybackError(playing(A), [A, B], "stall", ranker, T0, "stall");
    expect(stalled.command).toMatchObject({ type: "attach", sourceId: "b", keepPosition: true });
    expect((stalled.command as { notice?: string }).notice).toContain("too slow");
  });

  it("retries a stalled server when it is the only one", () => {
    const stalled = onPlaybackError(playing(A, [A]), [A], "stall", ranker, T0, "stall");
    expect(stalled.command).toMatchObject({ type: "attach", sourceId: "a", keepPosition: true });
  });
});

describe("hasAlternative", () => {
  it("is true while another source could take over, and false once the rest have failed", () => {
    const starting = onRoster(initialOrchestratorState, [A, B], false, ranker, T0).state;
    expect(starting.activeId).toBe("a");
    expect(hasAlternative(starting, [A, B], ranker, T0)).toBe(true);
    expect(hasAlternative(starting, [A], ranker, T0)).toBe(false);
    // B started and failed a moment ago: it is cooling down, so A has nothing to hand over to.
    const afterB = onStartFailed({ ...starting, activeId: "b" }, [A, B], "timeout", false, ranker, T0).state;
    expect(hasAlternative({ ...afterB, activeId: "a" }, [A, B], ranker, T0 + 1000)).toBe(false);
    expect(hasAlternative({ ...afterB, activeId: "a" }, [A, B], ranker, T0 + START_FAIL_COOLDOWN_MS + 1)).toBe(true);
  });
});

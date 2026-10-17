/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { captionKey, cuesToAdd, latestCueEnd, mirrorMode, needsReadAhead, refreshDelaysAfterJump } from "./cue-sync";

const cue = (start: number, end: number, text: string) => ({ start, end, text });

describe("captionKey", () => {
  it("compares starts to the millisecond, as the remuxer does", () => {
    expect(captionKey(cue(1.0004, 2, "A"))).toBe(captionKey(cue(1.0001, 3, "A")));
    expect(captionKey(cue(1, 2, "A"))).not.toBe(captionKey(cue(1.001, 2, "A")));
  });
});

describe("cuesToAdd", () => {
  it("adds only the cues the track does not hold yet", () => {
    expect(cuesToAdd([cue(1, 2, "A")], [cue(1, 2, "A"), cue(3, 4, "B")])).toEqual([cue(3, 4, "B")]);
  });

  it("counts identical start and text as one caption, even when listed twice", () => {
    expect(cuesToAdd([cue(1, 2, "A")], [cue(1, 2.5, "A")])).toEqual([]);
    expect(cuesToAdd([], [cue(5, 6, "Hi"), cue(5, 7, "Hi")])).toEqual([cue(5, 6, "Hi")]);
  });

  it("keeps cues that share a start or a text but not both", () => {
    const wanted = [cue(5, 6, "Hi"), cue(5, 6, "Bye"), cue(9, 10, "Hi")];
    expect(cuesToAdd([], wanted)).toEqual(wanted);
  });

  it("fills an empty track with every caption once, for a new selection", () => {
    expect(cuesToAdd([], [cue(1, 2, "A"), cue(3, 4, "B"), cue(3, 4, "B")])).toEqual([cue(1, 2, "A"), cue(3, 4, "B")]);
  });
});

describe("mirrorMode", () => {
  it("is disabled when subtitles are off, wherever the video is", () => {
    expect(mirrorMode({ selected: false, nativeFullscreen: false, pip: false })).toBe("disabled");
    expect(mirrorMode({ selected: false, nativeFullscreen: true, pip: true })).toBe("disabled");
  });

  it("is hidden in a window, where the overlay draws the captions", () => {
    expect(mirrorMode({ selected: true, nativeFullscreen: false, pip: false })).toBe("hidden");
  });

  it("is showing in the platform's fullscreen or picture-in-picture", () => {
    expect(mirrorMode({ selected: true, nativeFullscreen: true, pip: false })).toBe("showing");
    expect(mirrorMode({ selected: true, nativeFullscreen: false, pip: true })).toBe("showing");
  });
});

describe("refreshDelaysAfterJump", () => {
  it("reads again at 1.5, 4 and 8 seconds after a jump", () => {
    expect(refreshDelaysAfterJump()).toEqual([1500, 4000, 8000]);
  });
});

describe("latestCueEnd", () => {
  it("is the furthest end, whatever the order of the cues", () => {
    expect(latestCueEnd([cue(10, 12, "B"), cue(1, 50, "A"), cue(20, 22, "C")])).toBe(50);
  });

  it("is null with no cues", () => {
    expect(latestCueEnd([])).toBeNull();
  });
});

describe("needsReadAhead", () => {
  const playing = { time: 100, lastCueEnd: 105, duration: 3600, now: 60_000, lastReadAt: 0 };

  it("reads when the playhead is within 10 seconds of the newest cue, either side", () => {
    expect(needsReadAhead(playing)).toBe(true);
    expect(needsReadAhead({ ...playing, time: 95 })).toBe(true);
    expect(needsReadAhead({ ...playing, time: 115 })).toBe(true);
  });

  it("waits while the playhead is further away", () => {
    expect(needsReadAhead({ ...playing, time: 80 })).toBe(false);
    expect(needsReadAhead({ ...playing, time: 116 })).toBe(false);
  });

  it("reads at most once per 3 seconds", () => {
    expect(needsReadAhead({ ...playing, now: 2_999 })).toBe(false);
    expect(needsReadAhead({ ...playing, now: 3_000 })).toBe(true);
  });

  it("does not read once the newest cue reaches the end of the film", () => {
    expect(needsReadAhead({ ...playing, time: 3590, lastCueEnd: 3595 })).toBe(false);
  });

  it("needs cues to be near", () => {
    expect(needsReadAhead({ ...playing, lastCueEnd: null })).toBe(false);
  });

  it("still reads while the duration is not known", () => {
    expect(needsReadAhead({ ...playing, duration: Number.NaN })).toBe(true);
  });
});

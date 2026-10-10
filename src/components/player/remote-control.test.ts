/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { CHROME_SELECTOR, MENU_SELECTOR, focusZone, remoteIntent, type RemoteContext } from "./remote-control";

const watching: RemoteContext = {
  focus: "none",
  panelOpen: false,
  panelHasParent: false,
  started: true,
  playing: true,
  controlsShown: false,
};
const at = (changes: Partial<RemoteContext>): RemoteContext => ({ ...watching, ...changes });

describe("with nothing focused, the picture has the remote", () => {
  it("pauses on OK and seeks on Left and Right", () => {
    expect(remoteIntent("ok", watching)).toEqual({ type: "togglePlay" });
    expect(remoteIntent("left", watching)).toEqual({ type: "seek", direction: -1 });
    expect(remoteIntent("right", watching)).toEqual({ type: "seek", direction: 1 });
  });

  it("brings the controls up on Up or Down", () => {
    expect(remoteIntent("up", watching)).toEqual({ type: "focusControls" });
    expect(remoteIntent("down", watching)).toEqual({ type: "focusControls" });
  });

  it("does nothing with play, pause and seek before there is a picture", () => {
    const loading = at({ started: false, playing: false });
    expect(remoteIntent("ok", loading)).toEqual({ type: "nothing" });
    expect(remoteIntent("right", loading)).toEqual({ type: "nothing" });
    expect(remoteIntent("playPause", loading)).toEqual({ type: "nothing" });
    expect(remoteIntent("up", loading)).toEqual({ type: "focusControls" });
  });
});

describe("with a control focused, the D-pad moves and OK presses", () => {
  it("leaves OK to a focused button, menu row or prompt", () => {
    for (const focus of ["control", "menu", "overlay"] as const) {
      expect(remoteIntent("ok", at({ focus }))).toEqual({ type: "native" });
    }
  });

  it("keeps seeking on the seek bar, and moves off it up and down", () => {
    const seek = at({ focus: "seek", controlsShown: true });
    expect(remoteIntent("right", seek)).toEqual({ type: "seek", direction: 1 });
    expect(remoteIntent("ok", seek)).toEqual({ type: "togglePlay" });
    expect(remoteIntent("down", seek)).toEqual({ type: "move", direction: "down", fallback: "nothing" });
  });

  it("moves between buttons without ever seeking off the end of a row", () => {
    expect(remoteIntent("left", at({ focus: "control" }))).toEqual({ type: "move", direction: "left", fallback: "nothing" });
  });

  it("treats the edge of a prompt as the picture: seek sideways, controls up and down", () => {
    const prompt = at({ focus: "overlay" });
    expect(remoteIntent("left", prompt)).toEqual({ type: "move", direction: "left", fallback: "seek" });
    expect(remoteIntent("down", prompt)).toEqual({ type: "move", direction: "down", fallback: "focusControls" });
  });

  it("steps back to Settings with Left from a submenu, and nowhere from a top menu", () => {
    const submenu = at({ focus: "menu", panelOpen: true, panelHasParent: true });
    expect(remoteIntent("left", submenu)).toEqual({ type: "move", direction: "left", fallback: "parentPanel" });
    expect(remoteIntent("right", submenu)).toEqual({ type: "move", direction: "right", fallback: "nothing" });
    const top = at({ focus: "menu", panelOpen: true });
    expect(remoteIntent("left", top)).toEqual({ type: "move", direction: "left", fallback: "nothing" });
  });
});

describe("Back undoes one layer at a time", () => {
  it("goes submenu, menu, controls, then out", () => {
    expect(remoteIntent("back", at({ panelOpen: true, panelHasParent: true, controlsShown: true }))).toEqual({ type: "parentPanel" });
    expect(remoteIntent("back", at({ panelOpen: true, controlsShown: true }))).toEqual({ type: "closePanel" });
    expect(remoteIntent("back", at({ controlsShown: true }))).toEqual({ type: "hideControls" });
    expect(remoteIntent("back", watching)).toEqual({ type: "leave" });
  });

  it("leaves straight away when paused or still loading, where the controls cannot hide", () => {
    expect(remoteIntent("back", at({ playing: false, controlsShown: true }))).toEqual({ type: "leave" });
    expect(remoteIntent("back", at({ started: false, playing: false, controlsShown: true }))).toEqual({ type: "leave" });
  });
});

describe("media and colour buttons", () => {
  it("maps the transport buttons", () => {
    expect(remoteIntent("play", watching)).toEqual({ type: "play" });
    expect(remoteIntent("pause", watching)).toEqual({ type: "pause" });
    expect(remoteIntent("playPause", watching)).toEqual({ type: "togglePlay" });
    expect(remoteIntent("fastForward", watching)).toEqual({ type: "seek", direction: 1 });
    expect(remoteIntent("rewind", watching)).toEqual({ type: "seek", direction: -1 });
    expect(remoteIntent("next", watching)).toEqual({ type: "nextEpisode" });
    expect(remoteIntent("previous", watching)).toEqual({ type: "restart" });
    expect(remoteIntent("stop", watching)).toEqual({ type: "leave" });
    expect(remoteIntent("info", watching)).toEqual({ type: "showControls" });
  });

  it("opens a menu from each colour button", () => {
    expect(remoteIntent("red", watching)).toEqual({ type: "openPanel", panel: "subtitles" });
    expect(remoteIntent("green", watching)).toEqual({ type: "openPanel", panel: "audio" });
    expect(remoteIntent("yellow", watching)).toEqual({ type: "openPanel", panel: "episodes" });
    expect(remoteIntent("blue", watching)).toEqual({ type: "openPanel", panel: "settings" });
  });
});

describe("focusZone", () => {
  const element = (ancestors: string[], self: string[] = []) => ({
    closest: (selector: string) => (ancestors.includes(selector) ? {} : null),
    matches: (selector: string) => self.includes(selector),
  });

  it("is none when focus is nowhere or outside the player", () => {
    expect(focusZone(null, false)).toBe("none");
    expect(focusZone(element([CHROME_SELECTOR]), false)).toBe("none");
  });

  it("tells the seek bar from the buttons around it", () => {
    expect(focusZone(element([CHROME_SELECTOR], ['[role="slider"]']), true)).toBe("seek");
    expect(focusZone(element([CHROME_SELECTOR]), true)).toBe("control");
  });

  it("puts menu rows in the menu, and everything else over the picture", () => {
    expect(focusZone(element([MENU_SELECTOR]), true)).toBe("menu");
    expect(focusZone(element([]), true)).toBe("overlay");
  });
});

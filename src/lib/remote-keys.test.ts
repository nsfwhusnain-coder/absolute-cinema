/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { caretKeepsKey, isRemoteDirection, remoteKey } from "./remote-keys";

const key = (name: string, keyCode = 0) => ({ key: name, keyCode });

describe("remoteKey", () => {
  it("reads Back from every set's own code", () => {
    expect(remoteKey(key("Unidentified", 461))).toBe("back"); // LG webOS
    expect(remoteKey(key("Unidentified", 10009))).toBe("back"); // Samsung Tizen
    expect(remoteKey(key("GoBack"))).toBe("back");
    expect(remoteKey(key("BrowserBack", 166))).toBe("back");
  });

  it("treats Backspace as Back only when asked to (Hisense), never by default", () => {
    expect(remoteKey(key("Backspace", 8))).toBeNull();
    expect(remoteKey(key("Backspace", 8), true)).toBe("back");
    expect(remoteKey(key("Unidentified", 8), true)).toBe("back");
  });

  it("leaves Escape alone: it closes dialogs and must not navigate", () => {
    expect(remoteKey(key("Escape", 27), true)).toBeNull();
  });

  it("reads the D-pad and OK", () => {
    expect(remoteKey(key("ArrowLeft", 37))).toBe("left");
    expect(remoteKey(key("Unidentified", 39))).toBe("right");
    expect(remoteKey(key("ArrowUp", 38))).toBe("up");
    expect(remoteKey(key("ArrowDown", 40))).toBe("down");
    expect(remoteKey(key("Enter", 13))).toBe("ok");
  });

  it("reads media buttons by code and by name", () => {
    expect(remoteKey(key("Unidentified", 415))).toBe("play");
    expect(remoteKey(key("Unidentified", 19))).toBe("pause");
    expect(remoteKey(key("Unidentified", 10252))).toBe("playPause");
    expect(remoteKey(key("MediaPlayPause", 179))).toBe("playPause");
    expect(remoteKey(key("Unidentified", 413))).toBe("stop");
    expect(remoteKey(key("Unidentified", 417))).toBe("fastForward");
    expect(remoteKey(key("MediaRewind", 412))).toBe("rewind");
    expect(remoteKey(key("MediaTrackNext", 176))).toBe("next");
    expect(remoteKey(key("Unidentified", 10232))).toBe("previous");
  });

  it("reads the colour buttons", () => {
    expect([403, 404, 405, 406].map((code) => remoteKey(key("Unidentified", code)))).toEqual(["red", "green", "yellow", "blue"]);
  });

  it("returns null for ordinary keys", () => {
    expect(remoteKey(key("a", 65))).toBeNull();
    expect(remoteKey(key(" ", 32))).toBeNull();
  });
});

describe("isRemoteDirection", () => {
  it("is true for the four arrows only", () => {
    expect(isRemoteDirection("left")).toBe(true);
    expect(isRemoteDirection("down")).toBe(true);
    expect(isRemoteDirection("ok")).toBe(false);
    expect(isRemoteDirection(null)).toBe(false);
  });
});

describe("caretKeepsKey", () => {
  const field = (value: string, at: number | null) => ({ value, selectionStart: at, selectionEnd: at });

  it("keeps Left and Right while there is text on that side of the caret", () => {
    expect(caretKeepsKey(field("dune", 2), "left")).toBe(true);
    expect(caretKeepsKey(field("dune", 2), "right")).toBe(true);
    expect(caretKeepsKey(field("dune", 0), "left")).toBe(false);
    expect(caretKeepsKey(field("dune", 4), "right")).toBe(false);
  });

  it("lets every arrow leave an empty field, and Up and Down leave any field", () => {
    expect(caretKeepsKey(field("", 0), "left")).toBe(false);
    expect(caretKeepsKey(field("", 0), "right")).toBe(false);
    expect(caretKeepsKey(field("dune", 2), "up")).toBe(false);
    expect(caretKeepsKey(field("dune", 2), "down")).toBe(false);
  });

  it("holds the arrows in a field that reports no caret until it is empty", () => {
    expect(caretKeepsKey(field("42", null), "left")).toBe(true);
    expect(caretKeepsKey(field("", null), "left")).toBe(false);
  });
});

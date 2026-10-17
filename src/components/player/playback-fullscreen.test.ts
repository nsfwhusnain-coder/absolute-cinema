/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { wantsPlaybackFullscreen, type PlaybackFullscreenContext } from "./playback-fullscreen";

const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const IPAD_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1";
const IPOD_TOUCH = "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1";

const desktop: PlaybackFullscreenContext = { userAgent: DESKTOP_CHROME, tv: false, alreadyFullscreen: false, apiAvailable: true };
const at = (changes: Partial<PlaybackFullscreenContext>): PlaybackFullscreenContext => ({ ...desktop, ...changes });

describe("starting playback takes the page full screen", () => {
  it("on a desktop browser", () => {
    expect(wantsPlaybackFullscreen(desktop)).toBe(true);
  });

  it("on an iPad, which reports itself as a Mac", () => {
    expect(wantsPlaybackFullscreen(at({ userAgent: IPAD_SAFARI }))).toBe(true);
  });

  it("on an Android phone", () => {
    expect(wantsPlaybackFullscreen(at({ userAgent: ANDROID_CHROME }))).toBe(true);
  });
});

describe("it is left alone where the platform takes over or the page already fills the screen", () => {
  it("not on an iPhone or iPod, in any browser", () => {
    expect(wantsPlaybackFullscreen(at({ userAgent: IPHONE_SAFARI }))).toBe(false);
    expect(wantsPlaybackFullscreen(at({ userAgent: IPHONE_CHROME }))).toBe(false);
    expect(wantsPlaybackFullscreen(at({ userAgent: IPOD_TOUCH }))).toBe(false);
  });

  it("not on a television", () => {
    expect(wantsPlaybackFullscreen(at({ tv: true }))).toBe(false);
  });

  it("not when something is full screen already", () => {
    expect(wantsPlaybackFullscreen(at({ alreadyFullscreen: true }))).toBe(false);
  });

  it("not where the engine has no Fullscreen API", () => {
    expect(wantsPlaybackFullscreen(at({ apiAvailable: false }))).toBe(false);
  });
});

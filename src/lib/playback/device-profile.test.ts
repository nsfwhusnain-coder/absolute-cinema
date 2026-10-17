import { describe, expect, it } from "bun:test";
import {
  bufferProfileFor,
  deviceClassFromUserAgent,
  mediaPlatformFor,
  uaPlatformToken,
} from "./device-profile";

const LG_C5 =
  "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/108.0.5359.128 Safari/537.36 WebAppManager";
const SAMSUNG =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/7.0 TV Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("deviceClassFromUserAgent", () => {
  it("classifies the LG C5 webOS browser as a TV", () => {
    // webOS spells itself "Web0S" with a zero on several firmware generations.
    expect(deviceClassFromUserAgent(LG_C5)).toBe("tv");
  });

  it("classifies Tizen as a TV", () => {
    expect(deviceClassFromUserAgent(SAMSUNG)).toBe("tv");
  });

  it("leaves desktop Chrome on the desktop profile", () => {
    expect(deviceClassFromUserAgent(DESKTOP_CHROME)).toBe("desktop");
  });

  it("does not mistake a phone for a TV", () => {
    expect(deviceClassFromUserAgent(IPHONE)).toBe("desktop");
  });

  it("falls back to desktop for an unrecognised agent", () => {
    // Unknown UAs must keep the behaviour that shipped before this existed.
    expect(deviceClassFromUserAgent("")).toBe("desktop");
    expect(deviceClassFromUserAgent("something/1.0")).toBe("desktop");
  });
});

const HISENSE_VIDAA =
  "Mozilla/5.0 (Linux; U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.146 " +
  "Safari/537.36 VIDAA/6.0";
const HISENSE_PANEL =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/91.0.4472.114 Safari/537.36 Hisense";
const HISENSE_PHONE =
  "Mozilla/5.0 (Linux; Android 12; Hisense H50) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36";

describe("uaPlatformToken", () => {
  it("labels VIDAA / Hisense panels instead of chrome", () => {
    expect(uaPlatformToken(HISENSE_VIDAA)).toBe("vidaa");
    expect(uaPlatformToken(HISENSE_PANEL)).toBe("hisense");
  });

  it("does not label a Hisense phone as a panel", () => {
    expect(uaPlatformToken(HISENSE_PHONE)).toBe("chrome");
  });

  it("still labels desktop Chrome as chrome", () => {
    expect(uaPlatformToken(DESKTOP_CHROME)).toBe("chrome");
  });
});

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";
const EDGE_WINDOWS = `${CHROME_WINDOWS} Edg/131.0.0.0`;
const OPERA_WINDOWS = `${CHROME_WINDOWS} OPR/116.0.0.0`;
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";
const EDGE_MAC = `${CHROME_MAC} Edg/131.0.0.0`;
const OPERA_MAC = `${CHROME_MAC} OPR/116.0.0.0`;
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/18.1 Safari/605.1.15";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Mobile Safari/537.36";
const SHIELD_ANDROID_TV =
  "Mozilla/5.0 (Linux; Android 11; SHIELD Android TV Build/RQ1A.210105.003) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CHROMECAST_GOOGLE_TV =
  "Mozilla/5.0 (Linux; Android 12; Chromecast Build/STTE.240206.002) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FIRE_TV_STICK =
  "Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7233) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36";

/** A browser with no touch screen, as a desktop reports it. */
const classify = (userAgent: string, maxTouchPoints = 0) => mediaPlatformFor({ userAgent, maxTouchPoints, tv: false });

describe("mediaPlatformFor", () => {
  it("places Chrome, Edge and Opera in the Chromium budget", () => {
    expect(classify(CHROME_WINDOWS)).toBe("chromium");
    expect(classify(CHROME_MAC)).toBe("chromium");
    expect(classify(EDGE_WINDOWS)).toBe("chromium");
    expect(classify(OPERA_WINDOWS)).toBe("chromium");
    expect(classify(EDGE_MAC)).toBe("chromium");
    expect(classify(OPERA_MAC)).toBe("chromium");
  });

  it("places Firefox in its own budget", () => {
    expect(classify(FIREFOX_WINDOWS)).toBe("firefox");
    expect(classify(FIREFOX_MAC)).toBe("firefox");
  });

  it("places macOS Safari in the Safari budget, while Chrome's Safari token stays Chromium", () => {
    expect(classify(SAFARI_MAC)).toBe("safari");
    expect(classify(CHROME_MAC)).toBe("chromium");
  });

  it("places an iPhone in the iOS budget", () => {
    expect(classify(IPHONE_SAFARI)).toBe("ios");
  });

  it("places an iPad in the iOS budget, though it reports a Mac and a touch screen", () => {
    expect(classify(SAFARI_MAC, 5)).toBe("ios");
    // A real Mac has no touch points, so the same agent with none is still Safari.
    expect(classify(SAFARI_MAC, 0)).toBe("safari");
  });

  it("places Android Chrome in the Android budget", () => {
    expect(classify(ANDROID_CHROME)).toBe("android");
  });

  it("places the living-room browsers in the TV budget", () => {
    expect(classify(LG_C5)).toBe("tv");
    expect(classify(SAMSUNG)).toBe("tv");
    expect(classify(SHIELD_ANDROID_TV)).toBe("tv");
    expect(classify(CHROMECAST_GOOGLE_TV)).toBe("tv");
    expect(classify(FIRE_TV_STICK)).toBe("tv");
  });

  it("gives any browser the TV budget when the TV decision says so", () => {
    // A panel that reports plain desktop Chrome is caught by its input profile or heap limit.
    expect(mediaPlatformFor({ userAgent: CHROME_WINDOWS, maxTouchPoints: 0, tv: true })).toBe("tv");
  });

  it("falls back to the Chromium budget for an agent it does not recognise", () => {
    expect(classify("")).toBe("chromium");
    expect(classify("something/1.0")).toBe("chromium");
  });
});

describe("bufferProfileFor", () => {
  it("gives Chromium the desktop budget", () => {
    expect(bufferProfileFor("chromium")).toEqual({
      forwardBytes: 90_000_000,
      backBytes: 20_000_000,
      forwardMaxS: 120,
      backMaxS: 30,
      fallbackForwardS: 30,
      fallbackBackS: 10,
      abrInitialEstimateBps: 10_000_000,
    });
  });

  it("keeps each desktop budget under the cap of its browser", () => {
    // Chrome refuses appends at about 150 MB, Firefox at about 100 MB, and Safari evicts at about 290 MB.
    expect(bufferProfileFor("chromium").forwardBytes).toBeLessThan(150_000_000);
    expect(bufferProfileFor("firefox").forwardBytes).toBeLessThan(100_000_000);
    expect(bufferProfileFor("safari").forwardBytes).toBeLessThan(290_000_000);
  });

  it("gives the TV the smallest budget in every dimension", () => {
    const tv = bufferProfileFor("tv");
    for (const platform of ["chromium", "firefox", "safari", "ios", "android"] as const) {
      const other = bufferProfileFor(platform);
      expect(tv.forwardBytes).toBeLessThan(other.forwardBytes);
      expect(tv.backBytes).toBeLessThan(other.backBytes);
      expect(tv.forwardMaxS).toBeLessThan(other.forwardMaxS);
      expect(tv.backMaxS).toBeLessThan(other.backMaxS);
    }
  });

  it("still holds several 4K HEVC fragments on a TV", () => {
    // A 4K HEVC fragment is 4 to 8 MB.
    expect(bufferProfileFor("tv").forwardBytes).toBeGreaterThanOrEqual(5 * 8_000_000);
  });

  it("opens ABR high enough on a TV that 4K is eligible", () => {
    expect(bufferProfileFor("tv").abrInitialEstimateBps).toBeGreaterThanOrEqual(10_000_000);
  });

  it("starts a TV with at least 10 s ahead, enough to ride out a proxy hiccup", () => {
    // Too small and every double-hop stall becomes a rebuffer.
    expect(bufferProfileFor("tv").fallbackForwardS).toBeGreaterThanOrEqual(10);
  });
});

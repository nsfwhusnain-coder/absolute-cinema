import { isTvLikeDevice } from "@/lib/tv-detect";

/**
 * iPhone and iPod Safari have no Fullscreen API for a page, only for the
 * video: asking for it there hands the video to the system player and takes
 * the custom controls and subtitles with it. iPad reports itself as a Mac, so
 * it is not matched and gets the page full screen like a desktop.
 */
const IPHONE_USER_AGENT = /iphone|ipod/i;

export interface PlaybackFullscreenContext {
  userAgent: string;
  /** A television, whose page already fills the screen. */
  tv: boolean;
  /** Something is full screen already, so there is nothing to ask for. */
  alreadyFullscreen: boolean;
  /** The engine offers the Fullscreen API on the page's root element. */
  apiAvailable: boolean;
}

/** Whether starting playback should take the page full screen. Pure, so the device rules are tested without a browser. */
export function wantsPlaybackFullscreen(context: PlaybackFullscreenContext): boolean {
  if (context.tv || context.alreadyFullscreen || !context.apiAvailable) return false;
  return !IPHONE_USER_AGENT.test(context.userAgent);
}

/**
 * Takes the whole page full screen as the viewer presses play on a title.
 *
 * Call it synchronously inside the click handler that starts playback: a
 * browser grants this request only during a user gesture. The watch page is
 * reached by client-side navigation, so the document, and full screen with
 * it, carries over, and the player reads it as already full screen. Only a
 * play press asks: an episode changing on the watch page does not, so a viewer
 * who left full screen is not pulled back into it.
 */
export function enterPlaybackFullscreen(): void {
  const root = document.documentElement;
  const wanted = wantsPlaybackFullscreen({
    userAgent: navigator.userAgent || "",
    tv: isTvLikeDevice(),
    alreadyFullscreen: Boolean(document.fullscreenElement),
    apiAvailable: typeof root.requestFullscreen === "function",
  });
  if (!wanted) return;
  try {
    // Refused without a gesture, or where the page may not go full screen: the page stays as it is.
    void root.requestFullscreen().catch(() => undefined);
  } catch {
    // Some engines return nothing rather than a promise, so the chained catch throws instead.
  }
}

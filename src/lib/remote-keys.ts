/**
 * What a key press means on a television remote.
 *
 * Remotes do not agree on how they report a button. LG webOS sends Back as
 * keyCode 461, Samsung Tizen as 10009, Hisense VIDAA as Backspace (8), and
 * Android-based sets as a named key. Media buttons come as the old CE-HTML
 * codes (415 play, 19 pause, 417 fast-forward) on some sets and as named keys
 * on others. Everything that listens for a remote goes through `remoteKey`, so
 * each set is taught its codes in one place.
 */

export type RemoteKey =
  | "back"
  | "ok"
  | "left"
  | "right"
  | "up"
  | "down"
  | "play"
  | "pause"
  | "playPause"
  | "stop"
  | "fastForward"
  | "rewind"
  | "next"
  | "previous"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "info";

export type RemoteDirection = "left" | "right" | "up" | "down";

const BACKSPACE_KEY_CODE = 8;

const KEY_NAMES: Record<string, RemoteKey> = {
  GoBack: "back",
  BrowserBack: "back",
  XF86Back: "back",
  Enter: "ok",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  MediaPlay: "play",
  MediaPause: "pause",
  Pause: "pause",
  MediaPlayPause: "playPause",
  MediaStop: "stop",
  MediaFastForward: "fastForward",
  MediaRewind: "rewind",
  MediaTrackNext: "next",
  MediaTrackPrevious: "previous",
  ColorF0Red: "red",
  ColorF1Green: "green",
  ColorF2Yellow: "yellow",
  ColorF3Blue: "blue",
  Info: "info",
};

const KEY_CODES: Record<number, RemoteKey> = {
  461: "back",
  10009: "back",
  166: "back",
  13: "ok",
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  415: "play",
  19: "pause",
  10252: "playPause",
  179: "playPause",
  413: "stop",
  178: "stop",
  417: "fastForward",
  412: "rewind",
  10233: "next",
  176: "next",
  10232: "previous",
  177: "previous",
  403: "red",
  404: "green",
  405: "yellow",
  406: "blue",
  457: "info",
};

const DIRECTIONS: ReadonlySet<RemoteKey> = new Set<RemoteKey>(["left", "right", "up", "down"]);

/**
 * The remote button a key event stands for, or null for any other key.
 *
 * `backspaceIsBack` is for television sessions only: Hisense sets report Back
 * as Backspace, which on a keyboard is a key for deleting text. Callers pass it
 * when the session is a television and the press did not land in a text field.
 */
export function remoteKey(event: Pick<KeyboardEvent, "key" | "keyCode">, backspaceIsBack = false): RemoteKey | null {
  if (backspaceIsBack && (event.keyCode === BACKSPACE_KEY_CODE || event.key === "Backspace")) return "back";
  return KEY_NAMES[event.key] ?? KEY_CODES[event.keyCode] ?? null;
}

export function isRemoteDirection(key: RemoteKey | null): key is RemoteDirection {
  return key !== null && DIRECTIONS.has(key);
}

/** True for an element that takes typed text, where Backspace and the arrows edit instead of navigating. */
export function isTextEntry(element: Element | null): boolean {
  if (!element) return false;
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT") return !NON_TEXT_INPUTS.has((element.getAttribute("type") ?? "text").toLowerCase());
  return (element as HTMLElement).isContentEditable === true;
}

const NON_TEXT_INPUTS: ReadonlySet<string> = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

interface Caret {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

/**
 * Whether Left or Right should move the caret inside a text field rather than
 * move focus away from it: true while there is text on that side of the caret.
 * Up and Down always leave a single-line field.
 */
export function caretKeepsKey(field: Caret, direction: RemoteDirection): boolean {
  if (direction === "up" || direction === "down") return false;
  const { selectionStart, selectionEnd, value } = field;
  // Fields that do not report a caret (email, number): leave only when empty.
  if (selectionStart === null || selectionEnd === null) return value.length > 0;
  return direction === "left" ? selectionStart > 0 || selectionEnd > 0 : selectionEnd < value.length;
}

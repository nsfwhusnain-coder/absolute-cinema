import type { RemoteDirection, RemoteKey } from "@/lib/remote-keys";

/**
 * What each remote button does in the player, decided from where focus sits.
 *
 * The model is the one living-room apps share. With nothing focused the
 * picture has the remote: OK pauses, Left and Right seek, Up or Down bring the
 * controls up with the seek bar focused. Once focus is on a control the D-pad
 * moves between controls and OK presses the focused one. Back undoes one layer
 * at a time: a submenu, the menu, the controls, then the player itself.
 *
 * Kept free of the DOM so the whole map can be tested as a table.
 */

/** Where focus sits when the button is pressed. */
export type RemoteFocus =
  /** Nowhere: the picture has the remote. */
  | "none"
  /** The seek bar. */
  | "seek"
  /** A button in the top bar, the bottom bar or the centre transport. */
  | "control"
  /** A row in an open menu. */
  | "menu"
  /** A prompt over the picture: Skip Intro, Up Next, the failure card, the sleep screen. */
  | "overlay";

/** Menus the colour buttons open directly. */
export type RemotePanel = "subtitles" | "audio" | "episodes" | "settings";

export interface RemoteContext {
  focus: RemoteFocus;
  panelOpen: boolean;
  /** The open menu was reached from Settings, so Back returns there. */
  panelHasParent: boolean;
  /** There is a picture to pause and seek (or one waiting on the viewer to start it). */
  started: boolean;
  playing: boolean;
  controlsShown: boolean;
}

/** What a focus move does when nothing lies in that direction. */
export type MoveFallback = "nothing" | "seek" | "focusControls" | "parentPanel";

export type RemoteIntent =
  /** The focused control takes the press itself (OK on a button). */
  | { type: "native" }
  /** The press is the player's, and does nothing here. */
  | { type: "nothing" }
  | { type: "togglePlay" }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; direction: -1 | 1 }
  | { type: "move"; direction: RemoteDirection; fallback: MoveFallback }
  | { type: "focusControls" }
  | { type: "showControls" }
  | { type: "hideControls" }
  | { type: "parentPanel" }
  | { type: "closePanel" }
  | { type: "openPanel"; panel: RemotePanel }
  | { type: "nextEpisode" }
  | { type: "restart" }
  | { type: "leave" };

const COLOUR_PANELS: Partial<Record<RemoteKey, RemotePanel>> = {
  red: "subtitles",
  green: "audio",
  yellow: "episodes",
  blue: "settings",
};

const NOTHING: RemoteIntent = { type: "nothing" };

function backIntent(ctx: RemoteContext): RemoteIntent {
  if (ctx.panelOpen) return { type: ctx.panelHasParent ? "parentPanel" : "closePanel" };
  if (ctx.started && ctx.playing && ctx.controlsShown) return { type: "hideControls" };
  return { type: "leave" };
}

function okIntent(ctx: RemoteContext): RemoteIntent {
  if (ctx.focus === "control" || ctx.focus === "menu" || ctx.focus === "overlay") return { type: "native" };
  return ctx.started ? { type: "togglePlay" } : NOTHING;
}

function seekIntent(direction: -1 | 1, ctx: RemoteContext): RemoteIntent {
  return ctx.started ? { type: "seek", direction } : NOTHING;
}

function directionIntent(direction: RemoteDirection, ctx: RemoteContext): RemoteIntent {
  const horizontal = direction === "left" || direction === "right";
  const seek = seekIntent(direction === "left" ? -1 : 1, ctx);
  switch (ctx.focus) {
    case "none":
      return horizontal ? seek : { type: "focusControls" };
    case "seek":
      return horizontal ? seek : { type: "move", direction, fallback: "nothing" };
    case "menu":
      return { type: "move", direction, fallback: direction === "left" && ctx.panelHasParent ? "parentPanel" : "nothing" };
    case "overlay":
      // A prompt is alone on the picture: off its edge, the D-pad means what it would with nothing focused.
      return { type: "move", direction, fallback: horizontal ? "seek" : "focusControls" };
    default:
      return { type: "move", direction, fallback: "nothing" };
  }
}

export function remoteIntent(key: RemoteKey, ctx: RemoteContext): RemoteIntent {
  const panel = COLOUR_PANELS[key];
  if (panel) return { type: "openPanel", panel };
  switch (key) {
    case "back":
      return backIntent(ctx);
    case "ok":
      return okIntent(ctx);
    case "left":
    case "right":
    case "up":
    case "down":
      return directionIntent(key, ctx);
    case "play":
      return ctx.started ? { type: "play" } : NOTHING;
    case "pause":
      return ctx.started ? { type: "pause" } : NOTHING;
    case "playPause":
      return ctx.started ? { type: "togglePlay" } : NOTHING;
    case "fastForward":
      return seekIntent(1, ctx);
    case "rewind":
      return seekIntent(-1, ctx);
    case "next":
      return { type: "nextEpisode" };
    case "previous":
      return ctx.started ? { type: "restart" } : NOTHING;
    case "stop":
      return { type: "leave" };
    default:
      return { type: "showControls" };
  }
}

/** Marks the bars that fade with the controls. */
export const CHROME_SELECTOR = '[data-remote-zone="chrome"]';
/** Set on a bar while it is faded out: nothing inside it may take focus. */
export const HIDDEN_SELECTOR = '[data-remote-hidden="true"]';
export const MENU_SELECTOR = ".player-menus";
const SEEK_SELECTOR = '[role="slider"]';

interface Focusable {
  closest(selector: string): unknown;
  matches(selector: string): boolean;
}

/** Which part of the player holds `active`; `inside` is false when focus is elsewhere or nowhere. */
export function focusZone(active: Focusable | null, inside: boolean): RemoteFocus {
  if (!active || !inside) return "none";
  if (active.closest(MENU_SELECTOR)) return "menu";
  if (!active.closest(CHROME_SELECTOR)) return "overlay";
  return active.matches(SEEK_SELECTOR) ? "seek" : "control";
}

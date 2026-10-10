"use client";

import { useEffect, useRef, type RefObject } from "react";
import { isRemoteDirection, isTextEntry, remoteKey, type RemoteDirection } from "@/lib/remote-keys";
import { focusableElements, isTvLikeDevice, spatialTarget, type SpatialDirection } from "@/lib/tv-navigation";
import {
  HIDDEN_SELECTOR,
  MENU_SELECTOR,
  focusZone,
  remoteIntent,
  type MoveFallback,
  type RemoteContext,
  type RemoteFocus,
  type RemoteIntent,
  type RemotePanel,
} from "./remote-control";

/**
 * A held Left or Right acts at most this often: every seek refills the buffer
 * and every focus move measures the page, and a television is slow at both.
 */
const HELD_REPEAT_INTERVAL_MS = 180;

const ARROWS: Record<RemoteDirection, SpatialDirection> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
};

/** Where focus lands when the controls are brought up: the seek bar. */
const HOME_SELECTOR = "[data-remote-home]";
/** A prompt that should hold focus the moment it appears, so OK answers it. */
const PROMPT_SELECTOR = "[data-remote-default]";
const MENU_CURRENT_SELECTOR = '[aria-checked="true"], [aria-current="true"], [data-active="true"]';

export interface PlayerRemoteOptions {
  shellRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Name of the open menu, or "none". Focus follows it. */
  panel: string;
  panelHasParent: boolean;
  started: boolean;
  playing: boolean;
  controlsShown: boolean;
  /** Changes whenever a prompt (Skip Intro, Up Next, a failure) appears or goes. */
  promptKey: string;
  seekStep: number;
  poke(): void;
  hideControls(): void;
  togglePlay(): void;
  seek(time: number): void;
  seekBy(delta: number): void;
  onOpenPanel(panel: RemotePanel): void;
  onParentPanel(): void;
  onClosePanel(): void;
  onNextEpisode?: () => void;
  onBack(): void;
}

/** The player and the cards that sit beside it (Up Next lives in the watch page, next to the player). */
function scopeOf(shell: HTMLElement): HTMLElement {
  return shell.parentElement ?? shell;
}

function activeIn(scope: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body && scope.contains(active) ? active : null;
}

function zoneIn(scope: HTMLElement): RemoteFocus {
  const active = activeIn(scope);
  return focusZone(active, active !== null);
}

const onOffer = (element: HTMLElement): boolean => !element.closest(HIDDEN_SELECTOR);

function focusElement(element: HTMLElement | null | undefined): boolean {
  if (!element) return false;
  element.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return true;
}

/** The current choice in the open menu, or its first row. */
function focusMenu(scope: HTMLElement): boolean {
  const menu = scope.querySelector<HTMLElement>(MENU_SELECTOR);
  if (!menu) return false;
  return focusElement(menu.querySelector<HTMLElement>(MENU_CURRENT_SELECTOR) ?? focusableElements(menu)[0]);
}

/** Brings focus to the controls: the open menu, else the seek bar, else whatever is showing (Back, while loading). */
function focusControls(scope: HTMLElement, started: boolean): void {
  if (focusMenu(scope)) return;
  const home = started ? scope.querySelector<HTMLElement>(HOME_SELECTOR) : null;
  focusElement(home ?? focusableElements(scope).find(onOffer));
}

function focusPrompt(scope: HTMLElement): void {
  const marked = scope.querySelector<HTMLElement>(PROMPT_SELECTOR);
  if (!marked) return;
  focusElement(marked.matches("button, a[href]") ? marked : marked.querySelector<HTMLElement>("button, a[href]"));
}

function moveFocus(scope: HTMLElement, direction: RemoteDirection): boolean {
  const current = activeIn(scope);
  if (!current) return false;
  const root = current.closest<HTMLElement>(MENU_SELECTOR) ?? scope;
  return focusElement(spatialTarget(root, current, ARROWS[direction], onOffer));
}

function perform(intent: RemoteIntent, scope: HTMLElement, o: PlayerRemoteOptions): void {
  switch (intent.type) {
    case "togglePlay":
      return o.togglePlay();
    case "play":
      return void o.videoRef.current?.play().catch(() => undefined);
    case "pause":
      return o.videoRef.current?.pause();
    case "seek":
      return o.seekBy(intent.direction * o.seekStep);
    case "focusControls":
      return focusControls(scope, o.started);
    case "parentPanel":
      return o.onParentPanel();
    case "closePanel":
      return o.onClosePanel();
    case "openPanel":
      return o.onOpenPanel(intent.panel);
    case "nextEpisode":
      return o.onNextEpisode?.();
    case "restart":
      return o.seek(0);
    default:
      return;
  }
}

/** Runs a focus move, or what the move falls back to when nothing lies that way. */
function performMove(direction: RemoteDirection, fallback: MoveFallback, scope: HTMLElement, o: PlayerRemoteOptions): void {
  if (moveFocus(scope, direction)) return;
  if (fallback === "seek") perform({ type: "seek", direction: direction === "left" ? -1 : 1 }, scope, o);
  else if (fallback === "focusControls") focusControls(scope, o.started);
  else if (fallback === "parentPanel") o.onParentPanel();
}

function contextOf(scope: HTMLElement, o: PlayerRemoteOptions): RemoteContext {
  return {
    focus: zoneIn(scope),
    panelOpen: o.panel !== "none",
    panelHasParent: o.panelHasParent,
    started: o.started,
    playing: o.playing,
    controlsShown: o.controlsShown,
  };
}

/**
 * Whether a repeated keydown (a held button) should be dropped. Only the D-pad
 * repeats, and no faster than the interval: a held Back would otherwise walk
 * out of the player, and a held OK would pause and resume in a blur.
 */
function dropsRepeat(event: KeyboardEvent, direction: boolean, lastActedAt: { current: number }): boolean {
  if (!event.repeat) return false;
  const now = performance.now();
  if (!direction || now - lastActedAt.current < HELD_REPEAT_INTERVAL_MS) return true;
  lastActedAt.current = now;
  return false;
}

function onRemoteKey(event: KeyboardEvent, o: PlayerRemoteOptions, lastActedAt: { current: number }): void {
  const shell = o.shellRef.current;
  if (!shell || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = remoteKey(event, !isTextEntry(document.activeElement));
  if (!key) return;
  if (dropsRepeat(event, isRemoteDirection(key), lastActedAt)) return event.preventDefault();
  const scope = scopeOf(shell);
  const intent = remoteIntent(key, contextOf(scope, o));
  if (intent.type === "native") return o.poke();
  event.preventDefault();
  if (intent.type === "leave") return o.onBack();
  if (intent.type === "hideControls") return o.hideControls();
  if (intent.type === "move") performMove(intent.direction, intent.fallback, scope, o);
  else perform(intent, scope, o);
  o.poke();
}

/**
 * Drives the player from a television remote: D-pad, OK, Back, the transport
 * buttons and the colour buttons. Only runs on a television. The keyboard map
 * in Player.tsx still answers every other key, and skips any press this took
 * (marked with preventDefault).
 */
export function usePlayerRemote(options: PlayerRemoteOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const lastActedAt = useRef(0);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isTvLikeDevice()) return;
    const onKey = (event: KeyboardEvent) => onRemoteKey(event, latest.current, lastActedAt);
    // Capture: the press is marked as taken before any control's own key handler sees it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Focus follows the menus: into one as it opens, back to the button that opened it as it closes.
  const { panel, shellRef } = options;
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !isTvLikeDevice()) return;
    const scope = scopeOf(shell);
    if (panel === "none") {
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected && onOffer(back)) focusElement(back);
      return;
    }
    const active = activeIn(scope);
    if (active && !active.closest(MENU_SELECTOR)) opener.current = active;
    const frame = window.requestAnimationFrame(() => focusMenu(scope));
    return () => window.cancelAnimationFrame(frame);
  }, [panel, shellRef]);

  // Focus never sits on a control that has faded out, or OK would press a button nobody can see.
  const { controlsShown } = options;
  useEffect(() => {
    const shell = shellRef.current;
    if (controlsShown || !shell || !isTvLikeDevice()) return;
    const zone = zoneIn(scopeOf(shell));
    if (zone === "control" || zone === "seek") activeIn(scopeOf(shell))?.blur();
  }, [controlsShown, shellRef]);

  // A prompt takes focus as it appears, unless the viewer is busy with the controls.
  const { promptKey } = options;
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !isTvLikeDevice()) return;
    const frame = window.requestAnimationFrame(() => {
      const scope = scopeOf(shell);
      if (zoneIn(scope) === "none") focusPrompt(scope);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [promptKey, shellRef]);
}

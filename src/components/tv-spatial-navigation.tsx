"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  dismissOpenLayer,
  focusableElements,
  isTvLikeDevice,
  spatialTarget,
  type SpatialDirection,
} from "@/lib/tv-navigation";
import { isPlayerPath } from "@/lib/nav";
import { caretKeepsKey, isRemoteDirection, isTextEntry, remoteKey, type RemoteDirection } from "@/lib/remote-keys";

const ARROWS: Record<RemoteDirection, SpatialDirection> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
};

const SLIDER_SELECTOR = 'input[type="range"], [role="slider"]';

/** How long a new page is given to show its nominated first-focus control: tries × interval. */
const FIRST_FOCUS_TRIES = 12;
const FIRST_FOCUS_RETRY_MS = 250;

/**
 * Two D-pad moves closer together than this are a held button rather than two
 * decisions, and the scroll drops to instant for them. Smooth scrolling is
 * worth the cost for a single press; under repeat it queues one animation per
 * press on a CPU that is already the bottleneck, and focus visibly lags behind
 * the remote.
 */
const HELD_REPEAT_MS = 250;

export function TvSpatialNavigation() {
  const pathname = usePathname();

  useEffect(() => {
    if (!isTvLikeDevice()) return;
    // The head script normally set this before the first paint; assigning it
    // again is harmless and covers the case where that script was blocked.
    document.documentElement.dataset.tv = "1";

    let movedThisFrame = false;
    let frameHandle = 0;
    let lastMoveAt = 0;

    const move = (current: HTMLElement, direction: SpatialDirection): boolean => {
      const next = spatialTarget(document, current, direction);
      if (!next) return false;
      const now = performance.now();
      const held = now - lastMoveAt < HELD_REPEAT_MS;
      lastMoveAt = now;
      next.focus({ preventScroll: true });
      // "instant", not "auto": `auto` defers to CSS, and html[data-tv="1"]
      // sets scroll-behavior: smooth, so `auto` would quietly stay smooth and
      // the repeat case would get no relief at all.
      next.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: held ? "instant" : "smooth",
      });
      return true;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // The player owns its own remote map, including media and Back keys,
      // for as long as it is on screen. (Checking the event target missed
      // most presses: with nothing focused the target is <body>, so arrows
      // both seeked and moved focus onto the hidden Back button.)
      if (document.querySelector(".player-shell")) return;
      // An open menu, a slider or the PIN pad already took this press.
      if (event.defaultPrevented) return;

      const target = event.target as HTMLElement | null;
      const typing = isTextEntry(target);
      const key = remoteKey(event, !typing);

      if (key === "back") {
        event.preventDefault();
        if (!dismissOpenLayer()) window.history.back();
        return;
      }

      // A remote's OK button lands as Enter. Native activation covers buttons
      // and links; elements that are only ARIA buttons need the click synthesised
      // or OK does nothing on them.
      if (key === "ok") {
        const role = target?.getAttribute("role");
        if (target && role === "button" && target.tagName !== "BUTTON") {
          event.preventDefault();
          target.click();
        }
        return;
      }

      if (!isRemoteDirection(key)) return;
      // In a text field Left and Right move the caret until it reaches the end;
      // on a slider they change its value.
      if (typing && caretKeepsKey(target as HTMLInputElement, key)) return;
      if ((key === "left" || key === "right") && target?.matches(SLIDER_SELECTOR)) return;

      // One move per frame. A held D-pad fires far faster than the panel can
      // paint, and without this each repeat queued another full spatial search
      // between the key event and a frame that never got a chance to render.
      if (movedThisFrame) {
        event.preventDefault();
        return;
      }

      const direction = ARROWS[key];
      const current = document.activeElement as HTMLElement | null;
      const hasFocus =
        current &&
        current !== document.body &&
        document.documentElement.contains(current);

      if (!hasFocus) {
        const first = focusableElements(document)[0];
        if (first) {
          event.preventDefault();
          first.focus();
          first.scrollIntoView({ block: "nearest", behavior: "instant" });
        }
        return;
      }

      if (move(current, direction)) {
        event.preventDefault();
        movedThisFrame = true;
        frameHandle = window.requestAnimationFrame(() => {
          movedThisFrame = false;
          frameHandle = 0;
        });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (frameHandle) window.cancelAnimationFrame(frameHandle);
      delete document.documentElement.dataset.tv;
    };
  }, []);

  /**
   * Give every new page a focused element.
   *
   * Client navigation leaves focus on document.body, so arriving anywhere new
   * showed no focus ring at all and the first press of the remote was spent
   * bootstrapping rather than moving. Only claims focus when nothing else holds
   * it, so it can never pull focus out from under a viewer mid-interaction.
   */
  useEffect(() => {
    if (!isTvLikeDevice()) return;
    // Sign-in focuses its own name and PIN fields. Only the profile picker's
    // nominated profile is focused there, never a stand-in.
    const standIn = pathname !== "/login";
    // In the player nothing is focused until the viewer reaches for a control:
    // its first focusable element is Back, and OK would leave instead of pausing.
    if (isPlayerPath(pathname)) return;
    // A page nominates its main action with data-tv-first-focus, but that
    // button often arrives with the page's data, after the first frame. Focus
    // takes the first control meanwhile and moves to the nominated one when it
    // appears, unless the viewer has moved focus themselves by then.
    let placeholder: HTMLElement | null = null;
    let tries = 0;
    let timer = 0;
    const claim = () => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== placeholder) return;
      const main = document.querySelector("main") ?? document;
      const preferred = main.querySelector<HTMLElement>("[data-tv-first-focus]");
      if (preferred && !preferred.closest("[aria-hidden='true']")) {
        preferred.focus({ preventScroll: true });
        return;
      }
      if (standIn && !placeholder?.isConnected) {
        placeholder = focusableElements(main)[0] ?? null;
        placeholder?.focus({ preventScroll: true });
      }
      if (++tries < FIRST_FOCUS_TRIES) timer = window.setTimeout(claim, FIRST_FOCUS_RETRY_MS);
    };
    const handle = window.requestAnimationFrame(claim);
    return () => {
      window.cancelAnimationFrame(handle);
      window.clearTimeout(timer);
    };
  }, [pathname]);

  return null;
}

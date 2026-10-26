"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Modal-dialog focus management (WAI-ARIA APG "dialog (modal)" pattern):
 *
 *  - on activation, focus moves into the container (an element marked
 *    `data-autofocus`, else the first focusable one, else the container);
 *  - Tab / Shift+Tab wrap inside the container, and pull focus back in if it
 *    has escaped (e.g. the focused button was unmounted by a step change);
 *  - Escape calls `onEscape` when one is given (the caller decides whether a
 *    submit in flight should block it);
 *  - on deactivation / unmount, focus returns to the element that had it when
 *    the trap activated (the opener), if that element is still in the page.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  // Read at event time so a new callback identity never re-runs the effect
  // (which would re-steal focus on every parent render).
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const initial =
      container.querySelector<HTMLElement>("[data-autofocus]") ?? focusableWithin(container)[0] ?? null;
    if (initial) {
      initial.focus();
    } else {
      if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
      container.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (onEscapeRef.current) {
          e.preventDefault();
          onEscapeRef.current();
        }
        return;
      }
      if (e.key !== "Tab" || !container) return;

      const items = focusableWithin(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      const inside = current instanceof Node && container.contains(current);

      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (current === first || !items.includes(current as HTMLElement))) {
        // Also covers focus on a non-tabbable element inside (the heading,
        // tabIndex -1): the browser would step out of the dialog from there.
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [ref, active]);
}

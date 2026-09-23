"use client";

/**
 * Reduced-motion hook for the city components (Phase 3).
 *
 * Combines the app's explicit `<html class="velaris-reduced-motion">` toggle
 * with the OS `prefers-reduced-motion` media query. The pure core
 * (`isReducedMotionActive`) is exported for unit tests; the hook wires it to a
 * MutationObserver on <html> and a matchMedia change listener so it stays live.
 */

import { useEffect, useState } from "react";

const CLASS_SELECTOR = "velaris-reduced-motion";

/** Pure combination: either the html class or the OS media preference wins. */
export function isReducedMotionActive(
  htmlHasClass: boolean,
  mediaReduced: boolean,
): boolean {
  return htmlHasClass || mediaReduced;
}

function queryMedia(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Live reduced-motion signal. Re-renders whenever either source flips. Safe to
 * call from any "use client" component under the Velaris providers.
 */
export function useVelarisReducedMotion(): boolean {
  const [media, setMedia] = useState(false);
  const [htmlClass, setHtmlClass] = useState(false);

  useEffect(() => {
    setMedia(queryMedia());
    setHtmlClass(document.documentElement.classList.contains(CLASS_SELECTOR));

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMediaChange = (e: MediaQueryListEvent) => setMedia(e.matches);
    // matchMedia with addEventListener; older Safari uses addListener.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onMediaChange);
    } else {
      (mql as { addListener?: (l: (e: MediaQueryListEvent) => void) => void }).addListener?.(
        onMediaChange,
      );
    }

    const observer = new MutationObserver(() => {
      setHtmlClass(document.documentElement.classList.contains(CLASS_SELECTOR));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      if (typeof mql.removeEventListener === "function") {
        mql.removeEventListener("change", onMediaChange);
      } else {
        (mql as { removeListener?: (l: (e: MediaQueryListEvent) => void) => void }).removeListener?.(
          onMediaChange,
        );
      }
      observer.disconnect();
    };
  }, []);

  return isReducedMotionActive(htmlClass, media);
}

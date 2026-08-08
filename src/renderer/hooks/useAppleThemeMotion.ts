import { useEffect, useState } from "react";
import type { Transition } from "motion/react";

const readAppleTheme = (): boolean =>
  typeof document !== "undefined" &&
  document.documentElement.dataset.themePreset === "apple";

const readReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Keeps motion opt-in at the preset boundary. Theme changes are applied to the
 * document root outside React, so a MutationObserver is required here.
 */
export const useAppleThemeMotion = (): {
  enabled: boolean;
  reducedMotion: boolean;
} => {
  const [enabled, setEnabled] = useState(readAppleTheme);
  const [reducedMotion, setReducedMotion] = useState(readReducedMotion);

  useEffect(() => {
    const root = document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateTheme = (): void => setEnabled(readAppleTheme());
    const updateReducedMotion = (): void => setReducedMotion(mediaQuery.matches);
    const observer = new MutationObserver(updateTheme);

    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme-preset"],
    });
    mediaQuery.addEventListener("change", updateReducedMotion);

    return () => {
      observer.disconnect();
      mediaQuery.removeEventListener("change", updateReducedMotion);
    };
  }, []);

  return { enabled, reducedMotion };
};

export const appleSurfaceTransition = (reducedMotion: boolean): Transition =>
  reducedMotion
    ? { duration: 0.16, ease: "easeOut" }
    : {
        type: "spring",
        stiffness: 420,
        damping: 38,
        mass: 0.7,
      };

export const appleLayoutTransition = (reducedMotion: boolean): Transition =>
  reducedMotion
    ? { duration: 0.16, ease: "easeOut" }
    : {
        type: "spring",
        stiffness: 360,
        damping: 36,
        mass: 0.82,
      };

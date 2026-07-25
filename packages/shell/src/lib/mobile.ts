import { useCallback, useEffect, useState } from "react";

export type MobileMode = "simple" | "full";

const KEY = "aura-mobile-mode";
const QUERY = "(max-width: 767px)";

/**
 * Narrow-viewport detection with a persisted user override. On phones the
 * shell auto-starts in the "simple" view; picking "Full view" from the FAB
 * menu sticks across reloads until the user switches back.
 */
export function useMobileMode(): {
  isNarrow: boolean;
  simple: boolean;
  setMode: (m: MobileMode) => void;
} {
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(QUERY).matches);
  const [override, setOverride] = useState<MobileMode | null>(() => {
    const v = localStorage.getItem(KEY);
    return v === "simple" || v === "full" ? v : null;
  });

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setMode = useCallback((m: MobileMode) => {
    localStorage.setItem(KEY, m);
    setOverride(m);
  }, []);

  return { isNarrow, simple: isNarrow && override !== "full", setMode };
}

import { useCallback, useEffect, useState } from "react";

// 2026-10-07 (analyst canvas round): which rendering of the same blocks a
// dashboard shows - the Option A grid ("dashboard") or the Option C
// analyst canvas ("canvas"). Remembered per dashboard in localStorage
// (every read/write in try/catch - a private window or a blocked storage
// just forgets) and mirrored into the URL as ?mode=canvas so a link
// restores it. The URL wins over storage on first load.

export type DashboardViewMode = "dashboard" | "canvas";

export const VIEW_MODE_URL_KEY = "mode";

function storageKey(key: string): string {
  return `gd360.dashboard.${key}.view`;
}

export function readViewModeFromUrl(search: string): DashboardViewMode | null {
  try {
    const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(VIEW_MODE_URL_KEY);
    return v === "canvas" || v === "dashboard" ? v : null;
  } catch {
    return null;
  }
}

export function readStoredViewMode(key: string | null): DashboardViewMode | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(storageKey(key));
    return v === "canvas" || v === "dashboard" ? v : null;
  } catch {
    return null;
  }
}

function writeViewMode(key: string | null, mode: DashboardViewMode) {
  if (typeof window === "undefined") return;
  if (key) {
    try {
      window.localStorage.setItem(storageKey(key), mode);
    } catch {
      // Storage can be blocked; the URL still carries it.
    }
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (mode === "canvas") params.set(VIEW_MODE_URL_KEY, "canvas");
    else params.delete(VIEW_MODE_URL_KEY);
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", url);
    }
  } catch {
    // A sandboxed frame can refuse replaceState.
  }
}

export function useDashboardViewMode(key: string | null, fallback: DashboardViewMode = "dashboard"): [DashboardViewMode, (m: DashboardViewMode) => void] {
  const [mode, setModeState] = useState<DashboardViewMode>(() => {
    const fromUrl = typeof window !== "undefined" ? readViewModeFromUrl(window.location.search) : null;
    return fromUrl || readStoredViewMode(key) || fallback;
  });
  // A different dashboard under the same route: re-read its own setting.
  useEffect(() => {
    const fromUrl = typeof window !== "undefined" ? readViewModeFromUrl(window.location.search) : null;
    const next = fromUrl || readStoredViewMode(key) || fallback;
    setModeState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const setMode = useCallback((m: DashboardViewMode) => {
    setModeState(m);
    writeViewMode(key, m);
  }, [key]);
  return [mode, setMode];
}

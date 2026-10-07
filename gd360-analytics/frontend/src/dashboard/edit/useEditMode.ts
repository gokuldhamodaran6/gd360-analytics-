import { useCallback, useState } from "react";

// 2026-10-07 (dashboard edit mode): whether the owner is editing lives in
// the URL as ?edit=1, so a refresh keeps it and a link to the finished
// dashboard never opens the editor. Same approach as canvas/useViewMode:
// every history write is in try/catch (a sandboxed frame can refuse it -
// the state still lives in memory) and only this one key is touched, so
// ?mode=canvas and the run state (?f=&period=&from=&to=&view=&bf=) stay.

export const EDIT_URL_KEY = "edit";

export function readEditFromUrl(search?: string): boolean {
  try {
    const raw = search ?? (typeof window !== "undefined" ? window.location.search : "");
    return new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw).get(EDIT_URL_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeEditToUrl(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (on) params.set(EDIT_URL_KEY, "1");
    else params.delete(EDIT_URL_KEY);
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", url);
    }
  } catch {
    // A sandboxed frame can refuse replaceState.
  }
}

export function useEditMode(): [boolean, (on: boolean) => void] {
  const [editing, setEditingState] = useState<boolean>(() => readEditFromUrl());
  const setEditing = useCallback((on: boolean) => {
    setEditingState(on);
    writeEditToUrl(on);
  }, []);
  return [editing, setEditing];
}

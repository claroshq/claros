/**
 * Theme selection.
 *
 * Three modes: "light", "dark", "system" (default). The resolved theme is
 * applied as the .dark class on <html>; the inline script in index.html
 * applies the same logic before first paint. The stored choice lives in
 * localStorage under "claros-ui-theme". In "system" mode a matchMedia
 * listener keeps the resolved theme in sync with the OS.
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "claros-ui-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

let mode: ThemeMode = readStoredMode();
const listeners = new Set<() => void>();

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // storage unavailable (private mode); fall through to system
  }
  return "system";
}

function apply() {
  const dark = mode === "dark" || (mode === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
}

function getThemeMode(): ThemeMode {
  return mode;
}

function setThemeMode(next: ThemeMode) {
  mode = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage unavailable; the choice still applies for this session
  }
  apply();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

media.addEventListener("change", () => {
  if (mode === "system") {
    apply();
    listeners.forEach((l) => l());
  }
});

export function useThemeMode(): [ThemeMode, (m: ThemeMode) => void] {
  const current = useSyncExternalStore(subscribe, getThemeMode);
  return [current, setThemeMode];
}

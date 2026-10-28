/**
 * Light / dark colour scheme.
 *
 * Preference "system" (default) follows the operating system; "light" and
 * "dark" are chosen by the user (profile / menu) and stored locally on this
 * device only (localStorage, no server, no personal data). The resolved
 * scheme is written to <html data-theme="light|dark">; tokens.css switches
 * all colour tokens on that attribute.
 */
import { useEffect, useState } from "preact/hooks";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "stundenwerk_theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<(t: ResolvedTheme) => void>();
let initialised = false;
/** Last choice of this page view (used when localStorage is blocked). */
let memoryPref: ThemePreference | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function getThemePreference(): ThemePreference {
  try {
    const store = storage();
    if (!store) return memoryPref ?? "system";
    const v = store.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return memoryPref ?? "system";
  }
}

function systemTheme(): ResolvedTheme {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Resolves a preference against the current system setting. */
export function resolveTheme(pref: ThemePreference = getThemePreference()): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

export function currentTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function apply(): void {
  if (typeof document === "undefined") return;
  const theme = resolveTheme();
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    root.dataset.theme = theme;
    for (const fn of listeners) fn(theme);
  }
  root.style.colorScheme = theme;
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    if (pref === "system") storage()?.removeItem(THEME_STORAGE_KEY);
    else storage()?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Storage blocked (private mode): the choice applies to this page view only.
  }
  memoryPref = pref;
  apply();
}

/** Call once per app entry before rendering. Follows later system changes. */
export function initTheme(): void {
  apply();
  if (initialised || typeof matchMedia !== "function") return;
  initialised = true;
  const mq = matchMedia(DARK_QUERY);
  const onChange = () => { if (getThemePreference() === "system") apply(); };
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  // Another tab changed the preference.
  if (typeof addEventListener === "function") addEventListener("storage", (e) => { if (e.key === THEME_STORAGE_KEY) apply(); });
}

/** Subscribes to the resolved theme (for components that need it in JS, e.g. brand previews). */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme);
  useEffect(() => {
    listeners.add(setTheme);
    setTheme(currentTheme());
    return () => { listeners.delete(setTheme); };
  }, []);
  return theme;
}

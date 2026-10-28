/** Tiny hash router: "#/monat/2026-10" → { path: "/monat", params: ["2026-10"] }. */
import { useEffect, useState } from "preact/hooks";

export interface Route { path: string; parts: string[]; query: URLSearchParams }

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [p = "/", q = ""] = raw.split("?");
  const parts = p.split("/").filter(Boolean).map(decodeURIComponent);
  return { path: "/" + (parts[0] ?? ""), parts: parts.slice(1), query: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(location.hash));
      // Move focus to the main heading for screen readers on navigation.
      requestAnimationFrame(() => {
        const h = document.querySelector<HTMLElement>("main h1");
        if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
        window.scrollTo(0, 0);
      });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(to: string): void {
  location.hash = to.startsWith("#") ? to : "#" + to;
}

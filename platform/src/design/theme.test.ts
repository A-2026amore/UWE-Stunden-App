import { afterEach, describe, expect, it, vi } from "vitest";

/** Minimal browser stubs: localStorage, matchMedia and <html>. */
function stubBrowser(systemDark: boolean) {
  const store = new Map<string, string>();
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal("matchMedia", () => ({ matches: systemDark, addEventListener: () => undefined }));
  vi.stubGlobal("document", { documentElement: root });
  return { store, root };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("theme preference", () => {
  it("follows the system setting by default", async () => {
    const { root } = stubBrowser(true);
    const t = await import("./theme");
    t.initTheme();
    expect(t.getThemePreference()).toBe("system");
    expect(root.dataset.theme).toBe("dark");
    expect(t.currentTheme()).toBe("dark");
  });

  it("stores an explicit choice locally and applies it", async () => {
    const { root, store } = stubBrowser(true);
    const t = await import("./theme");
    t.initTheme();
    t.setThemePreference("light");
    expect(store.get(t.THEME_STORAGE_KEY)).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    t.setThemePreference("system");
    expect(store.has(t.THEME_STORAGE_KEY)).toBe(false);
    expect(root.dataset.theme).toBe("dark");
  });

  it("ignores invalid stored values and survives blocked storage", async () => {
    const { store, root } = stubBrowser(false);
    store.set("stundenwerk_theme", "pink");
    const t = await import("./theme");
    expect(t.getThemePreference()).toBe("system");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    t.setThemePreference("dark");
    expect(root.dataset.theme).toBe("dark");
  });
});

/**
 * Home-screen icon: every page a user can "add to home screen" from must point to the same Schichtklar24 icon.
 * Without an apple-touch-icon iOS uses a screenshot of the page, and Android without a PNG icon draws a letter
 * on a random colour – so employees ended up with different icons depending on the page they were on.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PLATFORM = resolve(__dirname, "../../platform");
const PAGES = [
  "index.html", "app/index.html", "chef/index.html", "admin/index.html", "einladung/index.html",
  "passwort-neu/index.html", "rechtliches/agb/index.html", "rechtliches/avv/index.html",
  "rechtliches/datenschutz/index.html", "rechtliches/impressum/index.html",
];
const ICON_180 = join(PLATFORM, "public/app/icons/icon-180.png");
const ICON_192 = join(PLATFORM, "public/app/icons/icon-192.png");
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** Resolve an href of a page the way the built site does (public/ is copied to the site root). */
function target(page: string, href: string): string {
  return join(PLATFORM, "public", dirname(page), href);
}

describe("app icon on every page", () => {
  for (const page of PAGES) {
    it(`${page} links the Schichtklar24 home-screen icons`, () => {
      const html = readFileSync(join(PLATFORM, page), "utf8");
      const touch = [...html.matchAll(/<link rel="apple-touch-icon"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
      expect(touch).toHaveLength(1);
      expect(sha(target(page, touch[0]))).toBe(sha(ICON_180));
      const png = html.match(/<link rel="icon" href="([^"]+)" type="image\/png" sizes="192x192"/);
      expect(png).not.toBeNull();
      expect(sha(target(page, png![1]))).toBe(sha(ICON_192));
      expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="Schichtklar24[^"]*"/);
    });
  }

  it("root fallbacks for browsers that ask for /apple-touch-icon.png and /favicon.ico", () => {
    expect(sha(join(PLATFORM, "public/apple-touch-icon.png"))).toBe(sha(ICON_180));
    expect(existsSync(join(PLATFORM, "public/favicon.ico"))).toBe(true);
  });

  it("the installed employee app is called Schichtklar24 and keeps its id", () => {
    const m = JSON.parse(readFileSync(join(PLATFORM, "public/app/manifest.webmanifest"), "utf8"));
    expect(m.short_name).toBe("Schichtklar24");
    expect(m.id).toBe("./?app=stundenwerk-mitarbeiter-demo");
    for (const icon of m.icons) expect(existsSync(join(PLATFORM, "public/app", icon.src))).toBe(true);
  });
});

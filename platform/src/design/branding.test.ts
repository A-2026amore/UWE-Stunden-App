import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DARK_SURFACES, PRODUCT_BRANDING, brandVariables, brandVariablesDark, contrastRatio, ensureContrast, readableTextOn } from "./branding";

const CASES = [
  { primaryColor: "#087f89", secondaryColor: "#19363c", accentColor: "#00a99e" }, // UWE
  { primaryColor: "#6b3fa0", secondaryColor: "#3b2457", accentColor: "#e0a100" }, // Muster
  { primaryColor: "#ffdd00", secondaryColor: "#ffffff", accentColor: "#00ff00" }, // very light
  { primaryColor: "#777777", secondaryColor: "#000000", accentColor: "#888888" }, // mid grey
];

describe("branding contrast", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(readableTextOn("#ffdd00")).not.toBe("#ffffff");
    expect(readableTextOn("#087f89")).toBe("#ffffff");
  });
  it.each(CASES)("keeps every text pair ≥ 4.5:1 (%o)", (b) => {
    const v = brandVariables(b);
    expect(contrastRatio(v["--brand-primary"]!, v["--brand-on-primary"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v["--brand-primary-hover"]!, v["--brand-on-primary"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v["--brand-primary-text"]!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v["--brand-primary-text"]!, v["--brand-primary-soft"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v["--brand-accent-text"]!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v["--brand-accent-text"]!, v["--brand-accent-soft"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v["--brand-secondary"]!, v["--brand-on-secondary"]!)).toBeGreaterThanOrEqual(4.5);
  });
  it("darkens until AA", () => {
    expect(contrastRatio(ensureContrast("#00a99e"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("branding: dark colour scheme", () => {
  it.each(CASES)("keeps text pairs ≥ 4.5:1 on the dark surfaces (%o)", (b) => {
    const v = brandVariablesDark(b);
    expect(contrastRatio(v["--brand-primary"]!, v["--brand-on-primary"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v["--brand-primary-hover"]!, v["--brand-on-primary"]!)).toBeGreaterThanOrEqual(4.5);
    for (const bg of [DARK_SURFACES.bg, DARK_SURFACES.surface, DARK_SURFACES.raised, v["--brand-primary-soft"]!]) {
      expect(contrastRatio(v["--brand-primary-text"]!, bg)).toBeGreaterThanOrEqual(4.5);
    }
    for (const bg of [DARK_SURFACES.bg, DARK_SURFACES.surface, DARK_SURFACES.raised, v["--brand-accent-soft"]!]) {
      expect(contrastRatio(v["--brand-accent-text"]!, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(v["--brand-secondary"]!, v["--brand-on-secondary"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("very dark brand colours are lifted so buttons stay visible on the dark page (≥ 3:1)", () => {
    const v = brandVariablesDark({ primaryColor: "#101820", secondaryColor: "#000000", accentColor: "#050505" });
    expect(contrastRatio(v["--brand-primary"]!, DARK_SURFACES.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(v["--brand-primary"]!, v["--brand-on-primary"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v["--brand-accent"]!, DARK_SURFACES.bg)).toBeGreaterThanOrEqual(3);
  });
});

describe("design tokens", () => {
  const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");
  const fallback = (scheme: "light" | "dark", name: string) =>
    new RegExp(`--brand-${name}: var\\(--${scheme}-brand-${name}, (#[0-9a-f]{6})\\)`).exec(css)?.[1];

  it("CSS fallbacks are the product colours of both schemes", () => {
    const light = brandVariables(PRODUCT_BRANDING);
    const dark = brandVariablesDark(PRODUCT_BRANDING);
    for (const key of Object.keys(light)) {
      const name = key.replace("--brand-", "");
      expect(fallback("light", name), key).toBe(light[key]);
      expect(fallback("dark", name), key).toBe(dark[key]);
    }
  });

  it("neutral text colours reach WCAG AA on their surfaces in both schemes", () => {
    const token = (block: string, name: string) => new RegExp(`--color-${name}: (#[0-9a-f]{6});`).exec(block)?.[1];
    const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf(':root[data-theme="dark"]'));
    const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
    for (const block of [lightBlock, darkBlock]) {
      for (const surface of ["bg", "surface", "surface-muted"]) {
        expect(contrastRatio(token(block, "text")!, token(block, surface)!)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(token(block, "text-muted")!, token(block, surface)!)).toBeGreaterThanOrEqual(4.5);
        for (const tone of ["success", "warning", "danger", "info"]) {
          expect(contrastRatio(token(block, tone)!, token(block, `${tone}-bg`)!), `${tone} on ${tone}-bg`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(token(block, `${tone}-ink`)!, token(block, `${tone}-bg`)!), `${tone}-ink`).toBeGreaterThanOrEqual(4.5);
        }
      }
      // Form borders are UI components: ≥ 3:1 against the surface.
      expect(contrastRatio(token(block, "border-strong")!, token(block, "surface")!)).toBeGreaterThanOrEqual(3);
      // Solid status buttons carry white text.
      for (const tone of ["danger-solid", "success-solid", "info-solid"]) expect(contrastRatio(token(block, tone)!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });
});

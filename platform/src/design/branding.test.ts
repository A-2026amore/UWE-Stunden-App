import { describe, expect, it } from "vitest";
import { brandVariables, contrastRatio, ensureContrast, readableTextOn } from "./branding";

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

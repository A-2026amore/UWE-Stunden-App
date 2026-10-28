/**
 * White-label support: product identity constants and runtime tenant branding.
 *
 * Product name "Stundenwerk" (subject to a trademark check). Rename it in ONE
 * place: PRODUCT_NAME below. Tenant brands (e.g. UWE) are applied via CSS
 * variables – separately for the light and the dark colour scheme.
 */
import type { Branding } from "../core/types";

/** Product name – change here only. */
export const PRODUCT_NAME = "Stundenwerk";
export const PRODUCT_TAGLINE = "Zeiterfassung für Teams im Außendienst";
/** Kept for existing imports; identical to PRODUCT_NAME (no "Arbeitstitel" suffix any more). */
export const PRODUCT_FULL_NAME = PRODUCT_NAME;

/** Product colours (indigo) for the login pages, the Super-Admin and pages without a tenant. */
export const PRODUCT_BRANDING: Branding = {
  logoUrl: null,
  markUrl: null,
  primaryColor: "#4f46e5",
  secondaryColor: "#312e81",
  accentColor: "#0891b2",
  slogan: null,
};

/** Default colours of a new tenant (neutral slate blue – tenant data, unchanged). */
export const DEFAULT_BRANDING: Branding = {
  logoUrl: null,
  markUrl: null,
  primaryColor: "#2d4f73",
  secondaryColor: "#4a6a8a",
  accentColor: "#3b82c4",
  slogan: null,
};

// ------------------------------------------------------------ colour math

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  if (!isHexColor(hex)) throw new Error(`Ungültige Farbe: ${hex}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** WCAG 2.1 relative luminance. */
export function luminance(hex: string): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const INK = "#13262b";
const WHITE = "#ffffff";

/** Text colour (white or dark ink) with the higher contrast on `background`. */
export function readableTextOn(background: string): string {
  return contrastRatio(background, WHITE) >= contrastRatio(background, INK) ? WHITE : INK;
}

/** Mix colour with black (amount > 0) or white (amount < 0). */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const target = amount >= 0 ? 0 : 255;
  const t = Math.abs(amount);
  return rgbToHex([r + (target - r) * t, g + (target - g) * t, b + (target - b) * t]);
}

/** Darkens `hex` step by step until it reaches `minRatio` against `background`. */
export function ensureContrast(hex: string, background = WHITE, minRatio = 4.5): string {
  let colour = hex;
  for (let step = 0; step < 20 && contrastRatio(colour, background) < minRatio; step++) {
    colour = shade(colour, 0.08);
  }
  return colour;
}

/** Lightens `hex` step by step until it reaches `minRatio` against a dark `background`. */
export function ensureContrastLight(hex: string, background: string, minRatio = 4.5): string {
  let colour = hex;
  for (let step = 0; step < 30 && contrastRatio(colour, background) < minRatio; step++) {
    colour = shade(colour, -0.08);
  }
  return colour;
}

/** Mixes `hex` with `other` (amount 0 … 1 of `other`). */
export function mixColors(hex: string, other: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [r2, g2, b2] = hexToRgb(other);
  return rgbToHex([r + (r2 - r) * amount, g + (g2 - g) * amount, b + (b2 - b) * amount]);
}

/** Dark-mode surfaces the brand colours are checked against (keep in sync with tokens.css). */
export const DARK_SURFACES = { bg: "#0b1120", surface: "#111a2e", raised: "#18233a" } as const;

type BrandColors = Pick<Branding, "primaryColor" | "secondaryColor" | "accentColor">;

function validColors(branding: BrandColors): { primary: string; secondary: string; accent: string } {
  return {
    primary: isHexColor(branding.primaryColor) ? branding.primaryColor : DEFAULT_BRANDING.primaryColor,
    secondary: isHexColor(branding.secondaryColor) ? branding.secondaryColor : DEFAULT_BRANDING.secondaryColor,
    accent: isHexColor(branding.accentColor) ? branding.accentColor : DEFAULT_BRANDING.accentColor,
  };
}

/** Background with white or ink text at ≥ 4.5:1 (darkened/lightened when the colour is a mid tone). */
function solidWithText(colour: string): { bg: string; on: string } {
  const on = readableTextOn(colour);
  if (contrastRatio(colour, on) >= 4.5) return { bg: colour, on };
  const bg = on === WHITE ? ensureContrast(colour, WHITE) : ensureContrastLight(colour, INK);
  return { bg, on: readableTextOn(bg) };
}

/**
 * Derives all CSS variables for a tenant brand (light colour scheme). Every
 * text/background pair meets WCAG AA (4.5:1) – checked in branding.test.ts.
 */
export function brandVariables(branding: BrandColors): Record<string, string> {
  const { primary, secondary, accent } = validColors(branding);
  const onPrimary = readableTextOn(primary);
  // If neither white nor ink reaches 4.5:1 on the brand colour, the button background is darkened.
  const buttonBg = contrastRatio(primary, onPrimary) >= 4.5 ? primary : ensureContrast(primary, onPrimary === WHITE ? WHITE : INK);
  const primarySoft = shade(primary, -0.9);
  const accentSoft = shade(accent, -0.9);
  // Text in brand colour must be readable on white AND on the soft tint backgrounds.
  const primaryText = ensureContrast(primary, primarySoft);
  const sec = solidWithText(secondary);
  return {
    "--brand-primary": buttonBg,
    "--brand-primary-hover": shade(buttonBg, onPrimary === WHITE ? 0.15 : -0.15),
    "--brand-on-primary": readableTextOn(buttonBg),
    "--brand-primary-text": primaryText,
    "--brand-primary-soft": primarySoft,
    "--brand-secondary": sec.bg,
    "--brand-on-secondary": sec.on,
    "--brand-accent": accent,
    "--brand-accent-text": ensureContrast(accent, accentSoft),
    "--brand-accent-soft": accentSoft,
  };
}

/**
 * The same variables for the dark colour scheme: brand text is lightened until
 * it reaches 4.5:1 on the dark surfaces and tints, buttons keep a readable
 * label and stay visible (≥ 3:1) against the dark page background.
 */
export function brandVariablesDark(branding: BrandColors): Record<string, string> {
  const { primary, secondary, accent } = validColors(branding);
  const { raised } = DARK_SURFACES;
  // Button: lift very dark brand colours so the button stands out from the page.
  let button = primary;
  for (let step = 0; step < 20 && contrastRatio(button, DARK_SURFACES.bg) < 3; step++) button = shade(button, -0.06);
  const btn = solidWithText(button);
  const primarySoft = mixColors(primary, DARK_SURFACES.surface, 0.78);
  const accentSoft = mixColors(accent, DARK_SURFACES.surface, 0.78);
  const lightOn = (c: string, soft: string) => {
    let colour = ensureContrastLight(c, raised);
    colour = ensureContrastLight(colour, soft);
    return colour;
  };
  const sec = solidWithText(secondary);
  return {
    "--brand-primary": btn.bg,
    "--brand-primary-hover": shade(btn.bg, btn.on === WHITE ? 0.15 : -0.15),
    "--brand-on-primary": btn.on,
    "--brand-primary-text": lightOn(primary, primarySoft),
    "--brand-primary-soft": primarySoft,
    "--brand-secondary": sec.bg,
    "--brand-on-secondary": sec.on,
    "--brand-accent": contrastRatio(accent, DARK_SURFACES.bg) >= 3 ? accent : ensureContrastLight(accent, DARK_SURFACES.bg, 3),
    "--brand-accent-text": lightOn(accent, accentSoft),
    "--brand-accent-soft": accentSoft,
  };
}

/**
 * Applies tenant branding at runtime (CSS variables + theme-color meta).
 * Sets --light-brand-* and --dark-brand-* on the root; tokens.css maps them
 * to --brand-* depending on the active colour scheme. Uses the CSSOM only
 * (allowed by the strict Content-Security-Policy without inline styles).
 * Without a tenant brand the product colours are used.
 */
export function applyBranding(branding: Branding | null | undefined, root: HTMLElement = document.documentElement): void {
  const source = branding ?? PRODUCT_BRANDING;
  const light = brandVariables(source);
  const dark = brandVariablesDark(source);
  for (const [name, value] of Object.entries(light)) root.style.setProperty(name.replace("--brand-", "--light-brand-"), value);
  for (const [name, value] of Object.entries(dark)) root.style.setProperty(name.replace("--brand-", "--dark-brand-"), value);
  // Remove direct overrides from older versions (they would win over the scheme mapping).
  for (const name of Object.keys(light)) root.style.removeProperty(name);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = light["--brand-primary"] ?? PRODUCT_BRANDING.primaryColor;
}

// ------------------------------------------------------------ asset URLs

let assetBase = "./";

/** Each app entry sets the relative path to the site root (e.g. "../"). */
export function setAssetBase(base: string): void {
  assetBase = base.endsWith("/") ? base : `${base}/`;
}

/** Resolves site-root-relative asset paths ("brands/uwe/logo.svg"); passes absolute and data: URLs through. */
export function resolveAsset(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^(data:|https?:|blob:|\/)/.test(url)) return url;
  return assetBase + url;
}

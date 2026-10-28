/**
 * White-label support: product identity constants and runtime tenant branding.
 *
 * The product itself has a neutral working name. Rename it in ONE place:
 * PRODUCT_NAME below. Tenant brands (e.g. UWE) are applied via CSS variables.
 */
import type { Branding } from "../core/types";

/** Neutral working name of the product – change here only. */
export const PRODUCT_NAME = "Stundenwerk";
export const PRODUCT_NAME_NOTE = "Arbeitstitel";
export const PRODUCT_TAGLINE = "Zeiterfassung für Teams im Außendienst";
export const PRODUCT_FULL_NAME = `${PRODUCT_NAME} (${PRODUCT_NAME_NOTE})`;

/** Product default colours (neutral slate blue). */
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

/**
 * Derives all CSS variables for a tenant brand. Every text/background pair
 * meets WCAG AA (4.5:1) – checked in branding.test.ts.
 */
export function brandVariables(branding: Pick<Branding, "primaryColor" | "secondaryColor" | "accentColor">): Record<string, string> {
  const primary = isHexColor(branding.primaryColor) ? branding.primaryColor : DEFAULT_BRANDING.primaryColor;
  const secondary = isHexColor(branding.secondaryColor) ? branding.secondaryColor : DEFAULT_BRANDING.secondaryColor;
  const accent = isHexColor(branding.accentColor) ? branding.accentColor : DEFAULT_BRANDING.accentColor;
  const onPrimary = readableTextOn(primary);
  // If neither white nor ink reaches 4.5:1 on the brand colour, the button background is darkened.
  const buttonBg = contrastRatio(primary, onPrimary) >= 4.5 ? primary : ensureContrast(primary, onPrimary === WHITE ? WHITE : INK);
  const primarySoft = shade(primary, -0.9);
  const accentSoft = shade(accent, -0.9);
  // Text in brand colour must be readable on white AND on the soft tint backgrounds.
  const primaryText = ensureContrast(primary, primarySoft);
  return {
    "--brand-primary": buttonBg,
    "--brand-primary-hover": shade(buttonBg, onPrimary === WHITE ? 0.15 : -0.15),
    "--brand-on-primary": readableTextOn(buttonBg),
    "--brand-primary-text": primaryText,
    "--brand-primary-soft": primarySoft,
    "--brand-secondary": secondary,
    "--brand-on-secondary": readableTextOn(secondary),
    "--brand-accent": accent,
    "--brand-accent-text": ensureContrast(accent, accentSoft),
    "--brand-accent-soft": accentSoft,
  };
}

/** Applies tenant branding at runtime (CSS variables + theme-color meta). */
export function applyBranding(branding: Branding | null | undefined, root: HTMLElement = document.documentElement): void {
  const vars = brandVariables(branding ?? DEFAULT_BRANDING);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = vars["--brand-primary"] ?? DEFAULT_BRANDING.primaryColor;
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

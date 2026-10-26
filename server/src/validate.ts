/**
 * Input validation for JSON bodies and URL parameters. Every function throws
 * an HttpError 400 with a German message. The database validates again
 * (CHECK constraints, function checks) – this layer gives precise messages
 * and rejects oversized or malformed input early.
 */
import { isRealDate, isValidMonth, parseClock } from "../../platform/src/core/time.ts";
import { badRequest } from "./errors.ts";

export type Json = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const ENTRY_ID_RE = /^[A-Za-z0-9_-]{4,100}$/;

export function object(v: unknown, allowed: readonly string[], what = "Eingabe"): Json {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw badRequest(`Ungültige ${what}: Objekt erwartet.`);
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw badRequest(`Unbekanntes Feld: ${k.slice(0, 40)}`);
  }
  return v as Json;
}

export function uuid(v: unknown, label = "Kennung"): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw badRequest(`Ungültige ${label}.`);
  return v.toLowerCase();
}

export function entryId(v: unknown): string {
  if (typeof v !== "string" || !ENTRY_ID_RE.test(v)) throw badRequest("Ungültige Eintrags-ID (4–100 Zeichen: Buchstaben, Ziffern, - und _).");
  return v;
}

interface StrOpts {
  label: string;
  max: number;
  min?: number;
  pattern?: RegExp;
  patternMessage?: string;
  trim?: boolean;
}

export function str(v: unknown, o: StrOpts): string {
  if (typeof v !== "string") throw badRequest(`${o.label}: Text erwartet.`);
  const s = o.trim === false ? v : v.trim();
  if (s.length > o.max) throw badRequest(`${o.label} darf höchstens ${o.max} Zeichen lang sein.`);
  if (o.min !== undefined && s.length < o.min) throw badRequest(o.min <= 1 ? `Bitte ${o.label} angeben.` : `${o.label} muss mindestens ${o.min} Zeichen lang sein.`);
  if (o.pattern && !o.pattern.test(s)) throw badRequest(o.patternMessage ?? `${o.label} hat ein ungültiges Format.`);
  return s;
}

export function optStr(v: unknown, o: StrOpts): string | null {
  if (v === null || v === undefined) return null;
  const s = str(v, o);
  return s === "" ? null : s;
}

export function int(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw badRequest(`${label} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return v;
}

export function bool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") throw badRequest(`${label}: Ja/Nein-Wert erwartet.`);
  return v;
}

export function date(v: unknown, label = "Datum"): string {
  if (!isRealDate(v)) throw badRequest(`Bitte ein gültiges ${label} (JJJJ-MM-TT) angeben.`);
  return v as string;
}

export function clock(v: unknown, label: string): string {
  if (!Number.isFinite(parseClock(v))) throw badRequest(`Bitte ${label} im Format HH:MM eintragen.`);
  return v as string;
}

export function month(v: unknown): string {
  if (!isValidMonth(v) || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(v as string)) throw badRequest("Bitte einen gültigen Monat (JJJJ-MM) angeben.");
  return v as string;
}

export function email(v: unknown, label = "E-Mail-Adresse"): string {
  const s = str(v, { label, max: 254, min: 3 }).toLowerCase();
  if (!EMAIL_RE.test(s)) throw badRequest("Bitte eine gültige E-Mail-Adresse angeben.");
  return s;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], label: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw badRequest(`Ungültiger Wert für ${label}.`);
  return v as T;
}

export function reason(v: unknown, min: number, message: string): string {
  if (typeof v !== "string" || v.trim().length < min) throw badRequest(message);
  if (v.length > 1000) throw badRequest("Die Begründung ist zu lang (max. 1000 Zeichen).");
  return v.trim();
}

export function optReason(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw badRequest("Begründung: Text erwartet.");
  if (v.length > 1000) throw badRequest("Die Begründung ist zu lang (max. 1000 Zeichen).");
  return v.trim() || null;
}

// ------------------------------------------------------------------ images

/** Max decoded size of an uploaded logo/mark (same limit as the demo). */
export const MAX_IMAGE_BYTES = 300 * 1024;
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

function magicOk(type: string, bytes: Buffer): boolean {
  if (type === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/webp") return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

/**
 * Logo/mark URL: null, https URL, site-relative path, or a PNG/JPEG/WebP data
 * URL (max 300 KB, content checked by magic bytes). SVG is rejected because
 * an SVG can carry script (XSS) and there is no sanitiser on the server.
 */
export function imageUrl(v: unknown, label: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw badRequest(`${label}: Text oder null erwartet.`);
  if (v.startsWith("data:")) {
    if (/^data:image\/svg/i.test(v)) throw badRequest("SVG-Grafiken sind aus Sicherheitsgründen nicht erlaubt. Bitte PNG, JPG oder WebP verwenden.");
    if (v.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64) throw badRequest(`Das Bild ist zu groß (max. ${MAX_IMAGE_BYTES / 1024} KB).`);
    const m = DATA_URL_RE.exec(v);
    if (!m) throw badRequest("Das Bild muss als Bilddatei (Data-URL, Base64) hochgeladen werden.");
    const type = m[1]!;
    if (!["image/png", "image/jpeg", "image/webp"].includes(type)) throw badRequest("Erlaubte Formate: PNG, JPG oder WebP.");
    const bytes = Buffer.from(m[2]!, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) throw badRequest(`Das Bild ist zu groß (max. ${MAX_IMAGE_BYTES / 1024} KB).`);
    if (!magicOk(type, bytes)) throw badRequest("Der Dateiinhalt passt nicht zum angegebenen Bildformat.");
    return v;
  }
  if (/^https:\/\/[^\s"'<>\\]+$/.test(v) && v.length <= 2048) {
    try {
      new URL(v);
      return v;
    } catch {
      /* fall through */
    }
  }
  if (/^\/[A-Za-z0-9._/-]{1,300}$/.test(v) && !v.startsWith("//") && !v.includes("..")) return v;
  throw badRequest(`${label}: nur https-Adressen, relative Pfade oder hochgeladene Bilder (PNG, JPG, WebP) sind erlaubt.`);
}

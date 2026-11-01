/**
 * Monthly statement PDF ("Stundennachweis"), generated locally without any
 * external library or server. Port of the legacy uwe-pdf.js:
 *  - A4, Helvetica/WinAnsi, readable full-width table over as many pages as
 *    needed (the business explicitly rejected squeezing everything onto one
 *    page) – header and table header are repeated on every page, footer
 *    shows "Seite x von y";
 *  - every tenant the same way (no company-specific code): the uploaded logo (as JPEG, see StatementPdfLogo) top
 *    left and faint as watermark in the middle of every page, or the company
 *    name as typographic logo in the primary colour when there is no logo;
 *  - optional work-account section; worked hours are never replaced.
 *  - Layout (Schichtklar24 design, 2026-10): info panel (person, personnel
 *    number, period, status), table with coloured header and zebra rows,
 *    summary block, footer with creation date, product name and
 *    "Seite x von y". Row heights and page breaks are unchanged, so the
 *    statement stays exactly as long as before (never squeezed).
 *
 * The only DOM/browser API used is `Blob` (also available in Node ≥ 18).
 */
import type { CompanyContact, ISOMonth, ShiftLike, StatementStatus } from "./types";
import { formatDateDE, formatHours, monthLabelDE, type ShiftInput, asShift } from "./time";

const W = 595.28;
const H = 841.89;
const M = 40;
const WIDTH = W - 2 * M;

const WIN1252: Record<string, number> = {
  "€": 128, "‚": 130, "ƒ": 131, "„": 132, "…": 133, "†": 134, "‡": 135,
  "ˆ": 136, "‰": 137, "Š": 138, "‹": 139, "Œ": 140, "Ž": 142,
  "‘": 145, "’": 146, "“": 147, "”": 148, "•": 149, "–": 150,
  "—": 151, "˜": 152, "™": 153, "š": 154, "›": 155, "œ": 156, "ž": 158, "Ÿ": 159,
};

function latin(s: unknown): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const n = ch.codePointAt(0)!;
    if (n === 10 || n === 13 || n === 9) { out += " "; continue; }
    const code = WIN1252[ch] ?? (n <= 255 ? n : 63);
    out += String.fromCharCode(code);
  }
  return out;
}

function pdfStr(s: unknown): string {
  return "(" + latin(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")";
}

function bytes(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 255;
  return out;
}

/** PDF colour operand "r g b" (0–1). */
type Rgb = string;

function txt(x: number, y: number, s: unknown, size = 10, bold = false, color: Rgb = "0.12 0.23 0.25"): string {
  return "BT " + color + " rg /F" + (bold ? 2 : 1) + " " + size + " Tf 1 0 0 1 " + x.toFixed(2) + " " + y.toFixed(2) + " Tm " + pdfStr(s) + " Tj ET\n";
}
function rect(x: number, y: number, w: number, h: number, color: Rgb): string {
  return color + " rg " + x + " " + y + " " + w + " " + h + " re f\n";
}
function line(x1: number, y1: number, x2: number, y2: number, c: Rgb = "0.82 0.87 0.87"): string {
  return c + " RG 0.7 w " + x1 + " " + y1 + " m " + x2 + " " + y2 + " l S\n";
}

/** Approximate Helvetica width (for right-aligned / centred text). */
function textWidth(s: string, size: number, bold = false): number {
  // Average glyph width ≈ 0.52 em (regular) / 0.56 em (bold) – good enough for layout.
  return latin(s).length * size * (bold ? 0.56 : 0.52);
}

// Helvetica / Helvetica-Bold glyph widths (1/1000 em) for exact right alignment.
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const W_UPPER = [667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611];
const W_UPPER_B = [722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611];
const W_LOWER = [556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500];
const W_LOWER_B = [556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500];
const W_OTHER: Record<string, number> = { " ": 278, ".": 278, ",": 278, ":": 278, ";": 278, "-": 333, "/": 278, "(": 333, ")": 333, "|": 260, "–": 556, "…": 1000 };

/** Width of a text in Helvetica (regular / bold) in pt. */
function measure(s: string, size: number, bold = false): number {
  let units = 0;
  for (const ch of s) {
    const base = ch.normalize("NFD")[0] ?? ch;
    const u = UPPER.indexOf(base);
    const l = LOWER.indexOf(base);
    if (u >= 0) units += (bold ? W_UPPER_B : W_UPPER)[u]!;
    else if (l >= 0) units += (bold ? W_LOWER_B : W_LOWER)[l]!;
    else if (ch >= "0" && ch <= "9") units += 556;
    else units += W_OTHER[ch] ?? 556;
  }
  return (units / 1000) * size;
}

/** Right-aligned text ending at x. */
function txtRight(xRight: number, y: number, s: unknown, size = 10, bold = false, color: Rgb = "0.12 0.23 0.25"): string {
  return txt(xRight - measure(String(s ?? ""), size, bold), y, s, size, bold, color);
}

/** Shortens text with "…" until it fits into maxWidth. */
function fitText(s: string, size: number, bold: boolean, maxWidth: number): string {
  let out = s;
  while (out.length > 1 && measure(out, size, bold) > maxWidth) out = out.slice(0, -2) + "…";
  return out;
}

const WEEKDAY_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
function weekdayOf(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  return Number.isNaN(d.getTime()) ? "" : WEEKDAY_SHORT[d.getUTCDay()] ?? "";
}

function wrapWords(text: unknown, maxChars = 48): string[] {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [""];
  const result: string[] = [];
  let l = "";
  for (let word of words) {
    if ((l + " " + word).trim().length <= maxChars) { l = l ? l + " " + word : word; continue; }
    if (l) { result.push(l); l = ""; }
    while (word.length > maxChars) { result.push(word.slice(0, maxChars)); word = word.slice(maxChars); }
    l = word;
  }
  if (l) result.push(l);
  return result;
}

/** Low-level PDF helpers shared with the invoice PDF (invoicePdf.ts). */
export const pdfPrimitives = { latin, pdfStr, bytes, txt, rect, line, textWidth, wrapWords } as const;

// ---------------------------------------------------------------- colours

interface Palette {
  /** Brand accent (logo colour, rule). */
  accent: Rgb;
  /** Dark accent for headings / totals. */
  strong: Rgb;
  /** Subtitle text. */
  muted: Rgb;
  /** Light tint for table header / total box. */
  tint: Rgb;
  /** Very light tint for zebra rows. */
  zebra: Rgb;
}

/** Fallback colours when the tenant has no valid primary colour. */
const DEFAULT_PALETTE: Palette = {
  accent: "0.000 0.663 0.620",
  strong: "0.03 0.45 0.49",
  muted: "0.12 0.35 0.37",
  tint: "0.88 0.95 0.95",
  zebra: "0.955 0.98 0.98",
};

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbText([r, g, b]: [number, number, number]): Rgb {
  return (r / 255).toFixed(3) + " " + (g / 255).toFixed(3) + " " + (b / 255).toFixed(3);
}
function mix(c: [number, number, number], target: number, amount: number): [number, number, number] {
  return [c[0] + (target - c[0]) * amount, c[1] + (target - c[1]) * amount, c[2] + (target - c[2]) * amount];
}

/** Palette derived from the tenant primary colour (#RRGGBB). */
export function paletteFromPrimary(primaryColor: string | null | undefined): Palette {
  const base = hexToRgb(primaryColor ?? "");
  if (!base) return DEFAULT_PALETTE;
  return {
    accent: rgbText(base),
    strong: rgbText(mix(base, 0, 0.3)),
    muted: rgbText(mix(base, 40, 0.55)),
    tint: rgbText(mix(base, 255, 0.88)),
    zebra: rgbText(mix(base, 255, 0.955)),
  };
}

// ---------------------------------------------------------------- arguments

export interface StatementPdfTenant {
  /** Company name used for the typographic logo and the footer. */
  name: string;
  /** #RRGGBB accent colour. */
  primaryColor?: string | null;
  contact?: Partial<Pick<CompanyContact, "legalName" | "street" | "postalCode" | "city" | "phone" | "email" | "website">> | null;
  /** Short prefix for file names (defaults to a cleaned company name). */
  filePrefix?: string;
  /** Uploaded company logo, already converted to baseline JPEG. */
  logo?: StatementPdfLogo | null;
}

/** A JPEG image (DCTDecode) – the browser converts PNG/SVG/WebP logos via canvas (apps/shared/statement.ts). */
export interface StatementPdfLogo {
  jpeg: Uint8Array;
  /** Pixel size of the JPEG. */
  width: number;
  height: number;
}

/** Pixel size and colour components of a JPEG (SOF0–SOF15 marker), or null when it is not a usable JPEG. */
export function jpegInfo(data: Uint8Array): { width: number; height: number; components: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (data[i + 2]! << 8) | data[i + 3]!;
    // SOFn except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (data[i + 5]! << 8) | data[i + 6]!;
      const width = (data[i + 7]! << 8) | data[i + 8]!;
      const components = data[i + 9]!;
      if (!width || !height || ![1, 3].includes(components)) return null;
      return { width, height, components };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Fits w×h into the box (keeps the aspect ratio). */
function fit(w: number, h: number, maxW: number, maxH: number): [number, number] {
  const k = Math.min(maxW / w, maxH / h);
  return [w * k, h * k];
}

export interface StatementPdfAccount {
  /** e.g. "2026/27" or "2027". */
  cycleLabel: string;
  model?: "school-year" | "calendar-year";
  workedMinutes: number;
  eligibleMinutes: number;
  allocatedMinutes: number;
  billingMinutes: number;
  balanceMinutes: number;
  openingMinutes: number;
  /** Last day of the cycle (school year: last school day). */
  cycleEnd?: string | null;
  /** School year only. */
  summerStart?: string | null;
  /** Prints "TEST" markers as in the legacy pilot phase. */
  test?: boolean;
}

export interface StatementPdfArgs {
  tenant: StatementPdfTenant;
  employee: { name: string; personnelNumber: string };
  month: ISOMonth;
  entries: readonly (ShiftInput & { note?: string | null })[];
  /** Optional cross-check: must match the sum of the entries (±1 min). */
  totals?: { workedMinutes: number } | null;
  account?: StatementPdfAccount | null;
  status?: StatementStatus | null;
  /** Demo / test data: watermark banner and footer (legacy `test`). */
  test?: boolean;
  /** Creation date printed in the footer (default: now). */
  createdAt?: Date;
  /** Product name printed in the footer (e.g. "Schichtklar24"); omitted when empty. */
  productName?: string | null;
}

const STATUS_LABEL: Record<StatementStatus, string> = {
  draft: "Entwurf",
  submitted: "Eingereicht",
  approved: "Freigegeben",
  returned: "Zur Korrektur zurückgegeben",
  reopened: "Wieder geöffnet",
};

/** Legacy `hours(r)` in minutes: (end − start) mod 1440 − pause. */
function entryMinutes(r: ShiftLike): number {
  const tm = (t: string) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
  let diff = tm(r.end) - tm(r.start);
  if (diff < 0) diff += 1440;
  return diff - Number(r.pause || 0);
}

function checkAccount(acc: StatementPdfAccount): void {
  const fields = ["workedMinutes", "eligibleMinutes", "allocatedMinutes", "billingMinutes", "balanceMinutes", "openingMinutes"] as const;
  if (fields.some((k) => !Number.isSafeInteger(acc[k])) ||
      acc.allocatedMinutes < 0 || acc.billingMinutes < 0 ||
      acc.billingMinutes + acc.allocatedMinutes !== acc.workedMinutes ||
      acc.allocatedMinutes > acc.eligibleMinutes ||
      acc.eligibleMinutes > acc.workedMinutes ||
      !acc.cycleLabel ||
      (acc.cycleEnd != null && !/^\d{4}-\d{2}-\d{2}$/.test(acc.cycleEnd)) ||
      (acc.summerStart != null && !/^\d{4}-\d{2}-\d{2}$/.test(acc.summerStart)) ||
      (acc.cycleEnd && acc.summerStart && acc.cycleEnd >= acc.summerStart))
    throw new Error("Arbeitszeitkonto kann nicht korrekt in die PDF übernommen werden.");
}

// ---------------------------------------------------------------- generator

/** Raw PDF bytes (useful on servers and in tests). */
export function createStatementPdfBytes(args: StatementPdfArgs): Uint8Array {
  const { tenant, employee, month } = args;
  const test = args.test === true;
  if (!employee || !employee.name || !employee.personnelNumber || !/^\d{4}-\d{2}$/.test(month) || !Array.isArray(args.entries) || !args.entries.length)
    throw new Error("Für diesen Monat sind keine gültigen Arbeitszeiten zum Export vorhanden.");
  const pal = paletteFromPrimary(tenant.primaryColor);
  const records = args.entries.map((e) => ({ ...asShift(e), note: e.note ?? "" }));
  const entries = records.slice().sort((a, b) =>
    String(a.date).localeCompare(String(b.date)) || String(a.start).localeCompare(String(b.start)) || String(a.end).localeCompare(String(b.end)));

  const acc = args.account ?? null;
  if (acc) checkAccount(acc);
  const status = args.status ?? null;

  const headerExtra = test ? 39 : 0;
  const logoInfo = tenant.logo ? jpegInfo(tenant.logo.jpeg) : null;
  const logoSize = logoInfo ? fit(logoInfo.width, logoInfo.height, 150, 46) : null;

  function pageHeader(): string {
    let s = "";
    if (logoSize) {
      // Uploaded logo (top left, max. 150 × 46 pt). No company name next to it: the logo carries it
      // (owner's decision 30.10.2026); the footer still names the company.
      const [lw, lh] = logoSize;
      s += "q " + lw.toFixed(2) + " 0 0 " + lh.toFixed(2) + " " + M + " " + (H - 76 + (46 - lh) / 2).toFixed(2) + " cm /Logo Do Q\n";
    } else {
      // Typographic logo: company name in the primary colour.
      const name = latin(tenant.name).length > 34 ? tenant.name.slice(0, 33) + "…" : tenant.name;
      s += txt(M, H - 50, name, 20, true, pal.accent);
    }
    // Document title (right) and accent rule.
    s += txtRight(W - M, H - 46, "STUNDENNACHWEIS", 15, true, pal.strong);
    s += txtRight(W - M, H - 62, "Arbeitszeitnachweis " + monthLabelDE(month), 9, false, pal.muted);
    s += rect(M, H - 86, WIDTH, 2, pal.accent);
    if (test) {
      s += rect(M, H - 123, WIDTH, 27, "1 0.92 0.73");
      s += txt(M + 10, H - 114, "TESTDATEN - NICHT FUER LOHNABRECHNUNG", 13, true, "0.68 0.13 0.10");
    }
    // Info panel: person, personnel number, period, status.
    const top = H - (108 + headerExtra);
    s += rect(M, top - 64, WIDTH, 64, "0.965 0.97 0.975");
    s += rect(M, top - 64, 3, 64, pal.accent);
    const cols: Array<[string, string, number, Rgb?]> = [
      ["MITARBEITER/IN", employee.name, 175],
      ["PERSONALNUMMER", employee.personnelNumber, 105],
      ["ZEITRAUM", monthLabelDE(month), 105],
      ["STATUS", status ? STATUS_LABEL[status] : "-", 130, status === "returned" ? "0.68 0.13 0.10" : status ? pal.strong : undefined],
    ];
    let cx = M + 16;
    for (const [label, value, width, colour] of cols) {
      s += txt(cx, top - 22, label, 7, true, "0.40 0.45 0.50");
      s += txt(cx, top - 42, fitText(value, 11, true, width - 14), 11, true, colour ?? "0.10 0.14 0.20");
      cx += width;
    }
    return s;
  }

  const widths = [77, 58, 58, 58, 59, 205];
  const heads = ["Datum", "Beginn", "Ende", "Pause", "Std.", "Bemerkung"];
  // Right edge of the hours column (numbers are right-aligned).
  const hoursRight = M + 5 + widths[0]! + widths[1]! + widths[2]! + widths[3]! + widths[4]! - 14;
  const pages: string[][] = [];
  let sections: string[] = [];
  let y = 0;
  function openPage(): void {
    sections = [];
    pages.push(sections);
    sections.push(pageHeader());
    y = H - (212 + headerExtra);
    // Header bar sits directly above the first row (row geometry unchanged).
    sections.push(rect(M, y - 17, WIDTH, 23, pal.strong));
    let x = M + 5;
    for (let j = 0; j < heads.length; j++) {
      if (j === 4) sections.push(txtRight(hoursRight, y - 8, heads[j], 8, true, "1 1 1"));
      else sections.push(txt(x, y - 8, heads[j], 8, true, "1 1 1"));
      x += widths[j]!;
    }
    y -= 21;
    rowIndex = 0;
  }
  let rowIndex = 0;
  openPage();
  let sum = 0;
  let pauseSum = 0;
  const days = new Set<string>();
  for (const r of entries) {
    const minutes = entryMinutes(r);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error("Ungültige Stundenangabe im Eintrag.");
    sum += minutes;
    pauseSum += Number(r.pause || 0);
    days.add(String(r.date));
    const noteLines = wrapWords(r.note || "", 47).slice(0, 8);
    const height = Math.max(28, 14 + noteLines.length * 11);
    if (y - height < 124) openPage();
    // Zebra rows for readability.
    if (rowIndex % 2 === 1) sections.push(rect(M, y - height, WIDTH, height, pal.zebra));
    rowIndex++;
    let x = M + 5;
    const wd = weekdayOf(String(r.date));
    const cols = [(wd ? wd + " " : "") + formatDateDE(r.date), r.start, r.end, String(r.pause) + " min"];
    for (let j = 0; j < cols.length; j++) { sections.push(txt(x, y - 17, cols[j], 8.4, false, "0.10 0.14 0.20")); x += widths[j]!; }
    sections.push(txtRight(hoursRight, y - 17, formatHours(minutes), 8.4, true, "0.10 0.14 0.20"));
    x += widths[4]!;
    for (let j = 0; j < noteLines.length; j++) sections.push(txt(x, y - 17 - j * 11, noteLines[j], 8, false, "0.25 0.30 0.36"));
    sections.push(line(M, y - height, W - M, y - height, "0.88 0.90 0.92"));
    y -= height;
  }
  if (args.totals && Math.abs(sum - args.totals.workedMinutes) > 1)
    throw new Error("Die Monatsstunden stimmen nicht mit dem Stundennachweis überein.");
  if (acc && Math.abs(sum - acc.workedMinutes) > 1)
    throw new Error("Die Monatsstunden im Arbeitszeitkonto stimmen nicht mit dem Stundennachweis überein.");
  if (y < (acc ? 225 : 133)) openPage();
  y -= 24;
  if (acc) {
    // Work shifts stay in the readable full-width table; the account appears
    // only in a separate labelled section.
    const schoolYear = (acc.model ?? "school-year") === "school-year";
    const cycleWord = schoolYear ? "Schuljahr" : "Kalenderjahr";
    sections.push(rect(M, y - 100, WIDTH, 127, pal.tint));
    sections.push(rect(M, y - 100, 3, 127, pal.accent));
    sections.push(txt(M + 12, y + 5, "GESAMT GELEISTET: " + formatHours(sum) + " Stunden", 14, true, pal.strong));
    sections.push(txt(M + 12, y - 16, "ARBEITSZEITKONTO" + (acc.test ? " - TEST" : "") + " | " + cycleWord + " " + acc.cycleLabel, 9, true, "0.14 0.36 0.38"));
    sections.push(txt(M + 12, y - 34, "Ins Konto: " + formatHours(acc.allocatedMinutes) + " Std.   |   Zur Abrechnung vorgemerkt: " +
      formatHours(acc.billingMinutes) + " Std.", 9, false, "0.12 0.23 0.25"));
    sections.push(txt(M + 12, y - 51, (schoolYear ? "Anrechenbare Schulzeit in diesem Monat: " : "Anrechenbare Arbeitszeit in diesem Monat: ") +
      formatHours(acc.eligibleMinutes) + " Std.", 9, false, "0.12 0.23 0.25"));
    sections.push(txt(M + 12, y - 67, "Jahresstand nach diesem Monat: " + formatHours(acc.balanceMinutes) +
      " Std.   |   Start je " + cycleWord + ": " + formatHours(acc.openingMinutes) + " Std.", 8.7, false, "0.12 0.23 0.25"));
    const dates = schoolYear
      ? (acc.cycleEnd ? "Letzter Schultag: " + formatDateDE(acc.cycleEnd) : "") +
        (acc.summerStart ? "   |   Sommerferien ab " + formatDateDE(acc.summerStart) : "")
      : acc.cycleEnd ? "Ende des Kontozeitraums: " + formatDateDE(acc.cycleEnd) : "";
    if (dates) sections.push(txt(M + 12, y - 84, dates, 8, false, "0.24 0.33 0.35"));
    sections.push(txt(M + 12, y - 95, "Neues " + cycleWord + ": erneut " + formatHours(acc.openingMinutes) +
      " Std. | Vorjahr bleibt dokumentiert | Keine verbindliche Lohnverrechnung.", 7, false, "0.35 0.36 0.36"));
  } else {
    // Summary block: total, number of shifts, working days and breaks.
    sections.push(rect(M, y - 26, WIDTH, 53, pal.tint));
    sections.push(rect(M, y - 26, 3, 53, pal.accent));
    sections.push(txt(M + 14, y + 6, "GESAMT: " + formatHours(sum) + " Stunden", 15, true, pal.strong));
    sections.push(txt(M + 14, y - 13, "Einsätze: " + entries.length + "   |   Arbeitstage: " + days.size + "   |   Pausen gesamt: " +
      formatHours(pauseSum) + " Std.", 8.5, false, "0.20 0.26 0.32"));
  }

  const created = (args.createdAt ?? new Date());
  // Same as legacy toLocaleDateString("de-DE"): no zero padding (5.1.2026).
  const createdText = created.getDate() + "." + (created.getMonth() + 1) + "." + created.getFullYear();
  const contact = tenant.contact ?? null;
  const contactParts = contact
    ? [contact.legalName || tenant.name,
      [contact.street, [contact.postalCode, contact.city].filter(Boolean).join(" ")].filter(Boolean).join(", "),
      contact.phone ? "Tel. " + contact.phone : "", contact.email ?? ""].filter(Boolean)
    : [tenant.name];
  const contactLine = contactParts.join("  |  ");
  const product = args.productName ? String(args.productName) : "";
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p]!;
    if (logoInfo) {
      // Uploaded logo, large and faint in the middle of every page as watermark. Drawn last: the
      // tinted table rows would otherwise cover it (a JPEG has no transparency).
      const [ww, wh] = fit(logoInfo.width, logoInfo.height, 380, 380);
      page.push("q /GSWatermark gs " + ww.toFixed(2) + " 0 0 " + wh.toFixed(2) + " " + ((W - ww) / 2).toFixed(2) + " " + ((H - wh) / 2).toFixed(2) + " cm /Logo Do Q\n");
    }
    page.push(line(M, 62, W - M, 62, "0.80 0.83 0.86"));
    page.push(txt(M, 46, "Erstellt: " + createdText, 8, false, "0.25 0.30 0.36"));
    if (product) {
      const label = "Erstellt mit " + product;
      page.push(txt((W - measure(label, 8)) / 2, 46, label, 8, false, "0.40 0.45 0.50"));
    }
    page.push(txtRight(W - M, 46, "Seite " + (p + 1) + " von " + pages.length, 8, true, "0.25 0.30 0.36"));
    page.push(txt(M, test ? 20 : 31, contactLine.length > 120 ? contactLine.slice(0, 119) + "…" : contactLine, 7, false, "0.35 0.36 0.36"));
    if (test) page.push(txt(M, 31, "TESTVERSION - kein offizieller Arbeitszeitnachweis", 8, true, "0.64 0.13 0.10"));
  }

  const objects: Record<number, string> = {};
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = "<< /Type /ExtGState /ca 0.085 /CA 0.085 >>";
  const pageRefs: string[] = [];
  let n = 6;
  let xobjects = "";
  if (logoInfo) {
    const id = n++;
    let raw = "";
    for (const b of tenant.logo!.jpeg) raw += String.fromCharCode(b);
    objects[id] = "<< /Type /XObject /Subtype /Image /Width " + logoInfo.width + " /Height " + logoInfo.height +
      " /ColorSpace /" + (logoInfo.components === 1 ? "DeviceGray" : "DeviceRGB") + " /BitsPerComponent 8 /Filter /DCTDecode /Length " +
      raw.length + " >>\nstream\n" + raw + "\nendstream";
    xobjects = " /XObject << /Logo " + id + " 0 R >>";
  }
  for (const p of pages) {
    const pg = n++;
    const streamId = n++;
    const body = p.join("");
    pageRefs.push(pg + " 0 R");
    objects[pg] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /GSWatermark 5 0 R >>" + xobjects + " >> /Contents " + streamId + " 0 R >>";
    objects[streamId] = "<< /Length " + bytes(body).length + " >>\nstream\n" + body + "\nendstream";
  }
  objects[2] = "<< /Type /Pages /Kids [" + pageRefs.join(" ") + "] /Count " + pages.length + " >>";
  let output = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [0];
  for (let id = 1; id < n; id++) {
    offsets[id] = output.length; // one char = one byte (latin-1 binary string)
    output += id + " 0 obj\n" + objects[id] + "\nendobj\n";
  }
  const start = output.length;
  output += "xref\n0 " + n + "\n0000000000 65535 f \n";
  for (let id = 1; id < n; id++) output += String(offsets[id]).padStart(10, "0") + " 00000 n \n";
  output += "trailer\n<< /Size " + n + " /Root 1 0 R >>\nstartxref\n" + start + "\n%%EOF\n";
  return bytes(output);
}

/** The statement as a PDF Blob (application/pdf). */
export function createStatementPdf(args: StatementPdfArgs): Blob {
  const data = createStatementPdfBytes(args);
  return new Blob([data.buffer as ArrayBuffer], { type: "application/pdf" });
}

/**
 * File name "<prefix>-Stundenzettel-<personnel number>-<month>.pdf" like the old app
 * (with "TEST-" for test data). Prefix: tenant.filePrefix, otherwise the cleaned company name.
 */
export function statementFileName(args: { tenant: Pick<StatementPdfTenant, "name" | "filePrefix">; personnelNumber: string; month: ISOMonth; test?: boolean }): string {
  const clean = (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, "");
  const ascii = (s: string) => s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss");
  const prefix = clean(args.tenant.filePrefix ?? ascii(args.tenant.name).replace(/\s+/g, "-")).slice(0, 40) || "Zeiterfassung";
  return prefix + "-" + (args.test ? "TEST-" : "") + "Stundenzettel-" + clean(args.personnelNumber) + "-" + args.month + ".pdf";
}

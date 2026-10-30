/**
 * Invoices of the platform (decision of the client, 28.10.2026; database:
 * db/migrations/0019_invoices.sql). Pure functions: amounts in integer cents,
 * VAT rounded half away from zero (like PostgreSQL round(numeric)), invoice
 * numbers "<prefix>-<year>-<6 digits>", and the invoice PDF (A4, multi-page
 * when there are many lines, watermark "Entwurf – Pflichtangaben fehlen" for
 * drafts). No sending, no payment processing, no external service.
 */
import type { BillingCondition, ISODate, ISOMonth, UUID } from "./types";
import { pdfPrimitives } from "./pdf";
import { formatEuro } from "./billing";

const { pdfStr, bytes, txt, rect, line, textWidth, wrapWords } = pdfPrimitives;

/** Default VAT rate (to be confirmed by the client). */
export const DEFAULT_VAT_RATE_PERCENT = 19;
export const DEFAULT_PAYMENT_TERMS_DAYS = 14;
export const DEFAULT_INVOICE_PREFIX = "SW";
export const VAT_CONFIRMATION_NOTE = "USt-Satz vom Auftraggeber zu bestätigen";
export const DRAFT_WATERMARK = "Entwurf – Pflichtangaben fehlen";

/** Platform invoice settings (super-admin) – issuer data for § 14 UStG. */
export interface InvoiceSettings {
  issuerName: string;
  issuerStreet: string;
  issuerPostalCode: string;
  issuerCity: string;
  issuerCountry: string;
  issuerEmail: string | null;
  issuerPhone: string | null;
  taxNumber: string | null;
  vatId: string | null;
  paymentDetails: string | null;
  vatRatePercent: number;
  vatRateConfirmed: boolean;
  paymentTermsDays: number;
  numberPrefix: string;
  /** Missing mandatory data (German labels); empty = complete. */
  missing: string[];
  updatedAt?: string | null;
}

export type InvoiceSettingsPatch = Partial<Omit<InvoiceSettings, "missing" | "updatedAt">>;

export type InvoiceIssuer = Omit<InvoiceSettings, "missing" | "updatedAt" | "vatRatePercent" | "vatRateConfirmed" | "paymentTermsDays" | "numberPrefix">;

export interface InvoiceRecipient {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  contactPerson: string | null;
  /** Customer number = tenant slug. */
  customerNumber: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

/** Invoice content (stored invoice or draft). */
export interface InvoiceData {
  tenantId: UUID;
  month: ISOMonth;
  issueDate: ISODate;
  servicePeriodStart: ISODate;
  servicePeriodEnd: ISODate;
  paymentTermsDays: number;
  dueDate: ISODate;
  issuer: InvoiceIssuer;
  recipient: InvoiceRecipient;
  lines: InvoiceLine[];
  netCents: number;
  vatRatePercent: number;
  vatRateConfirmed: boolean;
  vatCents: number;
  grossCents: number;
  currency: "EUR";
}

/** Preview without number (nothing stored). */
export interface InvoiceDraft extends InvoiceData {
  draft: true;
  number: null;
  billingStatus: string;
  final: boolean;
  condition: BillingCondition;
  missing: string[];
}

export interface Invoice extends InvoiceData {
  id: UUID;
  kind: "invoice" | "cancellation";
  number: string;
  tenantName?: string | null;
  cancelsInvoiceId: UUID | null;
  cancelsInvoiceNumber?: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  cancelledByInvoiceId: UUID | null;
  createdAt: string;
}

// ------------------------------------------------------------------ calculation

/** VAT in cents, rounded half away from zero (PostgreSQL round(numeric)). */
export function vatCents(netCents: number, ratePercent: number): number {
  if (!Number.isInteger(netCents)) throw new Error("Nettobetrag muss in ganzen Cent angegeben werden.");
  if (!(ratePercent >= 0 && ratePercent <= 100)) throw new Error("USt-Satz muss zwischen 0 und 100 % liegen.");
  // work in hundredths of a percent to avoid floating point surprises
  const bp = Math.round(ratePercent * 100);
  const raw = netCents * bp; // cents × 1/10000
  const abs = Math.abs(raw);
  const q = Math.floor(abs / 10000);
  const r = abs % 10000;
  const rounded = r >= 5000 ? q + 1 : q;
  return raw < 0 ? -rounded : rounded;
}

/**
 * VAT contained in a gross amount, rounded half away from zero (PostgreSQL round):
 * round(gross × rate / (100 + rate)). Prices are gross since 30.10.2026 (migration 0022).
 */
export function vatFromGross(grossCents: number, ratePercent: number): number {
  if (!Number.isInteger(grossCents)) throw new Error("Bruttobetrag muss in ganzen Cent angegeben werden.");
  if (!(ratePercent >= 0 && ratePercent <= 100)) throw new Error("USt-Satz muss zwischen 0 und 100 % liegen.");
  const bp = Math.round(ratePercent * 100);
  const num = Math.abs(grossCents) * bp;
  const den = 10000 + bp;
  const q = Math.floor(num / den);
  const rounded = (num - q * den) * 2 >= den ? q + 1 : q;
  return grossCents < 0 ? -rounded : rounded;
}

/** Net, VAT and gross of invoice lines whose amounts are gross (incl. VAT). */
export function invoiceTotals(lines: ReadonlyArray<Pick<InvoiceLine, "amountCents">>, ratePercent: number): { netCents: number; vatCents: number; grossCents: number } {
  const gross = lines.reduce((s, l) => s + l.amountCents, 0);
  const vat = vatFromGross(gross, ratePercent);
  return { netCents: gross - vat, vatCents: vat, grossCents: gross };
}

/** Invoices issued before 30.10.2026 list net line amounts; later ones gross amounts. */
export function linesAreGross(inv: Pick<InvoiceData, "lines" | "netCents" | "grossCents">): boolean {
  return inv.lines.reduce((s, l) => s + l.amountCents, 0) === inv.grossCents;
}

/** "SW-2026-000001" */
export function formatInvoiceNumber(prefix: string, year: number, seq: number): string {
  if (!/^[A-Z]{1,6}$/.test(prefix)) throw new Error("Präfix: 1–6 Großbuchstaben.");
  if (!Number.isInteger(seq) || seq < 1 || seq > 999999) throw new Error("Laufende Nummer 1–999999.");
  return `${prefix}-${year}-${String(seq).padStart(6, "0")}`;
}

/** Missing mandatory issuer data (§ 14 Abs. 4 UStG) – same rule as private.invoice_issuer_missing. */
export function missingIssuerData(s: Pick<InvoiceSettings, "issuerName" | "issuerStreet" | "issuerPostalCode" | "issuerCity" | "taxNumber" | "vatId">): string[] {
  const out: string[] = [];
  if (!s.issuerName.trim()) out.push("Name des Rechnungsstellers");
  if (!s.issuerStreet.trim() || !s.issuerPostalCode.trim() || !s.issuerCity.trim()) out.push("Anschrift des Rechnungsstellers");
  if (!(s.taxNumber ?? "").trim() && !(s.vatId ?? "").trim()) out.push("Steuernummer oder USt-IdNr.");
  return out;
}

export function addDaysISO(date: ISODate, days: number): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const dateDE = (d: ISODate) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const percentDE = (p: number) => (Number.isInteger(p) ? String(p) : p.toFixed(2).replace(".", ",").replace(/0$/, "")) + " %";

// ------------------------------------------------------------------ PDF

const W = 595.28;
const H = 841.89;
const M = 50;
const INK = "0.12 0.16 0.20";
const MUTED = "0.38 0.42 0.46";
const ACCENT = "0.10 0.33 0.45";
const TINT = "0.93 0.95 0.97";

export interface InvoicePdfArgs {
  invoice: InvoiceData & { number: string | null; kind?: "invoice" | "cancellation"; cancelsInvoiceNumber?: string | null; cancelReason?: string | null };
  /** Draft (no number): watermark "Entwurf – Pflichtangaben fehlen" on every page. */
  draft?: boolean;
  missing?: string[];
}

function right(x: number, y: number, s: string, size: number, bold = false, color = INK): string {
  return txt(x - textWidth(s, size, bold), y, s, size, bold, color);
}

function watermark(text: string): string {
  // rotated, light grey, centred
  const size = 34;
  const w = textWidth(text, size, true);
  const a = Math.PI / 5;
  const cos = Math.cos(a).toFixed(4);
  const sin = Math.sin(a).toFixed(4);
  const x = W / 2 - (w / 2) * Math.cos(a);
  const y = H / 2 - (w / 2) * Math.sin(a);
  return "q /GSWatermark gs BT 0.75 0.10 0.10 rg /F2 " + size + " Tf " + cos + " " + sin + " -" + sin + " " + cos + " " +
    x.toFixed(2) + " " + y.toFixed(2) + " Tm " + pdfStr(text) + " Tj ET Q\n";
}

/** Invoice as PDF bytes (A4; table continues on further pages; "Seite x von y"). */
export function createInvoicePdfBytes(args: InvoicePdfArgs): Uint8Array {
  const inv = args.invoice;
  const draft = !!args.draft || inv.number === null;
  const cancellation = inv.kind === "cancellation";
  const title = cancellation ? "Stornorechnung" : "Rechnung";
  const number = inv.number ?? "ENTWURF";
  const iss = inv.issuer;
  const gross = linesAreGross(inv);
  const pages: string[][] = [];
  let page: string[] = [];
  const issuerLine = [iss.issuerName, iss.issuerStreet, [iss.issuerPostalCode, iss.issuerCity].filter(Boolean).join(" ")].filter(Boolean).join(" · ");

  const header = (first: boolean): number => {
    page.push(rect(0, H - 8, W, 8, ACCENT));
    page.push(txt(M, H - 50, iss.issuerName || "Rechnungssteller (fehlt)", 15, true, ACCENT));
    if (!first) {
      page.push(right(W - M, H - 50, `${title} ${number} – Fortsetzung`, 10, true));
      page.push(line(M, H - 62, W - M, H - 62));
      return H - 90;
    }
    page.push(txt(M, H - 66, [iss.issuerStreet, [iss.issuerPostalCode, iss.issuerCity].filter(Boolean).join(" ")].filter(Boolean).join(", "), 9, false, MUTED));
    // recipient block
    page.push(txt(M, H - 120, issuerLine.length > 95 ? issuerLine.slice(0, 94) + "…" : issuerLine, 7, false, MUTED));
    page.push(line(M, H - 124, M + 250, H - 124));
    const r = inv.recipient;
    const rec = [r.name, r.contactPerson ? "z. Hd. " + r.contactPerson : "", r.street, [r.postalCode, r.city].filter(Boolean).join(" ")].filter(Boolean);
    rec.forEach((l, i) => page.push(txt(M, H - 140 - i * 14, l, 10.5, i === 0)));
    // meta block (right)
    const meta: Array<[string, string]> = [
      [cancellation ? "Stornonummer" : "Rechnungsnummer", number],
      ["Rechnungsdatum", dateDE(inv.issueDate)],
      ["Leistungszeitraum", `${dateDE(inv.servicePeriodStart)} – ${dateDE(inv.servicePeriodEnd)}`],
      ["Kundennummer", r.customerNumber],
    ];
    if (!cancellation) meta.push(["Zahlungsziel", `${dateDE(inv.dueDate)} (${inv.paymentTermsDays} Tage)`]);
    meta.forEach(([k, v], i) => {
      page.push(txt(W - M - 230, H - 120 - i * 15, k, 9, false, MUTED));
      page.push(right(W - M, H - 120 - i * 15, v, 9.5, true));
    });
    page.push(txt(M, H - 230, `${title} ${number}`, 18, true, ACCENT));
    let y = H - 252;
    if (cancellation && inv.cancelsInvoiceNumber) {
      page.push(txt(M, y, `Storno zur Rechnung ${inv.cancelsInvoiceNumber}` + (inv.cancelReason ? ` – Grund: ${inv.cancelReason}` : ""), 9.5, false, INK));
      y -= 16;
    }
    return y - 10;
  };

  const tableHeader = (y: number): number => {
    page.push(rect(M, y - 6, W - 2 * M, 22, TINT));
    page.push(txt(M + 8, y + 2, "Pos.", 9, true));
    page.push(txt(M + 44, y + 2, "Beschreibung", 9, true));
    page.push(right(W - M - 190, y + 2, "Menge", 9, true));
    page.push(right(W - M - 95, y + 2, gross ? "Einzelpreis brutto" : "Einzelpreis", 9, true));
    page.push(right(W - M - 8, y + 2, gross ? "Betrag brutto" : "Betrag netto", 9, true));
    return y - 26;
  };

  let y = header(true);
  y = tableHeader(y);
  const BOTTOM = 190; // room for totals / footer on the last page; continued pages use 110
  inv.lines.forEach((l, i) => {
    const desc = wrapWords(l.description, 46);
    const need = desc.length * 13 + 8;
    if (y - need < 110) {
      pages.push(page);
      page = [];
      y = tableHeader(header(false));
    }
    page.push(txt(M + 8, y, String(i + 1), 9.5));
    desc.forEach((d, k) => page.push(txt(M + 44, y - k * 13, d, 9.5)));
    page.push(right(W - M - 190, y, String(l.quantity), 9.5));
    page.push(right(W - M - 95, y, formatEuro(l.unitPriceCents), 9.5));
    page.push(right(W - M - 8, y, formatEuro(l.amountCents), 9.5));
    y -= need;
    page.push(line(M, y + 6, W - M, y + 6, "0.88 0.90 0.92"));
  });

  if (y < BOTTOM) {
    pages.push(page);
    page = [];
    y = header(false);
  }
  // totals
  const tx = W - M - 230;
  const totals: Array<[string, string, boolean]> = [
    ["Summe netto", formatEuro(inv.netCents), false],
    [`${gross ? "enthaltene " : ""}Umsatzsteuer ${percentDE(inv.vatRatePercent)}`, formatEuro(inv.vatCents), false],
    ["Gesamtbetrag brutto", formatEuro(inv.grossCents), true],
  ];
  y -= 8;
  totals.forEach(([k, v, bold], i) => {
    const yy = y - i * 17;
    if (bold) page.push(rect(tx - 8, yy - 6, W - M - tx + 8, 20, TINT));
    page.push(txt(tx, yy, k, bold ? 10.5 : 9.5, bold));
    page.push(right(W - M - 8, yy, v, bold ? 10.5 : 9.5, bold));
  });
  y -= totals.length * 17 + 14;
  const notes: string[] = [];
  if (!inv.vatRateConfirmed) notes.push(`Hinweis: ${VAT_CONFIRMATION_NOTE}.`);
  if (!cancellation) {
    notes.push(`Bitte überweisen Sie den Gesamtbetrag bis zum ${dateDE(inv.dueDate)} unter Angabe der Rechnungsnummer ${number}.`);
    if (iss.paymentDetails) notes.push(iss.paymentDetails);
  } else {
    notes.push("Diese Stornorechnung hebt die genannte Rechnung vollständig auf.");
  }
  notes.push(`Abrechnung je abrechenbarer Person und Monat${gross ? ", Preise inkl. gesetzlicher USt." : ""}; die Rechnung enthält keine personenbezogenen Daten von Mitarbeitenden.`);
  for (const n of notes) {
    for (const l of wrapWords(n, 100)) {
      if (y < 90) { pages.push(page); page = []; y = header(false); }
      page.push(txt(M, y, l, 8.5, false, MUTED));
      y -= 12;
    }
  }
  if (draft && args.missing?.length) {
    y -= 6;
    for (const l of wrapWords("Fehlende Pflichtangaben: " + args.missing.join(", "), 100)) {
      if (y < 90) { pages.push(page); page = []; y = header(false); }
      page.push(txt(M, y, l, 9, true, "0.68 0.13 0.10"));
      y -= 13;
    }
  }
  pages.push(page);

  // footer + watermark on every page
  const footer = [
    [iss.issuerName, iss.issuerStreet, [iss.issuerPostalCode, iss.issuerCity].filter(Boolean).join(" "), iss.issuerCountry].filter(Boolean).join(" · "),
    [iss.taxNumber ? "Steuernummer " + iss.taxNumber : "", iss.vatId ? "USt-IdNr. " + iss.vatId : "", iss.issuerEmail ?? "", iss.issuerPhone ? "Tel. " + iss.issuerPhone : ""].filter(Boolean).join(" · "),
  ].filter(Boolean);
  pages.forEach((p, i) => {
    p.push(line(M, 62, W - M, 62));
    footer.forEach((f, k) => p.push(txt(M, 48 - k * 11, f.length > 120 ? f.slice(0, 119) + "…" : f, 7.5, false, MUTED)));
    p.push(right(W - M, 48, `Seite ${i + 1} von ${pages.length}`, 7.5, false, MUTED));
    if (draft) p.unshift(watermark(DRAFT_WATERMARK));
  });

  const objects: Record<number, string> = {};
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = "<< /Type /ExtGState /ca 0.18 /CA 0.18 >>";
  const refs: string[] = [];
  let n = 6;
  for (const p of pages) {
    const pg = n++;
    const st = n++;
    const body = p.join("");
    refs.push(pg + " 0 R");
    objects[pg] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /GSWatermark 5 0 R >> >> /Contents " + st + " 0 R >>";
    objects[st] = "<< /Length " + bytes(body).length + " >>\nstream\n" + body + "\nendstream";
  }
  objects[2] = "<< /Type /Pages /Kids [" + refs.join(" ") + "] /Count " + pages.length + " >>";
  const info = n++;
  objects[info] = "<< /Title " + pdfStr(`${title} ${number}`) + " /Producer (Stundenwerk) >>";
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [0];
  for (let id = 1; id < n; id++) {
    offsets[id] = out.length;
    out += id + " 0 obj\n" + objects[id] + "\nendobj\n";
  }
  const start = out.length;
  out += "xref\n0 " + n + "\n0000000000 65535 f \n";
  for (let id = 1; id < n; id++) out += String(offsets[id]).padStart(10, "0") + " 00000 n \n";
  out += "trailer\n<< /Size " + n + " /Root 1 0 R /Info " + info + " 0 R >>\nstartxref\n" + start + "\n%%EOF\n";
  return bytes(out);
}

export function createInvoicePdf(args: InvoicePdfArgs): Blob {
  const data = createInvoicePdfBytes(args);
  return new Blob([data.buffer as ArrayBuffer], { type: "application/pdf" });
}

/** "Rechnung-SW-2026-000001.pdf" / "Rechnungsentwurf-<slug>-2026-09.pdf" */
export function invoiceFileName(inv: { number: string | null; kind?: "invoice" | "cancellation"; month: ISOMonth; recipient: { customerNumber: string } }): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "");
  if (!inv.number) return `Rechnungsentwurf-${clean(inv.recipient.customerNumber)}-${inv.month}.pdf`;
  return `${inv.kind === "cancellation" ? "Stornorechnung" : "Rechnung"}-${clean(inv.number)}.pdf`;
}

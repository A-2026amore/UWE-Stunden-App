import { describe, expect, it } from "vitest";
import { loadPdf } from "./support/load-legacy";
import { inspectPdf } from "./support/pdf-inspect";
import type { PdfAccount, PdfArgs, Shift } from "./support/legacy-types";

const pdf = loadPdf({ now: "2026-11-20T10:00:00+01:00" });
const employee = { name: "Jörg Prüfer-Testmann", eid: "E1001" };

function entries(n: number, month = "2026-11"): Shift[] {
  // 8 h shifts with 30 min pause -> 7,50 h each; up to two shifts per day for many entries.
  return Array.from({ length: n }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, "0");
    const late = i >= 28;
    return {
      id: "e" + i,
      date: `${month}-${day}`,
      start: late ? "16:00" : "06:00",
      end: late ? "23:59" : "14:00",
      pause: late ? 29 : 30,
      note: i % 5 === 0 ? "Schülertour (Linie 7) – Rückfahrt" : "",
    };
  });
}

async function build(args: Partial<PdfArgs> & { records: Shift[] }) {
  const blob = pdf.createBlob({ employee, month: "2026-11", test: false, ...args });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { blob, bytes, info: inspectPdf(bytes) };
}

describe("UweTimesheetPdf.createBlob", () => {
  it("produces a structurally valid PDF (header, xref offsets, stream lengths, trailer)", async () => {
    const { blob, bytes, info } = await build({ records: entries(3) });
    expect(blob.type).toBe("application/pdf");
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(info.header).toBe("%PDF-1.4");
    expect(info.problems).toEqual([]);
    expect(info.pageCount).toBe(1);
  });

  it("the structural checker itself detects a broken xref (guards against a vacuous check)", async () => {
    const { bytes } = await build({ records: entries(3) });
    const broken = Buffer.from(Buffer.from(bytes).toString("latin1").replace(/\n(\d{10}) 00000 n/, "\n0000000001 00000 n"), "latin1");
    expect(inspectPdf(broken).problems.length).toBeGreaterThan(0);
  });

  it("splits 60 entries over several pages (multi-page is a hard business requirement)", async () => {
    const { info } = await build({ records: entries(60) });
    expect(info.problems).toEqual([]);
    expect(info.pageCount).toBeGreaterThan(1);
    expect(info.pageCount).toBeGreaterThanOrEqual(3);
    // Every page repeats header and table head and is numbered.
    const n = info.pageCount;
    expect(info.texts.filter((t) => t === "STUNDENNACHWEIS")).toHaveLength(n);
    expect(info.texts.filter((t) => t === "Datum")).toHaveLength(n);
    for (let p = 1; p <= n; p++) expect(info.texts).toContain(`Seite ${p} von ${n}`);
    // Every entry is printed exactly once.
    const dates = info.texts.filter((t) => /^\d{2}\.11\.2026$/.test(t));
    expect(dates).toHaveLength(60);
  });

  it("contains employee name, personnel number, month and totals", async () => {
    const records = entries(4);
    const { info } = await build({ records });
    expect(info.texts).toContain("Mitarbeiter: Jörg Prüfer-Testmann");
    expect(info.texts).toContain("Personalnummer: E1001");
    expect(info.texts).toContain("Monat: 11-2026");
    expect(info.texts).toContain("GESAMT: 30,00 Stunden");
    expect(info.texts).toContain("7,50");
    expect(info.texts).toContain("30 min");
    expect(info.texts).toContain("Erstellt: 20.11.2026");
  });

  it("sorts entries by date/start and handles midnight shifts", async () => {
    const records: Shift[] = [
      { date: "2026-11-12", start: "22:00", end: "06:00", pause: 30, note: "" },
      { date: "2026-11-03", start: "08:00", end: "12:00", pause: 0, note: "" },
    ];
    const { info } = await build({ records });
    const dates = info.texts.filter((t) => /^\d{2}\.11\.2026$/.test(t));
    expect(dates).toEqual(["03.11.2026", "12.11.2026"]);
    expect(info.texts).toContain("GESAMT: 11,50 Stunden");
  });

  it("escapes parentheses/backslashes in notes and encodes umlauts as WinAnsi", async () => {
    const { bytes, info } = await build({ records: [{ date: "2026-11-02", start: "08:00", end: "12:00", pause: 0, note: "Tour (A) \\ Größe €" }] });
    expect(info.problems).toEqual([]);
    expect(info.texts).toContain("Tour (A) \\ Größe \x80");
    // ö is 0xF6 in WinAnsi, not UTF-8 0xC3 0xB6
    expect(Buffer.from(bytes).includes(Buffer.from([0xc3, 0xb6]))).toBe(false);
  });

  it("test flag adds watermark/test texts; production PDF has none", async () => {
    const test = await build({ records: entries(30), test: true });
    expect(test.info.texts).toContain("TESTDATEN - NICHT FUER LOHNABRECHNUNG");
    const footers = test.info.texts.filter((t) => t === "TESTVERSION - kein offizieller Arbeitszeitnachweis");
    expect(footers).toHaveLength(test.info.pageCount);
    const prod = await build({ records: entries(30), test: false });
    expect(prod.info.texts.some((t) => /TEST/.test(t))).toBe(false);
    // Both carry the transparent UWE wing watermark graphic state on every page.
    expect(Buffer.from(prod.bytes).toString("latin1").match(/\/GSWatermark gs/g)).toHaveLength(prod.info.pageCount);
  });

  it("prints the test work-account section when a consistent account is passed", async () => {
    const records = entries(4); // 30 h
    const account: PdfAccount = {
      test: true, schoolYear: "2026/27", schoolStart: "2026-09-02", schoolEnd: "2027-07-16", summerStart: "2027-07-19",
      workedMinutes: 1800, eligibleMinutes: 1800, allocatedMinutes: 1200, billingMinutes: 600, balanceMinutes: -4800, initialMinutes: -6000,
    };
    const { info } = await build({ records, test: true, account });
    expect(info.problems).toEqual([]);
    expect(info.texts).toContain("GESAMT GELEISTET: 30,00 Stunden");
    expect(info.texts).toContain("ARBEITSZEITKONTO - TEST | Schuljahr 2026/27");
    expect(info.texts.some((t) => t.includes("Ins Konto: 20,00 Std.") && t.includes("Zur Abrechnung vorgemerkt: 10,00 Std."))).toBe(true);
    expect(info.texts.some((t) => t.startsWith("Jahresstand nach diesem Monat: -80,00 Std."))).toBe(true);
    expect(info.texts.some((t) => t.includes("Letzter Schultag: 16.07.2027"))).toBe(true);
  });

  it("rejects inconsistent account figures instead of printing wrong numbers", () => {
    const base: PdfAccount = {
      test: true, schoolYear: "2026/27", schoolStart: "2026-09-02", schoolEnd: "2027-07-16", summerStart: "2027-07-19",
      workedMinutes: 1800, eligibleMinutes: 1800, allocatedMinutes: 1200, billingMinutes: 600, balanceMinutes: -4800, initialMinutes: -6000,
    };
    const records = entries(4);
    expect(() => pdf.createBlob({ employee, month: "2026-11", records, account: { ...base, billingMinutes: 700 } })).toThrow(/Arbeitszeitkonto/);
    expect(() => pdf.createBlob({ employee, month: "2026-11", records, account: { ...base, workedMinutes: 2400, eligibleMinutes: 2400, billingMinutes: 1200 } })).toThrow(/stimmen nicht/);
  });

  it("rejects missing data, bad month and invalid entries", () => {
    expect(() => pdf.createBlob({ employee, month: "2026-11", records: [] })).toThrow(/keine gültigen Arbeitszeiten/);
    expect(() => pdf.createBlob({ employee, month: "11-2026", records: entries(1) })).toThrow();
    expect(() => pdf.createBlob({ employee: { name: "", eid: "E1" }, month: "2026-11", records: entries(1) })).toThrow();
    expect(() => pdf.createBlob({ employee, month: "2026-11", records: [{ date: "2026-11-02", start: "08:00", end: "09:00", pause: 60 }] })).toThrow(/Ungültige Stundenangabe/);
  });

  it("fileFor names the file after eid and month (TEST- prefix in test mode)", () => {
    const file = pdf.fileFor({ employee, month: "2026-11", records: entries(1), test: true });
    expect(file.name).toBe("UWE-TEST-Stundenzettel-E1001-2026-11.pdf");
    expect(file.type).toBe("application/pdf");
    expect(pdf.fileFor({ employee: { name: "X", eid: "E/../1" }, month: "2026-11", records: entries(1) }).name).toBe("UWE-Stundenzettel-E1-2026-11.pdf");
  });
});

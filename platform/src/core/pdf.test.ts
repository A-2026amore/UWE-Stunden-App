import { describe, expect, it } from "vitest";
import { createStatementPdf, createStatementPdfBytes, statementFileName, type StatementPdfArgs } from "./pdf";
import type { ShiftLike } from "./types";
import { loadLegacy } from "./__legacy__/loadLegacy";
import { clock, int, pick, rng } from "./__legacy__/random";

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

function makeEntries(count: number, seed = 1): (ShiftLike & { note: string })[] {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const start = int(r, 0, 1200);
    return {
      id: "e" + i,
      date: "2026-11-" + String(1 + (i % 28)).padStart(2, "0"),
      start: clock(start),
      end: clock(start + int(r, 60, 600)),
      pause: pick(r, [0, 15, 30]),
      note: pick(r, ["", "Dialysefahrt Köln – Aachen (Rückfahrt)", "x ".repeat(int(r, 1, 120)), "Sonderzeichen € „Test“"]),
    };
  });
}

const uweTenant: StatementPdfArgs["tenant"] = {
  name: "UWE Krankentransporte", brand: "uwe", primaryColor: "#00A99E",
  contact: { legalName: "UWE Krankentransporte", street: "Musterstraße 1", postalCode: "52062", city: "Aachen", phone: "0241 400 111 11", email: "info@example.org" },
};

describe("pdf", () => {
  it("60 entries → multi-page PDF with %PDF header, repeated table header and page numbers", async () => {
    const entries = makeEntries(60);
    const blob = createStatementPdf({ tenant: uweTenant, employee: { name: "Erika Muster", personnelNumber: "4711" }, month: "2026-11", entries, status: "submitted", createdAt: new Date(2026, 10, 30) });
    expect(blob.type).toBe("application/pdf");
    const text = latin1(new Uint8Array(await blob.arrayBuffer()));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const pages = Number(/\/Count (\d+)/.exec(text)![1]);
    expect(pages).toBeGreaterThan(1);
    for (let p = 1; p <= pages; p++) expect(text).toContain("(Seite " + p + " von " + pages + ")");
    expect(text.split("(Bemerkung)").length - 1).toBe(pages); // table header on every page
    expect(text.split("(STUNDENNACHWEIS)").length - 1).toBe(pages);
    expect(text).toContain("(Status: Eingereicht)");
    expect(text).toContain("(Erstellt: 30.11.2026)");
    expect(text).toContain("0.000 0.663 0.620 rg"); // UWE vector logo colour
    expect(text).toContain("/GSWatermark gs");
    expect(text).toContain("Tel. 0241 400 111 11");
    // xref offsets point at the objects.
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const firstObj = Number(/xref\n0 \d+\n0000000000 65535 f \n(\d{10})/.exec(text)![1]);
    expect(text.slice(firstObj, firstObj + 7)).toBe("1 0 obj");
  });

  it("same pagination as the legacy generator (uwe-pdf.js) for random months", () => {
    const withBlob = loadLegacyWithBlob();
    const r = rng(5);
    for (let n = 0; n < 40; n++) {
      const entries = makeEntries(int(r, 1, 90), n + 10);
      const mine = latin1(createStatementPdfBytes({ tenant: uweTenant, employee: { name: "A", personnelNumber: "1" }, month: "2026-11", entries }));
      const legacy = withBlob({ employee: { name: "A", eid: "1" }, month: "2026-11", records: entries });
      expect(/\/Count (\d+)/.exec(mine)![1]).toBe(/\/Count (\d+)/.exec(legacy)![1]);
      expect(/GESAMT: [\d,]+ Stunden/.exec(mine)![0]).toBe(/GESAMT: [\d,]+ Stunden/.exec(legacy)![0]);
    }
  });

  it("generic tenant: typographic logo in primary colour, no UWE artwork", () => {
    const text = latin1(createStatementPdfBytes({
      tenant: { name: "Muster Pflege GmbH", primaryColor: "#336699", contact: null },
      employee: { name: "Max", personnelNumber: "M-1" }, month: "2026-11", entries: makeEntries(3),
    }));
    expect(text).toContain("(Muster Pflege GmbH)");
    expect(text).toContain("0.200 0.400 0.600 rg");
    expect(text).not.toContain("1755 366 m");
    expect(text).not.toContain("/GSWatermark gs");
  });

  it("work-account section and consistency checks", () => {
    const entries = [{ date: "2026-11-02", start: "08:00", end: "16:00", pauseMinutes: 30, note: "" }];
    const account = { cycleLabel: "2026/27", workedMinutes: 450, eligibleMinutes: 450, allocatedMinutes: 150, billingMinutes: 300,
      balanceMinutes: -5850, openingMinutes: -6000, cycleEnd: "2027-07-16", summerStart: "2027-07-19" };
    const text = latin1(createStatementPdfBytes({ tenant: uweTenant, employee: { name: "A", personnelNumber: "1" }, month: "2026-11", entries, account }));
    expect(text).toContain("Ins Konto: 2,50 Std.");
    expect(text).toContain("Zur Abrechnung vorgemerkt: 5,00 Std.");
    expect(text).toContain("Jahresstand nach diesem Monat: -97,50 Std.");
    expect(text).toContain("Letzter Schultag: 16.07.2027");
    expect(() => createStatementPdfBytes({ tenant: uweTenant, employee: { name: "A", personnelNumber: "1" }, month: "2026-11", entries, account: { ...account, billingMinutes: 1 } }))
      .toThrow("Arbeitszeitkonto kann nicht korrekt in die PDF übernommen werden.");
    expect(() => createStatementPdfBytes({ tenant: uweTenant, employee: { name: "A", personnelNumber: "1" }, month: "2026-11", entries: [] }))
      .toThrow("Für diesen Monat sind keine gültigen Arbeitszeiten zum Export vorhanden.");
    expect(() => createStatementPdfBytes({ tenant: uweTenant, employee: { name: "A", personnelNumber: "1" }, month: "2026-11", entries, totals: { workedMinutes: 999 } }))
      .toThrow("stimmen nicht");
  });

  it("file names", () => {
    expect(statementFileName({ tenant: uweTenant, personnelNumber: "47/11", month: "2026-11" })).toBe("UWE-Stundenzettel-4711-2026-11.pdf");
    expect(statementFileName({ tenant: uweTenant, personnelNumber: "4711", month: "2026-11", test: true })).toBe("UWE-TEST-Stundenzettel-4711-2026-11.pdf");
    expect(statementFileName({ tenant: { name: "Müller Pflege GmbH" }, personnelNumber: "1", month: "2026-11" })).toBe("Mueller-Pflege-GmbH-Stundenzettel-1-2026-11.pdf");
  });
});

/** Legacy createBlob returning the PDF text (Blob replaced by a capturing stub). */
function loadLegacyWithBlob(): (args: unknown) => string {
  let last: Uint8Array | null = null;
  class CaptureBlob {
    constructor(parts: Uint8Array[]) { last = parts[0]!; }
  }
  const ctx = loadLegacy(["uwe-pdf.js"], { globals: { Blob: CaptureBlob } });
  return (args) => {
    ctx.window.UweTimesheetPdf.createBlob(args);
    return latin1(last!);
  };
}

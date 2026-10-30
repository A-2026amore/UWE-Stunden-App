import { describe, expect, it } from "vitest";
import { createStatementPdf, createStatementPdfBytes, jpegInfo, statementFileName, type StatementPdfArgs } from "./pdf";
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
    const blob = createStatementPdf({ tenant: uweTenant, employee: { name: "Erika Muster", personnelNumber: "4711" }, month: "2026-11", entries, status: "submitted", createdAt: new Date(2026, 10, 30), productName: "Schichtklar24" });
    expect(blob.type).toBe("application/pdf");
    const text = latin1(new Uint8Array(await blob.arrayBuffer()));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const pages = Number(/\/Count (\d+)/.exec(text)![1]);
    expect(pages).toBeGreaterThan(1);
    for (let p = 1; p <= pages; p++) expect(text).toContain("(Seite " + p + " von " + pages + ")");
    expect(text.split("(Bemerkung)").length - 1).toBe(pages); // table header on every page
    expect(text.split("(STUNDENNACHWEIS)").length - 1).toBe(pages);
    expect(text.split("(STATUS)").length - 1).toBe(pages); // info panel on every page
    expect(text).toContain("(Eingereicht)");
    expect(text).toContain("(Erstellt: 30.11.2026)");
    expect(text.split("(Erstellt mit Schichtklar24)").length - 1).toBe(pages);
    expect(text).toContain("(November 2026)");
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

  it("design: zebra rows, coloured table header, summary block; never more rows per page than the legacy layout", () => {
    const entries = makeEntries(45, 3);
    const text = latin1(createStatementPdfBytes({ tenant: { name: "Muster Pflege GmbH", primaryColor: "#336699" }, employee: { name: "Max", personnelNumber: "M-1" }, month: "2026-11", entries }));
    const pages = Number(/\/Count (\d+)/.exec(text)![1]);
    // Every page: header row in the strong brand colour with white labels.
    expect(text.split("1 1 1 rg /F2 8 Tf").length - 1).toBe(pages * 6);
    // Zebra stripes (very light tint of #336699) behind every second row.
    const zebra = text.split("0.964 0.973 0.982 rg").length - 1;
    expect(zebra).toBeGreaterThanOrEqual(Math.floor(entries.length / 2) - pages);
    expect(text).toMatch(/\(Eins\xe4tze: 45 {3}\| {3}Arbeitstage: \d+ {3}\| {3}Pausen gesamt: [\d,]+ Std\.\)/);
    // No product name line when none is given.
    expect(text).not.toContain("Erstellt mit");
    // Weekday in the date column.
    expect(text).toMatch(/\((Mo|Di|Mi|Do|Fr|Sa|So) \d{2}\.11\.2026\)/);
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

describe("pdf: tenant logo (generic brand)", () => {
  // Minimal JPEG header: SOI, APP0 stub, SOF0 (8 bit, 40×20 px, 3 components), EOI.
  const jpeg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x14, 0x00, 0x28, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
  const generic = (logo: StatementPdfArgs["tenant"]["logo"]): StatementPdfArgs["tenant"] => ({
    name: "Muster Pflegedienst GmbH", brand: "generic", primaryColor: "#2d4f73", logo,
    contact: { legalName: "Muster Pflegedienst GmbH", street: "Beispielweg 2", postalCode: "50667", city: "Köln" },
  });

  it("reads the pixel size of a JPEG and rejects other data", () => {
    expect(jpegInfo(jpeg)).toEqual({ width: 40, height: 20, components: 3 });
    expect(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegInfo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it("embeds the logo once and shows it top left and as watermark on every page", () => {
    const text = latin1(createStatementPdfBytes({
      tenant: generic({ jpeg, width: 40, height: 20 }), employee: { name: "Erika Muster", personnelNumber: "4711" },
      month: "2026-11", entries: makeEntries(60), createdAt: new Date(2026, 10, 30),
    }));
    const pages = Number(/\/Count (\d+)/.exec(text)![1]);
    expect(pages).toBeGreaterThan(1);
    expect(text.split("/Subtype /Image").length - 1).toBe(1);
    expect(text).toContain("/Width 40 /Height 20 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode");
    // Header logo plus the faint watermark (centred, 380 pt wide for this 2:1 logo) on every page.
    expect(text.split("/Logo Do").length - 1).toBe(2 * pages);
    expect(text.split("q /GSWatermark gs 380.00 0 0 190.00 107.64 325.94 cm /Logo Do Q").length - 1).toBe(pages);
    // The logo carries the name: no company name next to it in the header (footer only).
    expect(text).not.toContain("(Muster Pflegedienst GmbH) Tj");
    // xref offsets stay correct with binary image data.
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    for (const m of text.matchAll(/^(\d{10}) 00000 n $/gm)) expect(text.slice(Number(m[1]))).toMatch(/^\d+ 0 obj/);
  });

  it("falls back to the typographic logo without (or with an unusable) logo; UWE keeps its vector logo", () => {
    const base = { employee: { name: "Erika Muster", personnelNumber: "4711" }, month: "2026-11", entries: makeEntries(3) };
    const none = latin1(createStatementPdfBytes({ ...base, tenant: generic(null) }));
    expect(none).not.toContain("/XObject");
    expect(none).toContain("(Muster Pflegedienst GmbH) Tj");
    const broken = latin1(createStatementPdfBytes({ ...base, tenant: generic({ jpeg: new Uint8Array([1, 2, 3]), width: 1, height: 1 }) }));
    expect(broken).not.toContain("/XObject");
    const uwe = latin1(createStatementPdfBytes({ ...base, tenant: { ...uweTenant, logo: { jpeg, width: 40, height: 20 } } }));
    expect(uwe).not.toContain("/XObject");
  });
});

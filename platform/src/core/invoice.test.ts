import { describe, expect, it } from "vitest";
import {
  createInvoicePdfBytes, formatInvoiceNumber, invoiceFileName, invoiceTotals, linesAreGross, missingIssuerData, vatCents, vatFromGross, addDaysISO,
  type InvoiceData,
} from "./invoice";

const issuer = {
  issuerName: "Beispiel Software GmbH (Testdaten)", issuerStreet: "Musterstraße 1", issuerPostalCode: "52062", issuerCity: "Aachen",
  issuerCountry: "Deutschland", issuerEmail: "rechnung@beispiel.example", issuerPhone: null, taxNumber: "201/123/45678", vatId: null,
  paymentDetails: "Überweisung auf das Konto laut Vertrag (Testdaten)",
};

function invoice(lines: number): InvoiceData {
  const l = Array.from({ length: lines }, (_, i) => ({ description: `Zeiterfassung – Position ${i + 1} mit einer längeren Beschreibung zum Umbruch`, quantity: i + 1, unitPriceCents: 500, amountCents: (i + 1) * 500 }));
  const t = invoiceTotals(l, 19);
  return {
    tenantId: "t", month: "2026-09", issueDate: "2026-10-05", servicePeriodStart: "2026-09-01", servicePeriodEnd: "2026-09-30",
    paymentTermsDays: 14, dueDate: "2026-10-19", issuer,
    recipient: { name: "Muster Pflegedienst GmbH (Testdaten)", street: "Musterallee 99", postalCode: "54321", city: "Musterstadt", contactPerson: null, customerNumber: "muster-pflegedienst" },
    lines: l, ...t, vatRatePercent: 19, vatRateConfirmed: false, currency: "EUR",
  };
}

const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const pageCount = (b: Uint8Array) => Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text(b))![1]);

describe("invoice calculation", () => {
  it("VAT is rounded half away from zero like PostgreSQL round(numeric)", () => {
    expect(vatCents(500, 19)).toBe(95);
    expect(vatCents(2500, 19)).toBe(475);
    expect(vatCents(350, 19)).toBe(67); // 66.5 → 67
    expect(vatCents(-350, 19)).toBe(-67);
    expect(vatCents(1000, 7)).toBe(70);
    expect(vatCents(1001, 0)).toBe(0);
    expect(() => vatCents(10.5, 19)).toThrow();
    expect(() => vatCents(100, 101)).toThrow();
  });

  it("VAT contained in a gross amount (prices incl. VAT since 30.10.2026), rounded like PostgreSQL", () => {
    expect(vatFromGross(500, 19)).toBe(80); // 79.83
    expect(vatFromGross(10000, 19)).toBe(1597); // 1596.64
    expect(vatFromGross(1190, 19)).toBe(190);
    expect(vatFromGross(-500, 19)).toBe(-80);
    expect(vatFromGross(107, 7)).toBe(7);
    expect(vatFromGross(500, 0)).toBe(0);
    expect(() => vatFromGross(1.5, 19)).toThrow();
  });

  it("totals: line amounts are gross; net = gross − contained VAT", () => {
    expect(invoiceTotals([{ amountCents: 20 * 500 }], 19)).toEqual({ netCents: 8403, vatCents: 1597, grossCents: 10000 });
    expect(invoiceTotals([{ amountCents: 500 }], 19)).toEqual({ netCents: 420, vatCents: 80, grossCents: 500 });
    expect(invoiceTotals([], 19)).toEqual({ netCents: 0, vatCents: 0, grossCents: 0 });
  });

  it("older invoices with net line amounts are recognised (PDF header)", () => {
    const line = [{ description: "x", quantity: 1, unitPriceCents: 500, amountCents: 500 }];
    expect(linesAreGross({ lines: line, netCents: 420, grossCents: 500 })).toBe(true);
    expect(linesAreGross({ lines: line, netCents: 500, grossCents: 595 })).toBe(false);
  });

  it("numbers: prefix, year, six digits", () => {
    expect(formatInvoiceNumber("SW", 2026, 1)).toBe("SW-2026-000001");
    expect(formatInvoiceNumber("SW", 2027, 123456)).toBe("SW-2027-123456");
    expect(() => formatInvoiceNumber("sw", 2026, 1)).toThrow();
    expect(() => formatInvoiceNumber("SW", 2026, 0)).toThrow();
  });

  it("missing mandatory issuer data (§ 14 UStG)", () => {
    expect(missingIssuerData(issuer)).toEqual([]);
    expect(missingIssuerData({ ...issuer, issuerName: " ", issuerCity: "", taxNumber: null })).toEqual([
      "Name des Rechnungsstellers", "Anschrift des Rechnungsstellers", "Steuernummer oder USt-IdNr."]);
    expect(missingIssuerData({ ...issuer, taxNumber: null, vatId: "DE123456789" })).toEqual([]);
  });

  it("due date", () => {
    expect(addDaysISO("2026-12-25", 14)).toBe("2027-01-08");
  });
});

describe("invoice PDF", () => {
  it("one page for a normal invoice with all mandatory data", () => {
    const b = createInvoicePdfBytes({ invoice: { ...invoice(1), number: "SW-2026-000001" } });
    const s = text(b);
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(pageCount(b)).toBe(1);
    for (const t of ["Rechnung SW-2026-000001", "Leistungszeitraum", "Steuernummer 201/123/45678", "Umsatzsteuer 19 %", "Gesamtbetrag brutto", "zu best\xe4tigen", "Seite 1 von 1"]) {
      expect(s).toContain(t);
    }
    expect(s).not.toContain("Entwurf");
  });

  it("many lines continue on further pages (header repeated, page numbers)", () => {
    const b = createInvoicePdfBytes({ invoice: { ...invoice(80), number: "SW-2026-000002" } });
    const n = pageCount(b);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(text(b)).toContain(`Seite ${n} von ${n}`);
    expect(text(b)).toContain("Fortsetzung");
  });

  it("drafts carry the watermark on every page and list the missing data", () => {
    const b = createInvoicePdfBytes({ invoice: { ...invoice(80), number: null }, draft: true, missing: ["Steuernummer oder USt-IdNr."] });
    const s = text(b);
    const n = pageCount(b);
    expect(s.split("(Entwurf \x96 Pflichtangaben fehlen) Tj").length - 1).toBe(n);
    expect(s).toContain("Fehlende Pflichtangaben: Steuernummer oder USt-IdNr.");
    expect(s).toContain("Rechnung ENTWURF");
  });

  it("cancellation document references the original invoice", () => {
    const inv = invoice(1);
    const b = createInvoicePdfBytes({ invoice: { ...inv, number: "SW-2026-000003", kind: "cancellation", cancelsInvoiceNumber: "SW-2026-000001", cancelReason: "Falsche Anschrift",
      netCents: -inv.netCents, vatCents: -inv.vatCents, grossCents: -inv.grossCents } });
    expect(text(b)).toContain("Storno zur Rechnung SW-2026-000001");
    expect(text(b)).toContain("Stornorechnung SW-2026-000003");
  });

  it("file names", () => {
    expect(invoiceFileName({ number: "SW-2026-000001", month: "2026-09", recipient: { customerNumber: "x" } })).toBe("Rechnung-SW-2026-000001.pdf");
    expect(invoiceFileName({ number: null, month: "2026-09", recipient: { customerNumber: "muster-pflegedienst" } })).toBe("Rechnungsentwurf-muster-pflegedienst-2026-09.pdf");
  });
});

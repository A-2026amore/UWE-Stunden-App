import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, CHEF, confirmDialog, freeze, go, login } from "./helpers";

// Demo (frozen today 20.11.2026): Muster Pflegedienst GmbH, October 2026 = 3 × 6,50 € (Monatstarif, since 0023) = 19,50 € brutto (16,39 € netto + 3,11 € USt.).
// The demo invoice settings are fictional and complete ("Stundenwerk Demo GmbH (Testdaten)").

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

/** Downloads a file and reads it as latin1 (PDF is binary, text in WinAnsi). */
async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; text: string }> {
  const pending = page.waitForEvent("download");
  await click();
  const file = await pending;
  const name = file.suggestedFilename();
  return { name, text: (await readFile((await file.path())!)).toString("latin1") };
}

test("super-admin: draft, invoice with gapless number and PDF, cancellation; owner sees both", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  await go(page, "#/rechnungen");
  await expect(page.getByRole("heading", { level: 1, name: "Rechnungen" })).toBeVisible();
  await expect(page.getByText("Pflichtangaben vollständig")).toBeVisible();
  await expect(page.getByLabel("Leistungsmonat")).toHaveValue("2026-10");

  // draft without number
  const draft = await download(page, () => page.getByRole("button", { name: "Rechnungsentwurf für Muster Pflegedienst GmbH" }).click());
  expect(draft.name).toMatch(/^Rechnungsentwurf-.*-2026-10\.pdf$/);
  expect(draft.text.startsWith("%PDF-")).toBe(true);

  // issue
  const pdf = await download(page, async () => {
    await page.getByRole("button", { name: "Rechnung für Muster Pflegedienst GmbH erzeugen" }).click();
    await confirmDialog(page, "Rechnung erzeugen");
  });
  expect(pdf.name).toBe("Rechnung-SW-2026-000001.pdf");
  expect(pdf.text.startsWith("%PDF-")).toBe(true);
  expect(pdf.text).toContain("SW-2026-000001");
  expect(pdf.text).toContain("19,50");
  expect(pdf.text).toContain("16,39");
  expect(pdf.text).toContain("3,11");
  for (const personal of ["Mia Musterfrau", "Noah Normal", "Olga Ohnename"]) expect(pdf.text).not.toContain(personal);
  const all = page.getByRole("table", { name: "Alle Rechnungen" });
  await expect(all).toContainText("SW-2026-000001");
  await expect(all).toContainText("Gültig");
  // a second invoice for the same month is not offered
  await expect(page.getByRole("button", { name: "Rechnung für Muster Pflegedienst GmbH erzeugen" })).toHaveCount(0);

  // cancellation: own number, original stays
  await all.getByRole("button", { name: "Rechnung SW-2026-000001 stornieren" }).click();
  const cd = page.getByRole("dialog", { name: "Rechnung SW-2026-000001 stornieren" });
  await cd.getByLabel("Grund (Pflicht, mind. 5 Zeichen)").fill("Falscher Empfänger");
  await cd.getByRole("button", { name: "Stornieren", exact: true }).click();
  await expect(cd).toBeHidden();
  await expect(all).toContainText("SW-2026-000002");
  await expect(all).toContainText("Storniert");
  await expect(all).toContainText("Stornorechnung");
  const storno = await download(page, () => all.getByRole("button", { name: "Rechnung SW-2026-000002 als PDF" }).click());
  expect(storno.name).toBe("Stornorechnung-SW-2026-000002.pdf");
  expect(storno.text).toContain("SW-2026-000001");

  // the audit log has both steps
  await go(page, "#/protokoll");
  await expect(page.getByRole("main")).toContainText("Rechnung erzeugt");
  await expect(page.getByRole("main")).toContainText("Rechnung storniert");

  // owner of the customer: own invoices on the billing page
  await login(page, CHEF, "leitung@muster-pflege.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/abrechnung");
  const own = page.getByRole("table", { name: "Rechnungen" });
  await expect(own).toContainText("SW-2026-000001");
  await expect(own).toContainText("SW-2026-000002");
  const ownPdf = await download(page, () => own.getByRole("button", { name: "Rechnung SW-2026-000001 als PDF" }).click());
  expect(ownPdf.name).toBe("Rechnung-SW-2026-000001.pdf");
});

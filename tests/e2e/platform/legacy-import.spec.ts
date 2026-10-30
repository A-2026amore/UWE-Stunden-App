import { expect, test, type Page } from "@playwright/test";
import { legacyBackups, snapshots } from "../../fixtures/legacy-storage";
import { ADMIN, ANNA_ID, APP, confirmDialog, dbEntries, freeze, go, login, loginEmployee, patchDb } from "./helpers";

// Backup months (Oct/Nov 2026) lie outside the demo seed of this date (Feb/Mar 2027) → no overlaps with seed data.
const IMPORT_NOW = new Date("2027-03-15T10:00:00+01:00");
const E1001_IDS = [1, 2, 3, 4, 5, 6].map((n) => `3f1c2b9e-6a4d-4c1b-9f2e-1a2b3c4d5e0${n}`);

/** Demo setup: the employer assigns Anna the personnel number of the legacy app (E1001). */
async function annaAsE1001(page: Page): Promise<void> {
  await page.goto(APP);
  await expect(page.getByRole("heading", { name: "Anmeldung für Mitarbeitende" })).toBeVisible();
  await patchDb(page, "db.employees.find((e) => e.id === arg).personnelNumber = 'E1001';", ANNA_ID);
  await loginEmployee(page);
  await expect(page.getByText("Nr. E1001")).toBeVisible();
}

async function openImport(page: Page): Promise<void> {
  await go(page, "#/einstellungen");
  await page.getByRole("link", { name: "Daten aus der bisherigen UWE-App übernehmen" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Daten aus der bisherigen UWE-App übernehmen" })).toBeVisible();
}

async function chooseBackup(page: Page, name: string, content: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByLabel(/Sicherungsdatei der bisherigen App/).click();
  await (await chooser).setFiles({ name, mimeType: "application/json", buffer: Buffer.from(content, "utf8") });
}

test.beforeEach(async ({ page }) => {
  await freeze(page, IMPORT_NOW);
});

test("backup v4 import: report before writing, confirmation, idempotent re-import", async ({ page }) => {
  await annaAsE1001(page);
  await openImport(page);
  await chooseBackup(page, "uwe-stunden-backup-E1001.json", legacyBackups.v4);

  const report = page.getByTestId("import-report");
  await expect(report).toBeVisible();
  await expect(page.getByTestId("report-read")).toHaveText("6");
  await expect(page.getByTestId("report-write")).toHaveText("6");
  await expect(page.getByTestId("report-present")).toHaveText("0");
  await expect(page.getByTestId("report-invalid")).toHaveText("0");
  const months = page.getByRole("table", { name: "Monatssummen alt und neu" });
  await expect(months.getByRole("row", { name: /Oktober 2026/ })).toContainText("7,50 Std.");
  await expect(months.getByRole("row", { name: /November 2026/ })).toContainText("30,75 Std.");
  await expect(page.getByTestId("report-allocations")).toContainText("Oktober 2026: 5,00 Std. – wird als Vorschlag übernommen");
  // Nothing written before the confirmation.
  expect((await dbEntries(page, { employeeId: ANNA_ID, includeDeleted: true })).filter((e) => E1001_IDS.includes(e.id))).toHaveLength(0);

  await page.getByRole("button", { name: "Übernahme bestätigen" }).click();
  await confirmDialog(page, "Übernehmen");
  await expect(page.getByTestId("import-outcome")).toHaveText("6 Einsätze übernommen, 2 Arbeitszeitkonto-Aufteilung(en) gespeichert.");
  const imported = (await dbEntries(page, { employeeId: ANNA_ID })).filter((e) => E1001_IDS.includes(e.id));
  expect(imported).toHaveLength(6);
  expect(imported.every((e) => e.source === "migration")).toBe(true);

  // Month view shows the imported hours (legacy total November 2026: 30,75 h).
  await go(page, "#/monat?m=2026-11");
  await expect(page.locator("dt", { hasText: "Tatsächlich geleistete Stunden" }).locator("xpath=following-sibling::dd[1]")).toHaveText("30,75 Std.");

  // Re-import of the same file adds nothing.
  await openImport(page);
  await chooseBackup(page, "uwe-stunden-backup-E1001.json", legacyBackups.v4);
  await expect(page.getByTestId("report-write")).toHaveText("0");
  await expect(page.getByTestId("report-present")).toHaveText("6");
  await expect(page.getByText("Nichts zu übernehmen")).toBeVisible();
  await expect(page.getByRole("button", { name: "Übernahme bestätigen" })).toBeDisabled();
  expect((await dbEntries(page, { employeeId: ANNA_ID })).filter((e) => E1001_IDS.includes(e.id))).toHaveLength(6);

  // An older backup (v3, subset) is recognised as already imported, too.
  await chooseBackup(page, "uwe-backup-v3.json", legacyBackups.v3);
  await expect(page.getByTestId("report-write")).toHaveText("0");
  await expect(page.getByTestId("report-present")).toHaveText("1");
});

test("backup of another personnel number is refused", async ({ page }) => {
  await loginEmployee(page); // Anna has personnel number 1001, not E1001
  await openImport(page);
  await chooseBackup(page, "fremd.json", legacyBackups.v4);
  const alert = page.getByRole("alert").filter({ hasText: "Import nicht möglich" });
  await expect(alert).toContainText("Personalnummer E1001");
  await expect(alert).toContainText("1001 angemeldet");
  await expect(page.getByTestId("import-report")).toHaveCount(0);

  await chooseBackup(page, "kaputt.json", "{kein json");
  await expect(page.getByRole("alert").filter({ hasText: "keine gültige Sicherung" })).toBeVisible();
});

test("import from the legacy keys of this browser; legacy data stays untouched", async ({ page }) => {
  await annaAsE1001(page);
  // Same-origin legacy data of a shared device: E1001 (2 entries) and a second person E1007.
  await page.evaluate((snap) => { for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v); }, snapshots.sharedDevice);
  const before = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("uwe_")).map((k) => [k, localStorage.getItem(k)])));

  await openImport(page);
  await expect(page.getByText("In diesem Browser gefunden: Daten zu Personalnummer E1001, E1007.")).toBeVisible();
  await page.getByRole("button", { name: "Daten aus diesem Browser lesen" }).click();
  await expect(page.getByTestId("report-read")).toHaveText("2");
  await expect(page.getByTestId("report-write")).toHaveText("2");
  await page.getByText(/^Hinweise/).click();
  await expect(page.getByText("Daten anderer Personalnummern (E1007) werden nicht übernommen.")).toBeVisible();
  await page.getByRole("button", { name: "Übernahme bestätigen" }).click();
  await confirmDialog(page, "Übernehmen");
  await expect(page.getByTestId("import-outcome")).toContainText("2 Einsätze übernommen");

  const after = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("uwe_")).map((k) => [k, localStorage.getItem(k)])));
  expect(after).toEqual(before);
  expect((await dbEntries(page, { employeeId: ANNA_ID })).filter((e) => E1001_IDS.includes(e.id)).map((e) => e.id).sort()).toEqual(E1001_IDS.slice(0, 2));

  await page.getByRole("button", { name: "Daten aus diesem Browser lesen" }).click();
  await expect(page.getByTestId("report-write")).toHaveText("0");
  await expect(page.getByTestId("report-present")).toHaveText("2");
});

test("other companies do not see the import; the super admin can switch it on per tenant", async ({ page }) => {
  await page.goto(APP);
  await loginEmployee(page, "mia@muster-pflege.example", "Mia");
  await go(page, "#/einstellungen");
  await expect(page.getByRole("button", { name: "Abmelden" })).toBeVisible();
  await expect(page.getByText("Daten aus der bisherigen UWE-App übernehmen")).toHaveCount(0);
  // The direct link does not open the import either.
  await go(page, "#/einstellungen/import");
  await expect(page.getByRole("heading", { level: 1, name: "Daten aus der bisherigen UWE-App übernehmen" })).toHaveCount(0);

  const admin = await page.context().newPage();
  await login(admin, ADMIN, "admin@plattform.example");
  await admin.getByRole("row", { name: /Muster Pflegedienst/ }).getByRole("link", { name: "Muster Pflegedienst GmbH verwalten" }).click();
  await expect(admin.getByTestId("tenant-legacy-import")).toHaveText("ausgeblendet");
  await admin.getByRole("button", { name: "Übernahme aus alter UWE-App anbieten" }).click();
  const dialog = admin.getByRole("dialog");
  await dialog.getByLabel("Begründung").fill("Kunde hatte die alte App");
  await dialog.getByRole("button", { name: "Anbieten", exact: true }).click();
  await expect(admin.getByTestId("tenant-legacy-import")).toHaveText("angeboten");

  await page.reload();
  await go(page, "#/einstellungen");
  await expect(page.getByRole("link", { name: "Daten aus der bisherigen UWE-App übernehmen" })).toBeVisible();
});

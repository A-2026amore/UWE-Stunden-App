/**
 * Layout regressions found in the final QA of 1.0 (demo build):
 *  - Super-Admin "Rechnungen": hints (Pflichtangaben / USt-Satz) had no spacing to each other and to the form.
 *  - Super-Admin "Preismodell": the price sentence did not wrap on phones (horizontal scrolling).
 *  - Chef "Monatsnachweise": row actions did not wrap on a 1440 px desktop (table wider than the card).
 *  - Chef "Verlauf" of a statement: the dialog was too narrow for its table on desktop.
 *  - Employee month view of a re-opened month said "Dieser Monat ist eingereicht."
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, APP, CHEF, freeze, go, login } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

/** Horizontal overflow of an element (scrollable width beyond its visible width), in px. */
async function overflowX(l: Locator): Promise<number> {
  return l.evaluate((el) => el.scrollWidth - el.clientWidth);
}

async function noPageScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test("super-admin invoices: hints keep their distance to each other and to the form", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  await go(page, "#/rechnungen");
  const done = page.locator(".alert").filter({ hasText: "Pflichtangaben vollständig" });
  const vat = page.locator(".alert").filter({ hasText: "USt-Satz vom Auftraggeber zu bestätigen" });
  await expect(done).toBeVisible();
  await expect(vat).toBeVisible();
  const a = (await done.boundingBox())!;
  const b = (await vat.boundingBox())!;
  const label = (await page.getByLabel("Name / Firma").boundingBox())!;
  expect(b.y - (a.y + a.height)).toBeGreaterThanOrEqual(8);
  // the label of the first field sits above the input; the hint must end clearly above the label
  expect(label.y - (b.y + b.height)).toBeGreaterThanOrEqual(8 + 16);
  await noPageScroll(page);
});

test("super-admin price model: the price sentence wraps on phones", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  await go(page, "#/lizenzen");
  await expect(page.getByTestId("default-price")).toContainText("5,00");
  expect(await overflowX(page.getByTestId("default-price"))).toBeLessThanOrEqual(0);
  await noPageScroll(page);
});

test("chef statements on a wide desktop: actions wrap inside the table, history dialog fits its table", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop layout");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, CHEF, "chef@demo-kt.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/nachweise");
  // opens with the last month (October 2026), where Anna's statement is approved
  await expect(page.locator("#month-input")).toHaveValue("2026-10");
  const row = page.getByRole("row", { name: /Anna Beispiel/ });
  await expect(row).toContainText("Freigegeben");
  const wrap = page.locator(".table-wrap").first();
  expect(await overflowX(wrap)).toBeLessThanOrEqual(0);
  await expect(row.getByRole("button", { name: "Monat von Anna Beispiel wieder öffnen" })).toBeInViewport();

  await row.getByRole("button", { name: "Verlauf des Nachweises von Anna Beispiel" }).click();
  const dialog = page.getByRole("dialog", { name: /^Verlauf – Anna Beispiel/ });
  await expect(dialog).toBeVisible();
  expect(await overflowX(dialog.locator(".table-wrap"))).toBeLessThanOrEqual(0);
});

test("employee: a re-opened month is called re-opened, not submitted", async ({ page }) => {
  await login(page, CHEF, "chef@demo-kt.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/nachweise");
  await expect(page.locator("#month-input")).toHaveValue("2026-10");
  await page.getByRole("button", { name: "Monat von Anna Beispiel wieder öffnen" }).click();
  const reopen = page.getByRole("dialog", { name: "Monat wieder öffnen" });
  await reopen.getByLabel("Begründung (Pflicht, mind. 5 Zeichen)").fill("Einsatzende laut Fahrtenbuch");
  await reopen.getByRole("button", { name: "Wieder öffnen", exact: true }).click();
  await expect(page.getByRole("row", { name: /Anna Beispiel/ })).toContainText("Wieder geöffnet");

  await login(page, APP, "anna@demo-kt.example");
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Anna" })).toBeVisible();
  await go(page, "#/monat?m=2026-10");
  await expect(page.getByText("Dieser Monat ist wieder geöffnet.")).toBeVisible();
  await expect(page.getByText("Dieser Monat ist eingereicht.")).toHaveCount(0);
});

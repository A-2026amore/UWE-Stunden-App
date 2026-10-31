import { expect, test, type Page } from "@playwright/test";
import { ANNA_ID, APP, CHEF, DEMO_DB_KEY, freeze, go, login, loginEmployee, minutesOf, patchDb } from "./helpers";

// Employment contract data (migration 0025): the demo seeds contracts from October 2026 (month before "today").
const CARLA_ID = "30000000-0000-4000-8000-000000000103";

async function loginChef(page: Page): Promise<void> {
  await login(page, CHEF, "chef@demo-kt.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

async function contractsOf(page: Page, employeeId: string) {
  return page.evaluate(([key, id]) => ((JSON.parse(localStorage.getItem(key!)!) as { employmentContracts?: Array<Record<string, unknown>> })
    .employmentContracts ?? []).filter((c) => c.employeeId === id), [DEMO_DB_KEY, employeeId]);
}

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

test("dashboard: Soll / Ist, differences and hours account per person", async ({ page }) => {
  await loginChef(page);
  const card = page.getByTestId("employment-overview");
  await expect(card).toBeVisible();
  const anna = card.getByRole("row").filter({ hasText: "Anna Beispiel" });
  await expect(anna).toContainText("Teilzeit · 120,00 Std./Monat · 14,50 €/Std.");
  await expect(anna).toContainText("/ 120,00 Std.");
  // Ben: Minijob 43 h with far more hours → over target and over the Minijob limit
  const ben = card.getByRole("row").filter({ hasText: "Ben Muster" });
  await expect(ben).toContainText("zu viel");
  await expect(ben).toContainText("über Minijob-Grenze");
  await expect(anna.getByTestId(`employment-balance-${ANNA_ID}`)).toBeVisible();
  // "offen": no target, no account
  const deniz = card.getByRole("row").filter({ hasText: "Deniz Test" });
  await expect(deniz).toContainText("ohne Limit");
  await expect(deniz).toContainText("Stunden offen");
  await expect(page.getByTestId("employment-summary")).toContainText("über Soll");
});

test("chef records contract data in the employee dialog (Minijob suggestion) and removes a version", async ({ page }) => {
  await loginChef(page);
  await go(page, "#/mitarbeiter");
  await page.getByRole("button", { name: "Carla Probe bearbeiten" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("employment-fields")).toBeVisible();
  await expect(dialog.getByLabel("Art des Arbeitsvertrags")).toHaveValue("vollzeit");
  await dialog.getByLabel("Art des Arbeitsvertrags").selectOption("minijob");
  await dialog.getByLabel("Stundenlohn (brutto)").fill("14,00");
  await expect(dialog.getByText("Minijob-Grenze 603,00 €: bei diesem Stundenlohn höchstens 43,00 Std. im Monat.")).toBeVisible();
  await dialog.getByRole("button", { name: "Übernehmen" }).click();
  await expect(dialog.getByLabel("Soll-Stunden", { exact: true })).toHaveValue("43");
  await dialog.getByLabel("Übertrag ins Arbeitszeitkonto").fill("-2,5");
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toBeHidden();

  const stored = await contractsOf(page, CARLA_ID);
  expect(stored.map((c) => [c.validFrom, c.employmentType, c.hourlyWageCents, c.monthlyTargetMinutes, c.carryOverMinutes])).toEqual([
    ["2026-10", "vollzeit", 1600, 9600, 0],
    ["2026-11", "minijob", 1400, 2580, -150],
  ]);
  await expect(page.getByRole("row").filter({ hasText: "Carla Probe" })).toContainText("Minijob · 43,00 Std./Monat · 14,00 €/Std.");

  // Saving again without changes creates no new version; removing the November version restores October.
  await page.getByRole("button", { name: "Carla Probe bearbeiten" }).click();
  await expect(dialog.getByTestId("employment-versions")).toContainText("ab November 2026: Minijob");
  await dialog.getByRole("button", { name: "Angaben ab November 2026 entfernen" }).click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog").filter({ hasText: "Vertragsdaten entfernen?" })).getByRole("button", { name: "Entfernen", exact: true }).click();
  await expect(page.locator(".toast").filter({ hasText: "Vertragsdaten entfernt." })).toBeVisible();
  expect((await contractsOf(page, CARLA_ID)).map((c) => c.validFrom)).toEqual(["2026-10"]);
});

test("chef invites a new employee with an open contract; invalid values are rejected before anything is created", async ({ page }) => {
  await loginChef(page);
  await go(page, "#/mitarbeiter");
  await page.getByRole("button", { name: "Mitarbeiter einladen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Vera Vertrag");
  await dialog.getByLabel("Personalnummer").fill("1099");
  await dialog.getByLabel("Art des Arbeitsvertrags").selectOption("vollzeit");
  await dialog.getByLabel("Stundenlohn (brutto)").fill("abc");
  await dialog.getByRole("button", { name: "Einladen" }).click();
  await expect(dialog.getByText("Bitte einen Betrag in Euro angeben, z. B. 5,00.")).toBeVisible();
  const before = await page.evaluate((key) => (JSON.parse(localStorage.getItem(key)!) as { employees: unknown[] }).employees.length, DEMO_DB_KEY);

  await dialog.getByLabel("Stundenlohn (brutto)").fill("16,50");
  await dialog.getByLabel("Soll-Stunden pro Monat").selectOption("open");
  await expect(dialog.getByLabel("Soll-Stunden", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Einladen" }).click();
  await expect(dialog).toBeHidden();
  const ids = await page.evaluate((key) => (JSON.parse(localStorage.getItem(key)!) as { employees: Array<{ id: string; displayName: string }> }).employees, DEMO_DB_KEY);
  expect(ids.length).toBe(before + 1);
  const vera = ids.find((e) => e.displayName === "Vera Vertrag")!;
  expect((await contractsOf(page, vera.id)).map((c) => [c.employmentType, c.hourlyWageCents, c.monthlyTargetMinutes])).toEqual([["vollzeit", 1650, null]]);
  await expect(page.getByRole("row").filter({ hasText: "Vera Vertrag" })).toContainText("Vollzeit · Stunden offen · 16,50 €/Std.");
});

test("employee sees the own contract hours and account – the same balance as the dashboard, without the wage", async ({ page }) => {
  await loginChef(page);
  const dashboardBalance = minutesOf(await page.getByTestId(`employment-balance-${ANNA_ID}`).innerText());

  await page.goto(APP);
  await loginEmployee(page);
  const info = page.getByTestId("employment-info");
  await expect(info).toContainText("Teilzeit · Soll 120,00 Std. pro Monat");
  await expect(info).not.toContainText("€");
  expect(minutesOf(await page.getByTestId("employment-info-balance").locator(".stat-value").innerText())).toBe(dashboardBalance);

  await go(page, "#/konto");
  await expect(page.getByRole("heading", { level: 1, name: "Arbeitszeitkonto" })).toBeVisible();
  await expect(page.getByTestId("employment-info")).toContainText("Die Angaben trägt dein Arbeitgeber ein.");
});

test("employee without contract data sees no contract card", async ({ page }) => {
  await page.goto(APP);
  await patchDb(page, "db.employmentContracts = (db.employmentContracts || []).filter((c) => c.employeeId !== arg);", ANNA_ID);
  await loginEmployee(page);
  await expect(page.getByRole("heading", { name: "Heute" })).toBeVisible();
  await expect(page.getByTestId("employment-info")).toHaveCount(0);
});

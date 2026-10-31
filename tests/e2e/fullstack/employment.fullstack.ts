/**
 * Employment contract data (migration 0025) against the real API + PostgreSQL: the owner records
 * the contract in the employee dialog, the dashboard shows Soll / Ist, the employee sees the own card.
 */
import { IDS, USERS, expect, go, rows, signIn, test } from "./support/stack";

test("owner records a Minijob contract; dashboard and employee app show it", async ({ browser, page, stack }) => {
  await signIn(page, "/chef/", USERS.ownerA);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/mitarbeiter");
  await page.getByRole("button", { name: "Sam Probe bearbeiten" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Art des Arbeitsvertrags").selectOption("minijob");
  await dialog.getByLabel("Stundenlohn (brutto)").fill("14,00");
  await dialog.getByRole("button", { name: "Übernehmen" }).click();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "Sam Probe" })).toContainText("Minijob · 43,00 Std./Monat · 14,00 €/Std.");

  const stored = await rows<{ employment_type: string; hourly_wage_cents: number; monthly_target_minutes: number }>(stack.db,
    "select employment_type, hourly_wage_cents, monthly_target_minutes from public.employment_contracts where employee_id = $1", [IDS.employees.emp1A]);
  expect(stored).toEqual([{ employment_type: "minijob", hourly_wage_cents: 1400, monthly_target_minutes: 2580 }]);

  await go(page, "#/");
  await expect(page.getByTestId("employment-overview").getByRole("row").filter({ hasText: "Sam Probe" })).toContainText("/ 43,00 Std.");

  const ctx = await browser.newContext({ baseURL: stack.url, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const emp = await ctx.newPage();
  await signIn(emp, "/app/", USERS.emp1A);
  await expect(emp.getByTestId("employment-info")).toContainText("Minijob · Soll 43,00 Std. pro Monat");
  await expect(emp.getByTestId("employment-info")).not.toContainText("€");
  await ctx.close();
});

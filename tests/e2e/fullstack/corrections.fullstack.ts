/**
 * Correction requests against the real API + PostgreSQL (api-mode build).
 * Seed: September 2026 of Sam Probe (fahrer1, tenant A) is approved → locked.
 */
import { IDS, USERS, expect, go, rows, signIn, test } from "./support/stack";

test("employee requests a correction in the approved month, the manager accepts it", async ({ page, browser, stack }) => {
  await signIn(page, "/app/", USERS.emp1A);
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Sam" })).toBeVisible();
  await go(page, "#/monat?m=2026-09");
  await expect(page.getByText("Dieser Monat ist freigegeben.")).toBeVisible();
  await page.getByRole("button", { name: "Korrektur für Einsatz am 01.09.2026 06:00–14:30 beantragen" }).click();
  const dialog = page.getByRole("dialog", { name: "Korrektur beantragen" });
  await dialog.getByLabel("Ende", { exact: true }).fill("14:15");
  await dialog.getByLabel("Begründung").fill("Ende laut Fahrtenbuch 14:15 Uhr");
  await dialog.getByRole("button", { name: "Anfrage senden" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".shift").filter({ hasText: "06:00–14:30 Uhr" })).toContainText("Korrektur angefragt");
  const open = await rows(stack.db, "select kind, status, entry_id from public.correction_requests where employee_id = $1", [IDS.employees.emp1A]);
  expect(open).toEqual([{ kind: "change", status: "open", entry_id: "demo-a03-20260901" }]);

  // The manager (own browser, own session cookie)
  const ctx = await browser.newContext({ baseURL: stack.url, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const chef = await ctx.newPage();
  await signIn(chef, "/chef/", USERS.managerA);
  await expect(chef.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(chef, "#/korrekturen");
  const card = chef.locator(".correction-request").filter({ hasText: "Ende laut Fahrtenbuch" });
  await expect(card).toContainText("Sam Probe");
  await expect(card).toContainText("Monat freigegeben");
  await card.getByRole("button", { name: "Anfrage von Sam Probe annehmen" }).click();
  await chef.getByRole("dialog").getByRole("button", { name: "Annehmen", exact: true }).click();
  await expect(chef.getByText("Keine offenen Korrekturanfragen")).toBeVisible();

  const entry = await rows(stack.db,
    "select to_char(end_time, 'HH24:MI') as end, source, version from public.time_entries where employee_id = $1 and id = 'demo-a03-20260901'", [IDS.employees.emp1A]);
  expect(entry).toEqual([{ end: "14:15", source: "correction", version: 2 }]);

  await go(chef, "#/nachweise");
  await chef.getByLabel("Monat wählen").fill("2026-09");
  await expect(chef.getByRole("row", { name: /Sam Probe/ })).toContainText("nach Freigabe korrigiert");
  await ctx.close();

  await page.reload();
  await go(page, "#/monat?m=2026-09");
  await expect(page.getByRole("region", { name: "Korrekturanfragen" })).toContainText("Angenommen");
  await expect(page.locator(".shift").filter({ hasText: "06:00–14:15 Uhr" })).toContainText("korrigiert durch Vorgesetzte");
});

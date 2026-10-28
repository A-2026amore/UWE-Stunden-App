/**
 * Chef portal and super-admin against the real API + PostgreSQL:
 * monthly statement returned with reason, tenant isolation, platform view without time data.
 */
import { IDS, USERS, apiStatus, expect, fillEntry, go, rows, saveEntry, signIn, test } from "./support/stack";

test("chef sees the employee's entry and returns the monthly statement with a reason", async ({ browser, page, stack }) => {
  // Sam Probe (fahrer1) records a shift in November 2026 and submits the month.
  await signIn(page, "/app/", USERS.emp1A);
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Sam" })).toBeVisible();
  await go(page, "#/erfassen?datum=2026-11-09");
  await fillEntry(page, { start: "08:00", end: "13:00", pause: "0", note: "fullstack-chef" });
  await saveEntry(page);
  await go(page, "#/monat?m=2026-11");
  await page.getByRole("button", { name: "Monatsnachweis einreichen" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Einreichen", exact: true }).click();
  await expect(page.locator(".toast").filter({ hasText: "Monatsnachweis eingereicht." })).toBeVisible();

  // The manager (own browser context = own session) sees it.
  const chefContext = await browser.newContext({ baseURL: stack.url, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const chef = await chefContext.newPage();
  await signIn(chef, "/chef/", USERS.managerA);
  await expect(chef.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(chef.getByText("Demo-Umgebung")).toHaveCount(0);

  await go(chef, "#/zeiten");
  await chef.getByRole("group", { name: "Ansicht" }).getByRole("button", { name: "Monat" }).click();
  await chef.getByLabel("Monat", { exact: true }).fill("2026-11");
  const times = chef.getByRole("table", { name: "Arbeitszeiten November 2026" });
  await expect(times).toContainText("Sam Probe");
  await expect(times).toContainText("08:00");

  await go(chef, "#/nachweise");
  await chef.locator("#month-input").fill("2026-11");
  await chef.getByRole("button", { name: "Nachweis von Sam Probe zurückgeben" }).click();
  const dialog = chef.getByRole("dialog", { name: "Monatsnachweis zurückgeben" });
  await dialog.getByLabel("Begründung (Pflicht)").fill("Bitte den 9. November prüfen.");
  await dialog.getByRole("button", { name: "Zurückgeben", exact: true }).click();
  await expect(chef.locator(".toast").filter({ hasText: "Monatsnachweis zurückgegeben." })).toBeVisible();
  await expect(chef.getByRole("row", { name: /Sam Probe/ })).toContainText("Grund: Bitte den 9. November prüfen.");

  const [st] = await rows<{ status: string; review_note: string | null }>(stack.db,
    "select status, review_note from public.monthly_statements where employee_id = $1 and month = '2026-11'", [IDS.employees.emp1A]);
  expect(st).toMatchObject({ status: "returned", review_note: "Bitte den 9. November prüfen." });

  // The employee sees the reason.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Monatsübersicht" })).toBeVisible();
  await expect(page.getByText("Begründung: Bitte den 9. November prüfen.")).toBeVisible();
  await chefContext.close();
});

test("manager of tenant B sees no data of tenant A", async ({ page }) => {
  await signIn(page, "/chef/", USERS.ownerB);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/mitarbeiter");
  await expect(page.getByRole("table", { name: "Mitarbeiterliste" })).toContainText("Charlie Test");
  const main = page.getByRole("main");
  for (const other of ["Sam Probe", "Jo Demo", "Robin Leitung", "demo-krankentransporte"]) await expect(main).not.toContainText(other);

  // Direct API calls with tenant A ids are refused.
  expect(await apiStatus(page, `/api/tenants/${IDS.tenantA}`)).toBe(403);
  expect(await apiStatus(page, `/api/tenants/${IDS.tenantA}/employees`)).toBe(403);
  expect(await apiStatus(page, `/api/tenants/${IDS.tenantA}/time-entries?from=2026-10-01&to=2026-10-31`)).toBe(403);
  expect(await apiStatus(page, `/api/employees/${IDS.employees.emp1A}/time-entries?month=2026-10`)).toBe(403);
  expect(await apiStatus(page, `/api/tenants/${IDS.tenantB}/time-entries?from=2026-10-01&to=2026-10-31`)).toBe(200);
});

test("super-admin sees tenants and licences, but no time entries", async ({ page }) => {
  await signIn(page, "/admin/", USERS.superAdmin);
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  const list = page.getByRole("table", { name: "Mandantenliste" });
  await expect(list).toContainText("Demo Krankentransporte");
  await expect(list).toContainText("Muster Pflegedienst GmbH");
  await expect(page.getByRole("row", { name: /Demo Krankentransporte/ })).toContainText("Kostenlos – Pilot");

  await page.getByRole("link", { name: "Demo Krankentransporte verwalten" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Demo Krankentransporte" })).toBeVisible();
  await expect(page.getByText("Keine Freigabe")).toBeVisible();
  const main = page.getByRole("main");
  for (const personal of ["Sam Probe", "Jo Demo", "Frühdienst", "Nachtdienst"]) await expect(main).not.toContainText(personal);

  expect(await apiStatus(page, `/api/tenants/${IDS.tenantA}/time-entries?from=2026-09-01&to=2026-10-31`)).toBe(403);
  expect(await apiStatus(page, `/api/employees/${IDS.employees.emp1A}/time-entries?month=2026-10`)).toBe(403);
  expect(await apiStatus(page, "/api/platform/tenants")).toBe(200);

  await go(page, "#/system");
  await expect(page.getByText("Erreichbar")).toBeVisible();
  const status = page.getByTestId("system-status");
  await expect(status).toContainText("Migrationsstand");
  await expect(status).toContainText("Zahlungsdienst");
  await expect(status).toContainText("keiner");
  await expect(status).toContainText("Letzte Sicherung");
});

test("a tenant account is refused by the admin portal", async ({ page }) => {
  await signIn(page, "/admin/", USERS.managerA);
  await expect(page.getByRole("alert").filter({ hasText: "Dieses Konto hat keinen Zugang zur Plattform-Administration." })).toBeVisible();
});

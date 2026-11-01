import { expect, test, type Page } from "@playwright/test";
import {
  ADMIN, ANNA_ID, APP, CHEF, NOW, confirmDialog, dbEntries, freeze, go, login, loginEmployee, signOutEmployee, statValue,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

async function loginChef(page: Page, email = "chef@demo-kt.example"): Promise<void> {
  await login(page, CHEF, email);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

const brandPrimary = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--brand-primary").trim().toLowerCase());

test("chef: dashboard numbers of the own tenant", async ({ page }) => {
  await loginChef(page);
  await expect(page.getByText("Demo Krankentransporte · November 2026")).toBeVisible();
  // 8 people in the tenant, 1 deactivated → 7 (6 active, 1 invited); one statement waits for review.
  await expect(statValue(page, "Mitarbeitende")).toHaveText("7");
  await expect(page.locator(".stat", { hasText: "Mitarbeitende" }).first()).toContainText("6 aktiv, 1 eingeladen");
  await expect(statValue(page, "Offene Monatsnachweise")).toHaveText("1");
  await expect(page.getByRole("table", { name: "Offene Monatsnachweise" })).toContainText("Ben Muster");
  await expect(page.getByRole("table", { name: "Offene Monatsnachweise" })).toContainText("Oktober 2026");
  // No people of the other tenant.
  await go(page, "#/mitarbeiter");
  await expect(page.getByRole("main")).toContainText("Anna Beispiel");
  await expect(page.getByRole("main")).not.toContainText("Mia Musterfrau");
});

test("chef: returning a statement requires a reason", async ({ page }) => {
  await loginChef(page);
  await go(page, "#/nachweise");
  await expect(page.getByRole("heading", { level: 1, name: "Monatsnachweise" })).toBeVisible();
  await page.getByRole("button", { name: "Nachweis von Ben Muster zurückgeben" }).click();
  const dialog = page.getByRole("dialog", { name: "Monatsnachweis zurückgeben" });
  await dialog.getByRole("button", { name: "Zurückgeben", exact: true }).click();
  await expect(dialog.getByText("Bitte eine Begründung angeben.")).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Begründung (Pflicht)").fill("Bitte den 5. prüfen – Ende fehlt.");
  await dialog.getByRole("button", { name: "Zurückgeben", exact: true }).click();
  await expect(page.locator(".toast").filter({ hasText: "Monatsnachweis zurückgegeben." })).toBeVisible();
  const row = page.getByRole("row", { name: /Ben Muster/ });
  await expect(row).toContainText("Zurückgegeben");
  await expect(row).toContainText("Grund: Bitte den 5. prüfen – Ende fehlt.");

  // The employee sees the reason.
  const app = await page.context().newPage();
  await app.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await login(app, APP, "ben@demo-kt.example");
  await expect(app.getByText("Monatsnachweis Oktober 2026 zurückgegeben")).toBeVisible();
  await expect(app.getByText("Begründung: Bitte den 5. prüfen – Ende fehlt.")).toBeVisible();
});

test("chef: approve a submitted statement", async ({ page }) => {
  await loginChef(page);
  await go(page, "#/nachweise");
  await page.getByRole("button", { name: "Nachweis von Ben Muster freigeben" }).click();
  await confirmDialog(page, "Freigeben");
  await expect(page.locator(".toast").filter({ hasText: "Monatsnachweis freigegeben." })).toBeVisible();
  await expect(page.getByRole("row", { name: /Ben Muster/ })).toContainText("Freigegeben");
  await expect(page.getByText("0 zur Prüfung")).toBeVisible();
});

test("chef: statements page opens the month in which statements wait", async ({ page }) => {
  // Anna submits the current month (November); Ben's October statement is still open.
  const app = await page.context().newPage();
  await app.clock.setFixedTime(NOW);
  await loginEmployee(app);
  await go(app, "#/monat?m=2026-11");
  await app.getByRole("button", { name: "Monatsnachweis einreichen" }).click();
  await confirmDialog(app, "Einreichen");
  await expect(app.locator(".toast").filter({ hasText: "Monatsnachweis eingereicht." })).toBeVisible();
  await app.close();

  await loginChef(page);
  await expect(statValue(page, "Offene Monatsnachweise")).toHaveText("2");
  await page.locator(".stat", { hasText: "Offene Monatsnachweise" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Monatsnachweise" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nachweis von Ben Muster freigeben" })).toBeVisible();
  // The other month with an open statement is pointed out and one click away.
  await expect(page.getByText("1 offener Nachweis im November 2026")).toBeVisible();
  await page.getByRole("button", { name: "November 2026 anzeigen" }).click();
  await expect(page.getByRole("button", { name: "Nachweis von Anna Beispiel freigeben" })).toBeVisible();
  await expect(page.getByText("1 offener Nachweis im Oktober 2026")).toBeVisible();

  // Once October is approved, the menu link opens November directly (before: always the previous month).
  await page.getByRole("button", { name: "Oktober 2026 anzeigen" }).click();
  await page.getByRole("button", { name: "Nachweis von Ben Muster freigeben" }).click();
  await confirmDialog(page, "Freigeben");
  await expect(page.locator(".toast").filter({ hasText: "Monatsnachweis freigegeben." })).toBeVisible();
  await go(page, "#/");
  await page.getByRole("link", { name: /Monatsnachweise/ }).first().click();
  await expect(page.getByRole("button", { name: "Nachweis von Anna Beispiel freigeben" })).toBeVisible();
  await expect(page.getByText(/offener? Nachweis/)).toHaveCount(0);
});

test("chef changes colour and WhatsApp number: visible for the own tenant only", async ({ page }) => {
  await loginChef(page);
  await go(page, "#/firma");
  await expect(page.getByRole("heading", { level: 1, name: "Firmenprofil" })).toBeVisible();
  await page.getByLabel("Hauptfarbe", { exact: true }).fill("#aa3300");
  await page.getByLabel("WhatsApp-Nummer").fill("491701234567");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.locator(".toast").filter({ hasText: "Firmenprofil gespeichert." })).toBeVisible();

  const app = await page.context().newPage();
  await app.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await loginEmployee(app);
  expect(await brandPrimary(app)).toBe("#aa3300");
  await go(app, "#/einstellungen");
  await expect(app.getByRole("link", { name: "WhatsApp an den Betrieb" })).toHaveAttribute("href", /^https:\/\/wa\.me\/491701234567\?/);

  // Other tenant (same browser, same demo database): unchanged.
  await signOutEmployee(app);
  await loginEmployee(app, "mia@muster-pflege.example", "Mia");
  expect(await brandPrimary(app)).toBe("#6b3fa0");
  await go(app, "#/einstellungen");
  await expect(app.getByRole("link", { name: "WhatsApp an den Betrieb" })).toHaveAttribute("href", /^https:\/\/wa\.me\/49300000000\?/);
});

test("two tenants show their own logo and phone number", async ({ page }) => {
  await loginEmployee(page);
  await expect(page.getByRole("img", { name: "Demo Krankentransporte – Logo" })).toHaveAttribute("src", /brands\/uwe\//);
  await go(page, "#/einstellungen");
  await expect(page.getByRole("link", { name: "Anrufen: 0241 000 000 00" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("030 000 000 00");

  await signOutEmployee(page);
  await loginEmployee(page, "mia@muster-pflege.example", "Mia");
  await expect(page.getByRole("img", { name: "Muster Pflegedienst GmbH – Logo" })).toHaveAttribute("src", /brands\/muster\//);
  await go(page, "#/einstellungen");
  await expect(page.getByRole("link", { name: "Anrufen: 030 000 000 00" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("0241 000 000 00");
});

test("employee of tenant B cannot open tenant A data via a manipulated route", async ({ page }) => {
  await page.goto(APP);
  await expect(page.getByRole("heading", { name: "Anmeldung für Mitarbeitende" })).toBeVisible();
  const [annaEntry] = (await dbEntries(page, { employeeId: ANNA_ID })).filter((e) => e.date.startsWith("2026-11"));
  expect(annaEntry).toBeTruthy();

  await loginEmployee(page, "mia@muster-pflege.example", "Mia");
  await go(page, `#/erfassen/${annaEntry!.id}?datum=${annaEntry!.date}`);
  await expect(page.getByRole("alert").filter({ hasText: "Kein Zugriff" })).toContainText("gehört nicht zu deinem Konto");
  await expect(page.getByRole("button", { name: "Änderung speichern" })).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText(`${annaEntry!.start}–${annaEntry!.end}`);
  // Anna's entry is unchanged.
  expect((await dbEntries(page, { employeeId: ANNA_ID })).find((e) => e.id === annaEntry!.id)).toMatchObject({ version: annaEntry!.version, end: annaEntry!.end });

  // The manager of tenant B does not see tenant A's people either.
  const chef = await page.context().newPage();
  await chef.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await login(chef, CHEF, "leitung@muster-pflege.example");
  await go(chef, "#/mitarbeiter");
  await expect(chef.getByRole("main")).toContainText("Mia Musterfrau");
  await expect(chef.getByRole("main")).not.toContainText("Anna Beispiel");
});

test("super-admin: pilot licence badge, no personal time data without support grant", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  const kt = page.getByRole("row", { name: /Demo Krankentransporte/ });
  await expect(kt).toContainText("Kostenlos – Pilot");
  await expect(page.getByRole("row", { name: /Muster Pflegedienst/ })).not.toContainText("Kostenlos – Pilot");
  await expect(statValue(page, "Pilotkunden \\(kostenlos\\)")).toHaveText("1");

  await kt.getByRole("link", { name: "Demo Krankentransporte verwalten" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Demo Krankentransporte" })).toBeVisible();
  await expect(page.getByText("Keine Freigabe")).toBeVisible();
  const main = page.getByRole("main");
  for (const personal of ["Anna Beispiel", "Ben Muster", "Schülertour", "06:30"]) await expect(main).not.toContainText(personal);

  // The owner grants support access → the admin portal shows the active grant (still no time data in this view).
  const chef = await page.context().newPage();
  await chef.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await login(chef, CHEF, "chef@demo-kt.example");
  await go(chef, "#/einstellungen");
  await chef.getByRole("button", { name: "Für 24 Stunden freigeben" }).click();
  await expect(chef.locator(".toast").filter({ hasText: "Supportzugriff für 24 Stunden freigegeben." })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Freigabe durch den Mandanten aktiv")).toBeVisible();
});

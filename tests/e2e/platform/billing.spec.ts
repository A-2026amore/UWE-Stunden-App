import { expect, test, type Page } from "@playwright/test";
import { ADMIN, APP, CHEF, freeze, go, login, statValue } from "./helpers";

// Demo data (frozen today 20.11.2026, seed relative to it): Demo Krankentransporte is a free pilot
// with 4 active employees; Muster Pflegedienst is a standard customer with 3 employees (owner without times).

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

async function openBilling(page: Page, email: string): Promise<void> {
  await login(page, CHEF, email);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/abrechnung");
  await expect(page.getByRole("heading", { level: 1, name: "Abrechnung" })).toBeVisible();
}

test("chef: billing preview with billable persons, gross amount and VAT note", async ({ page }) => {
  await openBilling(page, "leitung@muster-pflege.example");
  await expect(page.locator(".alert-title", { hasText: "Vorschau" })).toBeVisible();
  await expect(statValue(page, "Abrechenbare Personen")).toHaveText("3");
  await expect(statValue(page, "Preis je Person")).toHaveText("5,00 €");
  await expect(statValue(page, "Summe brutto")).toHaveText("15,00 €");
  await expect(page.locator(".stat", { hasText: "Summe brutto" })).toContainText("inkl. gesetzlicher USt.");
  const table = page.getByRole("table", { name: "Abrechenbare Personen" });
  for (const name of ["Mia Musterfrau", "Noah Normal", "Olga Ohnename"]) await expect(table).toContainText(name);
  // The owner records no own times → free.
  await expect(table).not.toContainText("Petra Leitung");
  await expect(page.getByText("3 × 5,00 € = 15,00 € inkl. gesetzlicher USt.")).toBeVisible();

  // Past month: preliminary until the operator closes it.
  await page.getByLabel("Monat").selectOption("2026-10");
  await expect(page.getByText("Noch nicht abgerechnet")).toBeVisible();
  await expect(page.getByRole("table", { name: "Abrechnung je Monat" })).toContainText("Oktober 2026");
});

test("chef: lock an employee – no sign-in, still billed this month", async ({ page }) => {
  await login(page, CHEF, "chef@demo-kt.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/mitarbeiter");
  await page.getByRole("button", { name: "Anna Beispiel sperren" }).click();
  const dialog = page.getByRole("dialog", { name: "Anna Beispiel sperren?" });
  await dialog.getByLabel("Grund").fill("Diensthandy verloren");
  await dialog.getByRole("button", { name: "Sperren", exact: true }).click();
  await expect(page.locator(".toast").filter({ hasText: "Zugang gesperrt." })).toBeVisible();
  await expect(page.getByRole("row", { name: /Anna Beispiel/ })).toContainText("Gesperrt");
  await expect(page.getByRole("button", { name: "Anna Beispiel entsperren" })).toBeVisible();

  // Pilot customer: free, but the count is shown; Anna is still billable in November.
  await go(page, "#/abrechnung");
  await expect(statValue(page, "Abrechenbare Personen")).toHaveText("4");
  await expect(statValue(page, "Summe brutto")).toHaveText("0,00 €");
  await expect(page.getByText("Kostenlos – Pilot").first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Abrechenbare Personen" })).toContainText("Anna Beispiel");

  // Anna cannot sign in any more.
  const app = await page.context().newPage();
  await app.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await login(app, APP, "anna@demo-kt.example");
  await expect(app.getByText("vorübergehend gesperrt")).toBeVisible();
  await expect(app.getByRole("heading", { level: 1, name: "Hallo Anna" })).toHaveCount(0);
});

test("super-admin: revenue numbers without names, close a month, change the default price", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Muster Pflegedienst/ })).toContainText("5,00 € je Mitarbeiter/Monat (Standardpreis)");
  await go(page, "#/umsatz");
  await expect(page.getByRole("heading", { level: 1, name: "Umsatz" })).toBeVisible();
  await expect(page.getByText("Zahlungsdienstleister: keiner (manuelle Abrechnung)")).toBeVisible();

  const main = page.getByRole("main");
  const pflege = page.getByRole("row", { name: /Muster Pflegedienst/ });
  await expect(pflege).toContainText("15,00 €");
  await expect(pflege).toContainText("Vorschau");
  await expect(page.getByRole("row", { name: /Demo Krankentransporte/ })).toContainText("Kostenlos – Pilot");
  // Both demo tenants are not revenue.
  await expect(statValue(page, "Umsatz brutto")).toHaveText("0,00 €");
  await expect(statValue(page, "Demo-Mandanten")).toHaveText("15,00 €");
  for (const personal of ["Mia Musterfrau", "Anna Beispiel", "Petra Leitung"]) await expect(main).not.toContainText(personal);
  // The current month cannot be closed.
  await expect(page.getByRole("button", { name: /Abrechnungsstatus .* ändern/ })).toHaveCount(0);

  // Close October.
  await page.getByLabel("Monat").selectOption("2026-10");
  await page.getByRole("button", { name: "Abrechnungsstatus Muster Pflegedienst GmbH ändern" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Abrechnungsstatus").selectOption("invoiced");
  await dialog.getByLabel(/Notiz/).fill("RE-2026-10-001");
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Abrechnungsstatus „In Rechnung gestellt“ gespeichert." })).toBeVisible();
  await expect(pflege).toContainText("In Rechnung gestellt");
  await expect(pflege).toContainText("festgeschrieben");

  // New default price: the current month changes, the closed October stays.
  await go(page, "#/lizenzen");
  await expect(page.getByTestId("default-price")).toContainText("5,00 €");
  await page.getByLabel("Neuer Standardpreis (€ brutto)").fill("6,00");
  await page.getByLabel("Grund (Protokoll)").fill("Preisanpassung Test");
  await page.getByRole("button", { name: "Standardpreis speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Standardpreis auf 6,00 € gesetzt." })).toBeVisible();
  await go(page, "#/umsatz");
  await expect(pflege).toContainText("18,00 €");
  await page.getByLabel("Monat").selectOption("2026-10");
  await expect(pflege).toContainText("15,00 €");

  // Audit (platform protocol).
  await go(page, "#/protokoll");
  await expect(main).toContainText("Abrechnungsstatus geändert");
  await expect(main).toContainText("Standardpreis geändert");

  // The tenant sees the closed month.
  const chef = await page.context().newPage();
  await chef.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await openBilling(chef, "leitung@muster-pflege.example");
  await chef.getByLabel("Monat").selectOption("2026-10");
  await expect(chef.getByText("Abgeschlossen: Oktober 2026")).toBeVisible();
  await expect(statValue(chef, "Summe brutto")).toHaveText("15,00 €");
});

test("super-admin: special condition for a tenant", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await page.getByRole("link", { name: "Muster Pflegedienst GmbH verwalten" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Muster Pflegedienst GmbH" })).toBeVisible();
  await expect(page.getByTestId("tenant-billable")).toHaveText("3");
  await page.getByLabel("Sonderpreis je Mitarbeiter (€ brutto)").fill("3,50");
  await page.getByLabel("Notiz zur Kondition").fill("Einführungsrabatt");
  await page.getByLabel("Grund der Änderung (Protokoll)").fill("Vertrag 2026");
  await page.getByRole("button", { name: "Lizenz speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Lizenz gespeichert." })).toBeVisible();
  await expect(page.getByTestId("tenant-price")).toHaveText("3,50 € je Mitarbeiter/Monat (Sonderpreis)");
  await expect(page.getByRole("main")).toContainText("10,50 €");

  // No free accounts any more: the option is not offered for a paying customer.
  await expect(page.getByLabel("Kostenloses Konto")).toHaveCount(0);
});

test("promo code: super-admin creates, owner redeems (0 €), super-admin ends the discount", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await go(page, "#/aktionscodes");
  await expect(page.getByRole("heading", { level: 1, name: "Aktionscodes" })).toBeVisible();
  await page.getByLabel("Code").fill("start-100");
  await expect(page.getByLabel("Nachlass (%)")).toHaveValue("100");
  await page.getByRole("button", { name: "Aktionscode anlegen" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Aktionscode START-100 (−100 %) angelegt." })).toBeVisible();
  await expect(page.getByTestId("promo-code")).toHaveText("START-100");

  const chef = await page.context().newPage();
  await chef.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await openBilling(chef, "leitung@muster-pflege.example");
  await chef.getByLabel("Aktionscode").fill("FALSCH-123");
  await chef.getByRole("button", { name: "Einlösen" }).click();
  await expect(chef.getByText("Der Aktionscode ist ungültig oder nicht mehr einlösbar.")).toBeVisible();
  await chef.getByLabel("Aktionscode").fill("start-100");
  await chef.getByRole("button", { name: "Einlösen" }).click();
  await expect(chef.locator(".toast").filter({ hasText: "Aktionscode START-100 eingelöst" })).toBeVisible();
  await expect(chef.getByTestId("promo-running")).toBeVisible();
  await expect(statValue(chef, "Preis je Person")).toHaveText("0,00 €");
  await expect(statValue(chef, "Summe brutto")).toHaveText("0,00 €");

  await page.reload();
  await expect(page.getByRole("row", { name: /Muster Pflegedienst/ })).toContainText("läuft");
  await page.getByRole("button", { name: "Rabatt für Muster Pflegedienst GmbH beenden" }).click();
  const ask = page.getByRole("dialog", { name: "Rabatt für Muster Pflegedienst GmbH beenden?" });
  await expect(ask).toContainText("ab dem Folgemonat gilt der normale Preis");
  await ask.getByRole("textbox").fill("Aktion vorbei");
  await ask.getByRole("button", { name: "Rabatt beenden" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Rabatt beendet." })).toBeVisible();
  await expect(page.getByRole("row", { name: /Muster Pflegedienst/ })).toContainText("Aktion vorbei");
  await go(page, "#/protokoll");
  await expect(page.getByRole("main")).toContainText("Aktionscode eingelöst");
  await expect(page.getByRole("main")).toContainText("Aktionsrabatt beendet");
});

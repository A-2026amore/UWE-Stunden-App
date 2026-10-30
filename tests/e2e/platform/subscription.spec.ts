import { expect, test, type Page } from "@playwright/test";
import { ADMIN, CHEF, NOW, freeze, go, login, statValue } from "./helpers";

// Subscription (migration 0023), demo frozen at 20.11.2026: Muster Pflegedienst has the monthly plan since its
// creation (no trial); the owner is "leitung@muster-pflege.example".

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

async function openBilling(page: Page): Promise<void> {
  await go(page, "#/abrechnung");
  await expect(page.getByRole("heading", { level: 1, name: "Abrechnung" })).toBeVisible();
}

test("owner: switch to the 12-month subscription, cancel with monthly afterwards, withdraw", async ({ page }) => {
  await login(page, CHEF, "leitung@muster-pflege.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await openBilling(page);
  const tariff = page.locator(".card", { has: page.getByRole("heading", { name: "Tarif", exact: true }) });
  await expect(page.getByTestId("subscription-plan")).toContainText("Monatstarif: 6,50 €");
  await expect(statValue(page, "Preis je Person")).toHaveText("6,50 €");

  await tariff.getByRole("button", { name: "Zum 12-Monats-Abo wechseln" }).click();
  const confirm = page.getByRole("dialog", { name: "Zum 12-Monats-Abo wechseln?" });
  await expect(confirm).toContainText("beginnt am 01.12.2026");
  await expect(confirm).toContainText("bis 30.11.2027");
  await expect(confirm).toContainText("um 6 Monate, wenn Sie nicht bis 30.11.2027 kündigen");
  await confirm.getByRole("button", { name: "Verbindlich wechseln" }).click();
  await expect(page.locator(".toast").filter({ hasText: "12-Monats-Abo ab 01.12.2026 gewählt." })).toBeVisible();
  await expect(page.getByTestId("subscription-next")).toContainText("12-Monats-Abo ab 01.12.2026 (5,00 €");
  await expect(tariff.getByRole("button", { name: "Zum 12-Monats-Abo wechseln" })).toHaveCount(0);
  // November is still billed in the monthly plan.
  await expect(statValue(page, "Preis je Person")).toHaveText("6,50 €");

  // December: the subscription runs.
  await page.clock.setFixedTime(new Date("2026-12-10T10:00:00+01:00"));
  await page.reload();
  await openBilling(page);
  await expect(page.getByTestId("subscription-plan")).toContainText("12-Monats-Abo: 5,00 €");
  await expect(page.getByTestId("subscription-term-end")).toContainText("30.11.2027");
  await expect(statValue(page, "Preis je Person")).toHaveText("5,00 €");

  await tariff.getByRole("button", { name: "Kündigen" }).click();
  const cancel = page.getByRole("dialog", { name: "12-Monats-Abo kündigen?" });
  await expect(cancel.getByTestId("cancel-end")).toContainText("30.11.2027");
  await expect(cancel.getByLabel("Danach im Monatstarif weiter")).toBeChecked();
  await cancel.getByRole("button", { name: "Kündigen", exact: true }).click();
  await expect(page.locator(".toast").filter({ hasText: "Gekündigt zum 30.11.2027, danach Monatstarif." })).toBeVisible();
  await expect(page.getByTestId("subscription-cancelled")).toHaveText("30.11.2027, danach Monatstarif");
  await expect(page.getByTestId("subscription-next")).toContainText("Monatstarif ab 01.12.2027");

  await tariff.getByRole("button", { name: "Kündigung zurücknehmen" }).click();
  await page.getByRole("dialog", { name: "Kündigung zurücknehmen?" }).getByRole("button", { name: "Zurücknehmen" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Kündigung zurückgenommen." })).toBeVisible();
  await expect(page.getByTestId("subscription-cancelled")).toHaveCount(0);
  await expect(page.getByTestId("subscription-next")).toHaveCount(0);
  await expect(page.getByTestId("subscription-term-end")).toContainText("30.11.2027");

  await go(page, "#/protokoll");
  const main = page.getByRole("main");
  for (const label of ["Tarif gewählt", "Vertrag gekündigt", "Kündigung zurückgenommen"]) await expect(main).toContainText(label);
});

test("manager: sees the plan read-only", async ({ page }) => {
  await page.goto(CHEF);
  await page.getByLabel("E-Mail-Adresse").fill("dispo@demo-kt.example");
  await page.getByLabel("Passwort").fill("demo");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await openBilling(page);
  await expect(page.getByTestId("subscription-plan")).toContainText("Monatstarif");
  await expect(page.getByText("Den Tarif ändert nur die Inhaberin oder der Inhaber.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Kündigen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zum 12-Monats-Abo wechseln" })).toHaveCount(0);
});

test("super-admin: trial window and welcome code; the owner of a new tenant first concludes the contract", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  await go(page, "#/aktionscodes");
  await page.getByLabel("Code").fill("WILLKOMMEN-10");
  await page.getByLabel("Nachlass (%)").fill("10");
  await page.getByRole("button", { name: "Aktionscode anlegen" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Aktionscode WILLKOMMEN-10 (−10 %) angelegt." })).toBeVisible();

  await go(page, "#/lizenzen");
  await expect(page.getByTestId("billing-settings")).toContainText("keines");
  await page.getByLabel("Einführungsangebot von").fill("2026-11-01");
  await page.getByLabel("Einführungsangebot bis").fill("2026-12-31");
  await page.getByLabel("Testphase (Monate)").fill("3");
  await page.getByLabel("Willkommenscode").selectOption({ label: "WILLKOMMEN-10 (−10 %)" });
  await expect(page.getByText("Rabatt bis auf Weiteres; der Anbieter kann ihn zum Ende eines Kalendermonats beenden.").first()).toBeVisible();
  await page.getByLabel("Grund (Protokoll)").fill("Winteraktion");
  await page.getByRole("button", { name: "Einstellungen speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Preise und Tarifeinstellungen gespeichert." })).toBeVisible();
  await expect(page.getByTestId("billing-settings")).toContainText("01.11.2026 bis 31.12.2026, 3 Monate kostenlos");
  await expect(page.getByTestId("billing-settings")).toContainText("WILLKOMMEN-10");

  await go(page, "#/");
  await page.getByRole("button", { name: "Mandant anlegen" }).click();
  const dialog = page.getByRole("dialog", { name: "Mandant anlegen" });
  await expect(dialog).toContainText("Einführungsangebot");
  await dialog.getByLabel("Firmenname").fill("Test Fahrdienst");
  await dialog.getByLabel("E-Mail des Inhabers").fill("inhaber@test-fahrdienst.example");
  await dialog.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Willkommenscode: WILLKOMMEN-10." })).toBeVisible();
  // Created 20.11.2026: 3 months end on 19.02.2027 → free until the end of February.
  await expect(page.getByRole("row", { name: /Test Fahrdienst/ })).toContainText("0,00 € – Testphase bis 28.02.2027");
  await page.getByRole("link", { name: "Test Fahrdienst verwalten" }).click();
  const facts = page.getByTestId("subscription-facts");
  await expect(facts).toContainText("noch nicht freigeschaltet");
  await expect(facts).toContainText("kostenlos bis 28.02.2027");
  await expect(facts).toContainText("erster bezahlter Monat: März 2027");

  // The owner sees only "Firma freischalten" until the contract is concluded.
  const chef = await page.context().newPage();
  await chef.clock.setFixedTime(NOW);
  await chef.goto(CHEF);
  await chef.getByLabel("E-Mail-Adresse").fill("inhaber@test-fahrdienst.example");
  await chef.getByLabel("Passwort").fill("demo");
  await chef.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(chef.getByRole("heading", { level: 1, name: "Firma freischalten" })).toBeVisible();
  await expect(chef.getByRole("heading", { level: 1, name: "Dashboard" })).toHaveCount(0);
  await expect(chef.getByTestId("contract-trial")).toContainText("Kostenlos bis 28.02.2027");
  await expect(chef.getByLabel(/^Monatstarif/)).toBeChecked();
  await expect(chef.getByText("Ohne Wahl gilt der Monatstarif.")).toBeVisible();
  await expect(chef.getByRole("link", { name: "AGB" })).toHaveAttribute("href", "../rechtliches/agb/");
  await expect(chef.getByRole("link", { name: "Auftragsverarbeitungsvertrag (AVV)" })).toHaveAttribute("href", "../rechtliches/avv/");
  const submit = chef.getByRole("button", { name: "Jetzt freischalten – kostenlos bis 28.02.2027, danach kostenpflichtig" });
  await expect(submit).toBeDisabled();
  await chef.getByLabel("Wir handeln als Unternehmer (§ 14 BGB), nicht als Verbraucher.").check();
  await expect(submit).toBeDisabled();
  await chef.getByLabel(/Ich habe die AGB/).check();
  await submit.click();
  await expect(chef.getByRole("heading", { level: 1, name: "Abrechnung" })).toBeVisible();
  await expect(chef.getByTestId("subscription-facts")).toContainText("kostenlos bis 28.02.2027");
  await expect(chef.getByTestId("subscription-plan")).toContainText("Monatstarif: 6,50 € je Mitarbeiter/Monat ab 01.03.2027");
  await expect(statValue(chef, "Preis je Person")).toHaveText("0,00 €");

  await page.reload();
  await expect(page.getByTestId("subscription-facts")).toContainText(/geschlossen am 20\.11\.2026 \(AGB /);
});

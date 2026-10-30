import { expect, test } from "@playwright/test";
import { CHEF, go, login, loginEmployee } from "./helpers";

// Demo mode: Emil Platzhalter (1005) left on 21 October 2026.
test("chef: data protection page – retention period, access export, anonymisation, company export", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await login(page, CHEF, "chef@demo-kt.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/datenschutz");
  await expect(page.getByRole("heading", { level: 1, name: "Datenschutz" })).toBeVisible();
  await expect(page.getByText("Rechtlich prüfen")).toBeVisible();

  // Without a retention period nobody can be anonymised.
  const row = page.getByRole("row", { name: /Emil Platzhalter/ });
  await expect(row.getByRole("button", { name: "Anonymisieren …" })).toBeDisabled();

  await page.getByLabel(/Frist in Monaten/).fill("0");
  await page.getByRole("button", { name: "Frist speichern" }).click();
  await expect(page.getByText("Bitte eine ganze Zahl von 1 bis 600 Monaten")).toBeVisible();
  await page.getByLabel(/Frist in Monaten/).fill("1");
  await page.getByRole("button", { name: "Frist speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Aufbewahrungsfrist gespeichert." })).toBeVisible();

  // Period still running.
  await row.getByRole("button", { name: "Anonymisieren …" }).click();
  let dialog = page.getByRole("dialog", { name: "Emil Platzhalter anonymisieren?" });
  await dialog.getByLabel(/Personalnummer eingeben/).fill("1005");
  await dialog.getByRole("button", { name: "Endgültig anonymisieren" }).click();
  dialog = page.getByRole("dialog", { name: "Anonymisieren nicht möglich" });
  await expect(dialog).toContainText("läuft noch bis zum 21.11.2026");
  await dialog.getByRole("button", { name: "OK" }).click();

  // Access export for one person (JSON download).
  await page.getByLabel("Person").selectOption({ label: "Anna Beispiel (1001)" });
  const [json] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Vollständig (JSON)" }).first().click()]);
  expect(json.suggestedFilename()).toMatch(/^datenauskunft-1001-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(await (await json.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8")));
  expect(data).toMatchObject({ format: "stundenwerk.personal-data.v1", requestedBy: "owner", person: { displayName: "Anna Beispiel" } });

  // One month later the period has passed: wrong number is refused, the right one anonymises.
  await page.clock.setFixedTime(new Date("2026-12-01T10:00:00+01:00"));
  await row.getByRole("button", { name: "Anonymisieren …" }).click();
  dialog = page.getByRole("dialog", { name: "Emil Platzhalter anonymisieren?" });
  await dialog.getByLabel(/Personalnummer eingeben/).fill("9999");
  await dialog.getByRole("button", { name: "Endgültig anonymisieren" }).click();
  await expect(page.getByRole("dialog", { name: "Anonymisieren nicht möglich" })).toContainText("Personalnummer");
  await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();
  await page.getByRole("row", { name: /Emil Platzhalter/ }).getByRole("button", { name: "Anonymisieren …" }).click();
  dialog = page.getByRole("dialog", { name: "Emil Platzhalter anonymisieren?" });
  await dialog.getByLabel(/Personalnummer eingeben/).fill("1005");
  await dialog.getByRole("button", { name: "Endgültig anonymisieren" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Der Datensatz wurde anonymisiert." })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("Emil Platzhalter");
  await expect(page.getByRole("table", { name: "Deaktivierte Mitarbeitende" })).toContainText("anonymisiert am");

  // Company export (CSV) no longer contains the name.
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Arbeitszeiten (CSV)" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^firmendaten-.*\.csv$/);
  const text = await (await csv.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  expect(text).toContain("Personalnummer;Name;Datum");
  expect(text).toContain("Anna Beispiel");
  expect(text).not.toContain("Emil Platzhalter");
});

test("chef: managers see no data protection functions", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await page.goto(CHEF);
  await page.getByLabel("E-Mail-Adresse").fill("dispo@demo-kt.example");
  await page.getByLabel("Passwort").fill("demo");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/datenschutz");
  await expect(page.getByText("dem Inhaber vorbehalten")).toBeVisible();
  await expect(page.getByRole("button", { name: "Frist speichern" })).toHaveCount(0);
});

test("employee: downloads own data in the settings", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await loginEmployee(page);
  await go(page, "#/einstellungen");
  await expect(page.getByRole("heading", { name: "Meine Daten" })).toBeVisible();
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Als Tabelle (CSV)" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^datenauskunft-1001-.*\.csv$/);
  const text = await (await csv.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text).toContain("Datenauskunft (Art. 15 DSGVO)");
  expect(text).toContain("Anna Beispiel");
  expect(text).toContain("anna@demo-kt.example");
});

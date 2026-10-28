import { expect, test, type Page } from "@playwright/test";
import { ANNA_ID, APP, CHEF, FREE_DAY, MIA_ID, confirmDialog, dbEntries, fillEntry, freeze, go, login, loginEmployee, saveEntry } from "./helpers";

// Client requirement 2026-10-28: no pre-filled pause – only the pause actually taken is entered.

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

const pauseField = (page: Page) => page.getByLabel("Pause", { exact: true });
const hint = (page: Page) => page.getByTestId("pause-hint");

test("employee: pause starts empty, hint names the minimum, too short pause is not saved", async ({ page }) => {
  await loginEmployee(page);
  await go(page, "#/erfassen");
  await expect(pauseField(page)).toHaveValue("");

  await fillEntry(page, { date: FREE_DAY, start: "08:00", end: "14:00", note: "E2E Pause" });
  // UWE replica (strict rule): from exactly 6 h.
  await expect(hint(page)).toContainText("Für diesen Tag (6,00 Std. Einsatzzeit) sind mindestens 30 Minuten Pause vorgeschrieben (Regel: ab 6 Stunden).");
  await expect(hint(page)).toContainText("Trage nur die Pause ein, die du tatsächlich genommen hast.");
  await expect(hint(page)).not.toContainText("Vorschlag");
  await expect(pauseField(page)).toHaveValue("");

  // Empty pause → required.
  await page.getByRole("button", { name: "Arbeitszeit speichern" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Bitte trage die tatsächlich genommene Pause ein – 0, wenn du keine Pause gemacht hast." })).toBeVisible();

  // Too short → refused with friendly advice, nothing stored.
  await pauseField(page).fill("15");
  await page.getByRole("button", { name: "Arbeitszeit speichern" }).click();
  const refused = page.getByRole("alert").filter({ hasText: "So kann der Einsatz nicht gespeichert werden." });
  await expect(refused).toContainText("Es fehlen noch 15 Minuten gültige Pause");
  await expect(refused).toContainText("erfasse den Tag als mehrere Einsätze");
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "E2E Pause" })).toHaveLength(0);

  await pauseField(page).fill("30");
  await saveEntry(page);
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "E2E Pause" })).toMatchObject([{ start: "08:00", end: "14:00", pauseMinutes: 30 }]);
  // The next entry starts with an empty pause again.
  await expect(pauseField(page)).toHaveValue("");
});

test("employee of a tenant with the statutory rule: exactly 6 h needs no pause, 0 is a valid entry", async ({ page }) => {
  await loginEmployee(page, "mia@muster-pflege.example", "Mia");
  await go(page, "#/erfassen");
  await fillEntry(page, { date: FREE_DAY, start: "08:00", end: "14:00", note: "E2E gesetzlich" });
  await expect(hint(page)).toContainText("ist keine Mindestpause vorgeschrieben (Pausenpflicht erst mehr als 6 Stunden).");
  await expect(hint(page)).toContainText("– 0, wenn du keine gemacht hast.");
  await pauseField(page).fill("0");
  await saveEntry(page);
  expect(await dbEntries(page, { employeeId: MIA_ID, note: "E2E gesetzlich" })).toMatchObject([{ pauseMinutes: 0 }]);

  await fillEntry(page, { date: "2026-11-08", start: "08:00", end: "14:01", pause: "0", note: "E2E gesetzlich 2" });
  await expect(hint(page)).toContainText("mindestens 30 Minuten Pause vorgeschrieben (Regel: mehr als 6 Stunden)");
  await page.getByRole("button", { name: "Arbeitszeit speichern" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "So kann der Einsatz nicht gespeichert werden." })).toBeVisible();
  expect(await dbEntries(page, { employeeId: MIA_ID, note: "E2E gesetzlich 2" })).toHaveLength(0);
});

test("chef: owner switches the break rule; texts and the employee app follow the configuration", async ({ page }) => {
  await login(page, CHEF, "chef@demo-kt.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/einstellungen");
  const summary = page.getByTestId("break-rule-summary");
  await expect(summary).toContainText("Strenge Regel (strenger als § 4 Arbeitszeitgesetz): ab 6 Stunden Arbeitszeit mindestens 30 Minuten Pause, ab 9 Stunden mindestens 45 Minuten.");
  const table = page.getByRole("table", { name: "Pausenschwellen" });
  await expect(table).toContainText("ab 6 Stunden");

  await page.getByLabel("Pausenregel").selectOption("statutory");
  await page.getByRole("button", { name: "Pausenregel speichern" }).click();
  await confirmDialog(page, "Pausenregel ändern");
  await expect(page.locator(".toast").filter({ hasText: "Pausenregel gespeichert." })).toBeVisible();
  await expect(summary).toContainText("Gesetzliche Regel nach § 4 Arbeitszeitgesetz: bei mehr als 6 Stunden Arbeitszeit mindestens 30 Minuten Pause, bei mehr als 9 Stunden mindestens 45 Minuten.");
  await expect(table).toContainText("mehr als 9 Stunden");

  // Same demo database: the employee app now applies "more than 6 hours".
  const app = await page.context().newPage();
  await freeze(app);
  await login(app, APP, "anna@demo-kt.example");
  await expect(app.getByRole("heading", { level: 1, name: "Hallo Anna" })).toBeVisible();
  await go(app, "#/erfassen");
  await fillEntry(app, { date: FREE_DAY, start: "08:00", end: "14:00" });
  await expect(hint(app)).toContainText("ist keine Mindestpause vorgeschrieben (Pausenpflicht erst mehr als 6 Stunden).");
  await app.close();

  // And back to the strict rule.
  await page.getByLabel("Pausenregel").selectOption("strict");
  await page.getByRole("button", { name: "Pausenregel speichern" }).click();
  await confirmDialog(page, "Pausenregel ändern");
  await expect(summary).toContainText("Strenge Regel");
});

test("chef correction: pause hint names the minimum, too short pause is refused", async ({ page }) => {
  await login(page, CHEF, "chef@demo-kt.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/zeiten");
  await page.getByRole("button", { name: /korrigieren$/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "Arbeitszeit korrigieren" });
  // Move to an otherwise empty day so only this entry counts.
  await dialog.getByLabel("Datum", { exact: true }).fill(FREE_DAY);
  await dialog.getByLabel("Beginn", { exact: true }).fill("06:00");
  await dialog.getByLabel("Ende", { exact: true }).fill("16:00");
  await dialog.getByLabel("Pause (Min.)").fill("30");
  await expect(dialog.getByTestId("correction-pause-hint")).toContainText("mindestens 45 Minuten Pause vorgeschrieben (Regel: ab 9 Stunden). Nur die tatsächlich genommene Pause eintragen.");
  await dialog.getByLabel("Begründung der Korrektur").fill("E2E Pausenprüfung");
  await dialog.getByRole("button", { name: "Korrektur speichern" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Die Korrektur wird so nicht gespeichert." })).toBeVisible();
  await expect(dialog).toBeVisible();
});

import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  ANNA_ID, BASE, FREE_DAY, confirmDialog, dbEntries, fillEntry, freeze, go, loginEmployee, minutesOf, saveEntry, statValue,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

test("start page lists the three areas and the demo logins", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { level: 1, name: /Demo-Umgebung/ })).toBeVisible();
  for (const area of ["Mitarbeiter-App", "Chef-Portal", "Super-Admin"]) {
    await expect(page.getByRole("link", { name: `${area} öffnen` })).toBeVisible();
  }
  await expect(page.getByRole("table", { name: "Demo-Zugänge" })).toContainText("anna@demo-kt.example");
  await expect(page.getByText("Alle Firmen, Personen und Zeiten sind")).toBeVisible();
  await page.getByRole("link", { name: "Mitarbeiter-App öffnen" }).click();
  await expect(page.getByRole("heading", { name: "Anmeldung für Mitarbeitende" })).toBeVisible();
});

test("wrong password is rejected", async ({ page }) => {
  await page.goto(`${BASE}/app/`);
  await page.getByLabel("E-Mail-Adresse").fill("anna@demo-kt.example");
  await page.getByLabel("Passwort").fill("falsch");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("E-Mail-Adresse oder Passwort ist falsch.");
});

test("employee: create with pause rule, edit, delete, month total", async ({ page }) => {
  await loginEmployee(page);
  await go(page, "#/erfassen");
  await expect(page.getByRole("heading", { level: 1, name: "Arbeitszeit erfassen" })).toBeVisible();

  // 7 h without pause → statutory break rule message, saving is refused.
  await fillEntry(page, { date: FREE_DAY, start: "08:00", end: "15:00", pause: "0", note: "E2E Einsatz" });
  await expect(page.getByText("Es fehlen noch 30 Minuten gültige Pause")).toBeVisible();
  await page.getByRole("button", { name: "Arbeitszeit speichern" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "mindestens 30 Minuten Pause erforderlich" })).toBeVisible();
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "E2E Einsatz" })).toHaveLength(0);

  await page.getByLabel("Pause", { exact: true }).fill("30");
  await expect(page.getByText("Es fehlen noch")).toHaveCount(0);
  await saveEntry(page);
  const dayCard = page.locator(".card").filter({ hasText: "Einsätze am Sonntag, 15.11.2026" });
  await expect(dayCard).toContainText("08:00–15:00 Uhr");
  await expect(dayCard).toContainText("6,50 Std.");
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "E2E Einsatz" })).toMatchObject([{ start: "08:00", end: "15:00", pauseMinutes: 30, version: 1 }]);

  // Edit
  await dayCard.getByRole("button", { name: "Einsatz 08:00–15:00 bearbeiten" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Einsatz bearbeiten" })).toBeVisible();
  await page.getByLabel("Arbeitsende", { exact: true }).fill("14:00");
  await page.getByRole("button", { name: "Änderung speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Änderung gespeichert." })).toBeVisible();
  await expect(dayCard).toContainText("08:00–14:00 Uhr");
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "E2E Einsatz" })).toMatchObject([{ end: "14:00", version: 2 }]);

  // Month total = sum of all day totals and contains the new entry
  await go(page, "#/monat?m=2026-11");
  await expect(page.getByRole("heading", { level: 2, name: "November 2026" })).toBeVisible();
  const day = page.locator(".day-group").filter({ hasText: "Sonntag, 15.11.2026" });
  await expect(day).toContainText("5,50 Std.");
  const worked = minutesOf(await page.locator("dt", { hasText: "Tatsächlich geleistete Stunden" }).locator("xpath=following-sibling::dd[1]").innerText());
  const dayTotals = await page.locator(".day-group .day-head .num").allInnerTexts();
  expect(dayTotals.length).toBeGreaterThan(5);
  expect(dayTotals.reduce((s, t) => s + minutesOf(t), 0)).toBe(worked);
  const dbSum = (await dbEntries(page, { employeeId: ANNA_ID })).filter((e) => e.date.startsWith("2026-11"))
    .reduce((s, e) => { const [sh, sm] = e.start.split(":").map(Number); const [eh, em] = e.end.split(":").map(Number); let g = eh! * 60 + em! - (sh! * 60 + sm!); if (g <= 0) g += 1440; return s + g - e.pauseMinutes; }, 0);
  expect(worked).toBe(dbSum);

  // Delete (soft delete on the server)
  await day.getByRole("button", { name: /Einsatz am 15\.11\.2026 08:00–14:00 löschen/ }).click();
  await confirmDialog(page, "Löschen");
  await expect(page.locator(".toast").filter({ hasText: "Einsatz gelöscht." })).toBeVisible();
  await expect(page.locator(".day-group").filter({ hasText: "Sonntag, 15.11.2026" })).toHaveCount(0);
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "E2E Einsatz" })).toHaveLength(0);
  expect((await dbEntries(page, { employeeId: ANNA_ID, note: "E2E Einsatz", includeDeleted: true }))[0]?.deletedAt).toBeTruthy();
  const after = minutesOf(await page.locator("dt", { hasText: "Tatsächlich geleistete Stunden" }).locator("xpath=following-sibling::dd[1]").innerText());
  expect(after).toBe(worked - 330);
});

test("work account: billing = worked − allocated (calendar-year tenant without approval)", async ({ page }) => {
  await loginEmployee(page, "mia@muster-pflege.example", "Mia");
  await go(page, "#/konto");
  await expect(page.getByRole("heading", { level: 1, name: "Arbeitszeitkonto" })).toBeVisible();
  const card = page.locator(".card").filter({ hasText: "Monatsstunden aufteilen: November 2026" });
  const worked = minutesOf(await statValue(card, "Geleistete Stunden").innerText());
  expect(worked).toBeGreaterThan(0);
  expect(minutesOf(await statValue(card, "Ins Arbeitszeitkonto").innerText())).toBe(0);
  expect(minutesOf(await statValue(card, "Für Abrechnung vorgesehen").innerText())).toBe(worked);

  await card.getByRole("button", { name: "50 %" }).click();
  const half = Math.floor((worked * 0.5) / 15) * 15;
  await expect(card.locator(".preview")).toContainText("ins Konto");
  await card.getByRole("button", { name: "Aufteilung für diesen Monat speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Aufteilung gespeichert." })).toBeVisible();
  await expect(statValue(card, "Ins Arbeitszeitkonto")).toHaveText(new RegExp(`^${(half / 60).toFixed(2).replace(".", ",")} Std\\.$`));
  const allocated = minutesOf(await statValue(card, "Ins Arbeitszeitkonto").innerText());
  const billing = minutesOf(await statValue(card, "Für Abrechnung vorgesehen").innerText());
  expect(allocated).toBe(half);
  expect(billing).toBe(worked - allocated);
  // Worked hours stay documented unchanged.
  expect(minutesOf(await statValue(card, "Geleistete Stunden").innerText())).toBe(worked);

  // Same split on the month page.
  await go(page, "#/monat?m=2026-11");
  await expect(page.locator(".stat-hero .stat-value")).toHaveText(new RegExp((billing / 60).toFixed(2).replace(".", ",")));
  await expect(page.locator("dt", { hasText: "Davon ins Arbeitszeitkonto übertragen" }).locator("xpath=following-sibling::dd[1]")).toContainText((allocated / 60).toFixed(2).replace(".", ","));

  // An allocation above the worked hours is refused.
  await go(page, "#/konto");
  await card.getByLabel(/Wie viele Stunden/).fill(String(Math.ceil(worked / 60) + 10));
  await expect(card.getByText(/Du kannst höchstens/)).toBeVisible();
});

test("PDF statement of a month with many entries has several pages", async ({ page }) => {
  await loginEmployee(page);
  await go(page, "#/monat?m=2026-10");
  await expect(page.getByRole("heading", { level: 2, name: "Oktober 2026" })).toBeVisible();
  expect((await page.locator(".shift").count())).toBeGreaterThan(20);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDF speichern" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const pages = bytes.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? [];
  expect(pages.length).toBeGreaterThan(1);
});

test("monthly statement can be submitted and locks the month", async ({ page }) => {
  await loginEmployee(page);
  await go(page, "#/monat?m=2026-11");
  await expect(page.getByRole("heading", { level: 2, name: "November 2026" })).toBeVisible();
  await expect(page.getByText("Nicht eingereicht")).toBeVisible();
  await page.getByRole("button", { name: "Monatsnachweis einreichen" }).click();
  await confirmDialog(page, "Einreichen");
  await expect(page.locator(".toast").filter({ hasText: "Monatsnachweis eingereicht." })).toBeVisible();
  await expect(page.locator(".card").filter({ hasText: "November 2026" }).getByText("Eingereicht", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Monatsnachweis einreichen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /bearbeiten$/ })).toHaveCount(0);
  await go(page, `#/erfassen?datum=${FREE_DAY}`);
  await expect(page.getByText("Monat eingereicht")).toBeVisible();
  await expect(page.getByRole("button", { name: "Arbeitszeit speichern" })).toBeDisabled();
});

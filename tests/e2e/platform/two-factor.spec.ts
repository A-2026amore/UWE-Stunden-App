/**
 * Two-factor authentication in the demo build (browser-only demo database):
 * setup in the settings with the shown secret, sign-in with the demo button
 * "Demo: aktuellen Code einsetzen" and with a recovery code.
 */
import { expect, test, type Page } from "@playwright/test";
import { base32Decode, hotp, timeStep } from "../../../platform/src/security/totp";
import { APP, NOW, freeze, go, loginEmployee } from "./helpers";

async function signOut(page: Page): Promise<void> {
  await go(page, "#/einstellungen");
  await page.getByRole("main").getByRole("button", { name: "Abmelden" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Abmelden" }).click();
  await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

const CODE_LABEL = "Bestätigungscode aus der Authenticator-App";

test("demo: employee sets up 2FA, signs in with the demo code and once with a recovery code", async ({ page }) => {
  await loginEmployee(page);
  await go(page, "#/einstellungen");
  const card = page.locator("#zwei-faktor");
  await card.getByRole("button", { name: "Zwei-Faktor-Anmeldung einrichten" }).click();
  await expect(card.getByRole("img", { name: /QR-Code für die Authenticator-App \(Schichtklar24 Demo, anna@demo-kt\.example\)/ })).toBeVisible();
  const secret = (await card.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  // What an authenticator app shows at the (frozen) current time.
  const code = hotp(base32Decode(secret), timeStep(NOW.getTime()));
  await card.getByLabel(CODE_LABEL).fill(code);
  await card.getByRole("button", { name: "Bestätigen und aktivieren" }).click();
  const list = card.getByRole("list", { name: "Wiederherstellungscodes" });
  await expect(list.getByRole("listitem")).toHaveCount(10);
  const recovery = (await list.getByRole("listitem").first().innerText()).trim();
  await card.getByLabel("Ich habe die Wiederherstellungscodes sicher gespeichert.").check();
  await card.getByRole("button", { name: "Fertig" }).click();
  await expect(card.getByText("Aktiv", { exact: true })).toBeVisible();
  await signOut(page);

  // Password, then the demo button fills the current (not yet used) code.
  await page.goto(APP);
  await page.getByRole("button", { name: "anna@demo-kt.example", exact: true }).click();
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bestätigung" })).toBeVisible();
  await page.getByRole("button", { name: "Demo: aktuellen Code einsetzen" }).click();
  await expect(page.getByLabel(CODE_LABEL)).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Anna" })).toBeVisible();
  await signOut(page);

  // Recovery code instead of the app.
  await page.goto(APP);
  await page.getByRole("button", { name: "anna@demo-kt.example", exact: true }).click();
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await page.getByRole("button", { name: "Smartphone nicht zur Hand? Wiederherstellungscode verwenden" }).click();
  await page.getByLabel("Wiederherstellungscode").fill(recovery);
  await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Unbenutzte Wiederherstellungscodes: 9");
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Anna" })).toBeVisible();
});

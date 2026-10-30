/**
 * Two-factor authentication against the real API + PostgreSQL (api-mode build):
 * enrolment in the settings, sign-in with code and recovery code, mandatory
 * setup for platform staff, owner requirement. Codes are computed in the test
 * from the secret (RFC 6238), exactly like an authenticator app does.
 */
import { readFileSync } from "node:fs";
import {
  CODE_LABEL, IDS, PASSWORD, USERS, apiStatus, codeFor, completeTwoFactorSetup, expect, go, nextCode, rows, signIn, test,
} from "./support/stack";

test("employee enables 2FA in the settings and signs in with code and recovery code", async ({ browser, page, stack }) => {
  await signIn(page, "/app/", USERS.emp1A);
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Sam" })).toBeVisible();
  await go(page, "#/einstellungen");
  const card = page.locator("#zwei-faktor");
  await expect(card.getByRole("heading", { name: "Zwei-Faktor-Anmeldung" })).toBeVisible();
  await expect(card.getByText("Nicht eingerichtet")).toBeVisible();
  await card.getByRole("button", { name: "Zwei-Faktor-Anmeldung einrichten" }).click();

  // QR code (own encoder, SVG) and the secret in groups of four.
  await expect(card.getByRole("img", { name: /QR-Code für die Authenticator-App \(Schichtklar24, fahrer1@/ })).toBeVisible();
  const grouped = await card.getByTestId("totp-secret").innerText();
  expect(grouped).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
  const secret = grouped.replace(/\s/g, "");

  // A wrong code is rejected, the current one activates 2FA.
  await card.getByLabel(CODE_LABEL).fill(codeFor(secret, 5));
  await card.getByRole("button", { name: "Bestätigen und aktivieren" }).click();
  await expect(card.getByRole("alert").filter({ hasText: "Der Code stimmt nicht." })).toBeVisible();
  await card.getByLabel(CODE_LABEL).fill(codeFor(secret));
  await card.getByRole("button", { name: "Bestätigen und aktivieren" }).click();

  const list = card.getByRole("list", { name: "Wiederherstellungscodes" });
  await expect(list.getByRole("listitem")).toHaveCount(10);
  const recoveryCodes = (await list.getByRole("listitem").allInnerTexts()).map((x) => x.trim());
  const downloadPromise = page.waitForEvent("download");
  await card.getByRole("button", { name: "Als Textdatei herunterladen" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("wiederherstellungscodes.txt");
  const text = readFileSync((await download.path())!, "utf8");
  for (const c of recoveryCodes) expect(text).toContain(c);
  expect(text).toContain(USERS.emp1A);

  await expect(card.getByRole("button", { name: "Fertig" })).toBeDisabled();
  await card.getByLabel("Ich habe die Wiederherstellungscodes sicher gespeichert.").check();
  await card.getByRole("button", { name: "Fertig" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Zwei-Faktor-Anmeldung ist aktiv." })).toBeVisible();
  await expect(card.getByText("Aktiv", { exact: true })).toBeVisible();
  await expect(card).toContainText("Unbenutzte Wiederherstellungscodes: 10 von 10");

  // The database holds only ciphertext and hashes.
  const [f] = await rows<{ secret_ciphertext: string; enrolled: boolean }>(stack.db,
    "select secret_ciphertext, enrolled_at is not null as enrolled from auth.totp_factors where user_id = $1", [IDS.users.emp1A]);
  expect(f!.enrolled).toBe(true);
  expect(f!.secret_ciphertext).not.toContain(secret);
  const hashes = JSON.stringify(await rows(stack.db, "select code_hash from auth.totp_recovery_codes where user_id = $1", [IDS.users.emp1A]));
  for (const c of recoveryCodes) expect(hashes).not.toContain(c.replace(/-/g, ""));

  // New browser: password, then the code from the "app".
  const ctx2 = await browser.newContext({ baseURL: stack.url, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const p2 = await ctx2.newPage();
  await p2.goto("/app/");
  await p2.getByLabel("E-Mail-Adresse").fill(USERS.emp1A);
  await p2.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
  await p2.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(p2.getByRole("heading", { name: "Bestätigung" })).toBeVisible();
  expect(await apiStatus(p2, `/api/tenants/${IDS.tenantA}`)).toBe(401); // no session before the second step
  const good = await nextCode(USERS.emp1A);
  await p2.getByLabel(CODE_LABEL).fill(good === "000000" ? "111111" : "000000");
  await p2.getByRole("button", { name: "Bestätigen", exact: true }).click();
  await expect(p2.getByRole("alert").filter({ hasText: "Der Code ist ungültig oder abgelaufen." })).toBeVisible();
  await p2.getByLabel(CODE_LABEL).fill(good);
  await p2.getByRole("button", { name: "Bestätigen", exact: true }).click();
  await expect(p2.getByRole("heading", { level: 1, name: "Hallo Sam" })).toBeVisible();
  await ctx2.close();

  // New browser: recovery code instead of the app – works once.
  const ctx3 = await browser.newContext({ baseURL: stack.url, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const p3 = await ctx3.newPage();
  for (const attempt of ["first", "second"] as const) {
    await p3.goto("/app/");
    await p3.getByLabel("E-Mail-Adresse").fill(USERS.emp1A);
    await p3.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
    await p3.getByRole("button", { name: "Anmelden", exact: true }).click();
    await p3.getByRole("button", { name: "Smartphone nicht zur Hand? Wiederherstellungscode verwenden" }).click();
    await expect(p3.getByLabel("Wiederherstellungscode")).toBeVisible();
    await p3.getByLabel("Wiederherstellungscode").fill(recoveryCodes[0]!.toLowerCase());
    await p3.getByRole("button", { name: "Bestätigen", exact: true }).click();
    if (attempt === "first") {
      await expect(p3.getByText("Mit Wiederherstellungscode angemeldet")).toBeVisible();
      await expect(p3.getByRole("status")).toContainText("Unbenutzte Wiederherstellungscodes: 9");
      await p3.getByRole("button", { name: "Weiter" }).click();
      await expect(p3.getByRole("heading", { level: 1, name: "Hallo Sam" })).toBeVisible();
      await p3.context().clearCookies();
    } else {
      await expect(p3.getByRole("alert").filter({ hasText: "bereits verwendet" })).toBeVisible();
    }
  }
  await ctx3.close();

  const events = await rows<{ action: string }>(stack.db,
    "select action from public.audit_log where entity = 'user' and entity_id = $1 order by created_at, action", [IDS.users.emp1A]);
  expect(events.map((e) => e.action)).toEqual(["two_factor.enabled", "two_factor.recovery_codes_created", "two_factor.recovery_code_used"]);
});

test("support account: signs in, but sees only the mandatory 2FA setup until it is done", async ({ page }) => {
  await page.goto("/admin/");
  await page.getByLabel("E-Mail-Adresse").fill(USERS.support);
  await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Zwei-Faktor-Anmeldung einrichten" })).toBeVisible();
  await expect(page.getByText("Für Konten des Plattformbetriebs ist die Zwei-Faktor-Anmeldung Pflicht.")).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  expect(await apiStatus(page, "/api/platform/tenants")).toBe(403);
  // Reload keeps the session – still only the setup.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Zwei-Faktor-Anmeldung einrichten" })).toBeVisible();

  await completeTwoFactorSetup(page);
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  expect(await apiStatus(page, "/api/platform/tenants")).toBe(200);

  await go(page, "#/konto");
  const card = page.locator("#zwei-faktor");
  await expect(card).toContainText("Für Konten des Plattformbetriebs ist die Zwei-Faktor-Anmeldung Pflicht.");
  await expect(card.getByText("Aktiv", { exact: true })).toBeVisible();
});

test("owner requires 2FA for managers only after setting it up for the own account", async ({ page, stack }) => {
  await signIn(page, "/chef/", USERS.ownerB);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/einstellungen");
  const policy = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Zwei-Faktor-Pflicht für Leitungskräfte" }) });
  await expect(policy).toContainText("Nicht vorgeschrieben (freiwillig).");
  await policy.getByRole("button", { name: "Für Leitungskräfte vorschreiben" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Vorschreiben" }).click();
  await expect(policy.getByRole("alert").filter({ hasText: "Bitte richte zuerst für dein eigenes Konto die Zwei-Faktor-Anmeldung ein." })).toBeVisible();

  const card = page.locator("#zwei-faktor");
  await card.getByRole("button", { name: "Zwei-Faktor-Anmeldung einrichten" }).click();
  await completeTwoFactorSetup(page);
  await expect(card.getByText("Aktiv", { exact: true })).toBeVisible();

  await policy.getByRole("button", { name: "Für Leitungskräfte vorschreiben" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Vorschreiben" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Zwei-Faktor-Anmeldung für Leitungskräfte vorgeschrieben." })).toBeVisible();
  await expect(policy).toContainText("Vorgeschrieben für Inhaber und Vorgesetzte.");
  const [t] = await rows<{ r: boolean }>(stack.db, "select require_two_factor_for_managers as r from public.tenants where id = $1", [IDS.tenantB]);
  expect(t!.r).toBe(true);
  await page.reload();
  await expect(page.locator("#zwei-faktor")).toContainText("Dein Unternehmen verlangt die Zwei-Faktor-Anmeldung für Inhaber und Vorgesetzte.");
});

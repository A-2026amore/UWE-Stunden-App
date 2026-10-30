/**
 * Pages opened from e-mails (password reset, invitation) with the links
 * captured from the API's development mailer log.
 */
import { IDS, PASSWORD, USERS, expect, go, rows, signIn, test } from "./support/stack";

const NEW_PASSWORD = "Neues-Passwort-Fullstack-9";

test("password reset: request → mail link → new password → sign in", async ({ page, stack }) => {
  await page.goto("/app/");
  await page.getByRole("button", { name: "Passwort vergessen?" }).click();
  await page.getByLabel("E-Mail-Adresse").fill(USERS.empB);
  await page.getByRole("button", { name: "Link anfordern" }).click();
  await expect(page.getByText("Falls ein Konto mit dieser Adresse existiert, wurde ein Link versendet.")).toBeVisible();
  await expect(page.getByText("Im Demo-Modus")).toHaveCount(0);

  const mail = await stack.mailTo(USERS.empB, /Passwort/);
  expect(mail.link.startsWith(`${stack.url}/passwort-neu#token=`)).toBe(true);
  await page.goto(mail.link);
  await expect(page.getByRole("heading", { level: 1, name: "Neues Passwort festlegen" })).toBeVisible();
  // The token is taken out of the address bar.
  expect(page.url()).toBe(`${stack.url}/passwort-neu/`);

  await page.getByLabel("Neues Passwort", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Neues Passwort wiederholen").fill("anders-als-oben-123");
  await page.getByRole("button", { name: "Passwort speichern" }).click();
  await expect(page.getByText("Die beiden Passwörter stimmen nicht überein.")).toBeVisible();
  await page.getByLabel("Neues Passwort wiederholen").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Passwort speichern" }).click();
  await expect(page.getByText("Dein neues Passwort ist gespeichert.")).toBeVisible();

  // The link works only once.
  await page.goto(mail.link);
  await page.getByLabel("Neues Passwort", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Neues Passwort wiederholen").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Passwort speichern" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Der Link ist ungültig oder abgelaufen." })).toBeVisible();

  await signIn(page, "/app/", USERS.empB, PASSWORD);
  await expect(page.getByRole("alert").filter({ hasText: "E-Mail-Adresse oder Passwort ist falsch." })).toBeVisible();
  await signIn(page, "/app/", USERS.empB, NEW_PASSWORD);
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Charlie" })).toBeVisible();
});

test("invitation: chef invites → mail link → password → new employee signs in", async ({ browser, page, stack }) => {
  const email = "neu.fullstack@demo-krankentransporte.example";
  await signIn(page, "/chef/", USERS.managerA);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/mitarbeiter");
  await page.getByRole("button", { name: "Mitarbeiter einladen" }).click();
  const dialog = page.getByRole("dialog", { name: "Mitarbeiter einladen" });
  await dialog.getByLabel("Name", { exact: true }).fill("Toni Neu");
  await dialog.getByLabel("Personalnummer").fill("A-777");
  await dialog.getByLabel("E-Mail-Adresse").fill(email);
  await dialog.getByRole("button", { name: "Einladen" }).click();
  // Development server without SMTP: the chef is told where the invitation went.
  await expect(page.getByTestId("invitation-status")).toContainText(`Die Einladung für Toni Neu (${email}) steht mit Link im Server-Log.`);
  await expect(page.getByRole("row", { name: /Toni Neu/ })).toContainText("Eingeladen");

  const mail = await stack.mailTo(email, /Einladung/);
  expect(mail.link.startsWith(`${stack.url}/einladung#token=`)).toBe(true);
  const ctx = await browser.newContext({ baseURL: stack.url, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const invitee = await ctx.newPage();
  await invitee.goto(mail.link);
  await expect(invitee.getByRole("heading", { level: 1, name: "Einladung annehmen" })).toBeVisible();
  await invitee.getByLabel("Passwort", { exact: true }).fill("kurz");
  await invitee.getByLabel("Passwort wiederholen").fill("kurz");
  await invitee.getByRole("button", { name: "Einladung annehmen" }).click();
  await expect(invitee.getByText("Das Passwort muss mindestens 10 Zeichen lang sein.")).toBeVisible();
  await invitee.getByLabel("Passwort", { exact: true }).fill(NEW_PASSWORD);
  await invitee.getByLabel("Passwort wiederholen").fill(NEW_PASSWORD);
  await invitee.getByRole("button", { name: "Einladung annehmen" }).click();
  await expect(invitee.getByTestId("invitation-result")).toHaveText("Dein Passwort ist gespeichert. Du kannst dich jetzt anmelden.");

  await invitee.getByRole("link", { name: "Zur Mitarbeiter-App" }).click();
  await invitee.getByLabel("E-Mail-Adresse").fill(email);
  await invitee.getByLabel("Passwort", { exact: true }).fill(NEW_PASSWORD);
  await invitee.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(invitee.getByRole("heading", { level: 1, name: "Hallo Toni" })).toBeVisible();
  await ctx.close();

  const [emp] = await rows<{ status: string; tenant_id: string }>(stack.db, "select status, tenant_id from public.employees where email = $1", [email]);
  expect(emp).toMatchObject({ status: "active", tenant_id: IDS.tenantA });
});

test("invitation for an e-mail with an existing account: linked without changing the password", async ({ browser, page, stack }) => {
  // Tenant B invites a person who already has an account at tenant A.
  await signIn(page, "/chef/", USERS.ownerB);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/mitarbeiter");
  await page.getByRole("button", { name: "Mitarbeiter einladen" }).click();
  const dialog = page.getByRole("dialog", { name: "Mitarbeiter einladen" });
  await dialog.getByLabel("Name", { exact: true }).fill("Jo Demo (Aushilfe)");
  await dialog.getByLabel("Personalnummer").fill("P-77");
  await dialog.getByLabel("E-Mail-Adresse").fill(USERS.emp2A);
  await dialog.getByRole("button", { name: "Einladen" }).click();
  await expect(page.getByTestId("invitation-status")).toBeVisible();

  const mail = await stack.mailTo(USERS.emp2A, /Muster Pflegedienst/);
  const ctx = await browser.newContext({ baseURL: stack.url, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const invitee = await ctx.newPage();
  await invitee.goto(mail.link);
  await invitee.getByRole("button", { name: "Ich habe bereits ein Konto" }).click();
  await expect(invitee.getByTestId("invitation-result")).toHaveText(
    "Für diese E-Mail-Adresse gibt es bereits ein Benutzerkonto. Die Einladung wurde damit verknüpft – bitte melde dich mit deinem bisherigen Passwort an.");

  // The old password still works.
  await invitee.getByRole("link", { name: "Zur Mitarbeiter-App" }).click();
  await invitee.getByLabel("E-Mail-Adresse").fill(USERS.emp2A);
  await invitee.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
  await invitee.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(invitee.getByRole("heading", { level: 1, name: "Hallo Jo" })).toBeVisible();
  await ctx.close();

  const memberships = await rows<{ tenant_id: string; status: string }>(stack.db,
    "select tenant_id, status from public.employees where user_id = $1 order by tenant_id", [IDS.users.emp2A]);
  expect(memberships).toEqual([{ tenant_id: IDS.tenantA, status: "active" }, { tenant_id: IDS.tenantB, status: "active" }]);
});

test("invitation link shared by the chef (WhatsApp / copy): no mail, works once", async ({ browser, page, stack }) => {
  const email = "link.fullstack@demo-krankentransporte.example";
  await signIn(page, "/chef/", USERS.managerA);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/mitarbeiter");
  await page.getByRole("button", { name: "Mitarbeiter einladen" }).click();
  const dialog = page.getByRole("dialog", { name: "Mitarbeiter einladen" });
  await dialog.getByLabel("Name", { exact: true }).fill("Lia Link");
  await dialog.getByLabel("Personalnummer").fill("A-778");
  await dialog.getByLabel("E-Mail-Adresse").fill(email);
  await dialog.getByLabel("Zugang senden").selectOption("link");
  await dialog.getByRole("button", { name: "Einladen" }).click();

  const share = page.getByRole("dialog", { name: "Zugang senden: Lia Link" });
  const link = (await share.getByTestId("invitation-link").locator(".share-link").innerText()).trim();
  expect(link.startsWith(`${stack.url}/einladung#token=`)).toBe(true);
  const wa = await share.getByRole("link", { name: "Per WhatsApp teilen" }).getAttribute("href");
  expect(decodeURIComponent(wa!)).toContain(link);
  await share.getByRole("button", { name: "Schließen", exact: true }).click();

  const ctx = await browser.newContext({ baseURL: stack.url, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const invitee = await ctx.newPage();
  await invitee.goto(link);
  await invitee.getByLabel("Passwort", { exact: true }).fill(NEW_PASSWORD);
  await invitee.getByLabel("Passwort wiederholen").fill(NEW_PASSWORD);
  await invitee.getByRole("button", { name: "Einladung annehmen" }).click();
  await expect(invitee.getByTestId("invitation-result")).toHaveText("Dein Passwort ist gespeichert. Du kannst dich jetzt anmelden.");
  // A second use of the same link is refused.
  await invitee.goto(link);
  await invitee.getByLabel("Passwort", { exact: true }).fill(NEW_PASSWORD);
  await invitee.getByLabel("Passwort wiederholen").fill(NEW_PASSWORD);
  await invitee.getByRole("button", { name: "Einladung annehmen" }).click();
  await expect(invitee.getByRole("alert")).toBeVisible();
  await ctx.close();

  const [emp] = await rows<{ status: string }>(stack.db, "select status from public.employees where email = $1", [email]);
  expect(emp).toMatchObject({ status: "active" });
  expect(stack.mails.some((m) => m.to === email)).toBe(false); // shared by the chef, never mailed
});

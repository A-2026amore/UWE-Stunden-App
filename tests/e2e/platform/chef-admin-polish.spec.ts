/**
 * Chef-Portal and Super-Admin (demo build): hours overview per employee and
 * month with PDF/CSV, invitation links (WhatsApp / copy), company logo in the
 * PDF, responsive navigation, free test customers, tenant deactivation,
 * system overview, install hint of the employee app.
 */
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, APP, CHEF, confirmDialog, freeze, go, login, loginEmployee, minutesOf, statValue } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

async function loginChef(page: Page, email = "chef@demo-kt.example"): Promise<void> {
  await login(page, CHEF, email);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

/** Downloads a file; PDFs are read as latin1 (binary), CSV files as UTF-8. */
async function downloadText(page: Page, click: () => Promise<void>): Promise<{ name: string; text: string }> {
  const download = page.waitForEvent("download");
  await click();
  const file = await download;
  const name = file.suggestedFilename();
  return { name, text: (await readFile((await file.path())!)).toString(name.endsWith(".csv") ? "utf8" : "latin1") };
}

test("chef: hours overview – all employees, one employee with days, sums, statement, PDF and CSV", async ({ page }) => {
  await loginChef(page);
  await go(page, "#/stunden?m=2026-10");
  await expect(page.getByRole("heading", { level: 1, name: "Stundenübersicht" })).toBeVisible();
  const table = page.getByRole("table", { name: "Stundenübersicht Oktober 2026" });
  const ben = table.getByRole("row", { name: /Ben Muster/ });
  await expect(ben).toContainText("Eingereicht");
  await expect(table).not.toContainText("Mia Musterfrau"); // other tenant

  // CSV with the monthly sums of all employees.
  const sums = await downloadText(page, () => page.getByRole("button", { name: "CSV Monatssummen" }).click());
  expect(sums.name).toBe("Stundenuebersicht_demo-krankentransporte_2026-10_alle.csv");
  expect(sums.text.startsWith("\uFEFFMonat;Personalnummer;Name;Einsatztage;Einsätze")).toBe(true);
  expect(sums.text).toMatch(/2026-10;\d+;Anna Beispiel;\d+;\d+;\d+,\d\d/);

  // One employee: days with shifts, sum = worked hours, statement status.
  await table.getByRole("button", { name: "Tage von Anna Beispiel anzeigen" }).click();
  const days = page.getByRole("table", { name: "Arbeitstage Anna Beispiel Oktober 2026" });
  await expect(days).toBeVisible();
  expect(await days.locator("tbody tr").count()).toBeGreaterThan(10);
  const worked = minutesOf(await statValue(page, "Geleistet").innerText());
  expect(worked).toBeGreaterThan(0);
  expect(minutesOf(await page.getByTestId("hours-sum").locator(".num").innerText())).toBe(worked);
  await expect(page.getByTestId("statement-status")).toContainText("Monatsnachweis:");

  const pdf = await downloadText(page, () => page.getByRole("button", { name: "PDF-Stundenzettel" }).click());
  expect(pdf.name).toMatch(/Stundenzettel-.*-2026-10\.pdf$/);
  expect(pdf.text.startsWith("%PDF-")).toBe(true);
  expect((pdf.text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length).toBeGreaterThan(1); // multi-page, never squeezed

  const csv = await downloadText(page, () => page.getByRole("button", { name: "CSV", exact: true }).click());
  expect(csv.name).toMatch(/^Arbeitszeiten_demo-krankentransporte_2026-10_.+\.csv$/);
  expect(csv.text.split("\r\n").length).toBeGreaterThan(10);
  expect(csv.text).not.toContain("Ben Muster");

  // Approve Ben's submitted statement directly from his month.
  await page.getByRole("button", { name: "Alle Mitarbeitenden" }).click();
  await table.getByRole("button", { name: "Tage von Ben Muster anzeigen" }).click();
  await page.getByTestId("statement-status").getByRole("button", { name: "Freigeben" }).click();
  await confirmDialog(page, "Freigeben");
  await expect(page.locator(".toast").filter({ hasText: "Monatsnachweis freigegeben." })).toBeVisible();
  await expect(page.getByTestId("statement-status")).toContainText("Freigegeben");
});

test("chef: invite with a one-time link to share via WhatsApp or copy", async ({ page }) => {
  await loginChef(page);
  await go(page, "#/mitarbeiter");
  await page.getByRole("button", { name: "Mitarbeiter einladen" }).click();
  const form = page.getByRole("dialog", { name: "Mitarbeiter einladen" });
  await form.getByLabel("Name").fill("Lena Neu");
  await form.getByLabel("Personalnummer").fill("1777");
  await form.getByLabel("E-Mail-Adresse").fill("lena.neu@demo-kt.example");
  await form.getByLabel("Zugang senden").selectOption("link");
  await form.getByRole("button", { name: "Einladen" }).click();

  const share = page.getByRole("dialog", { name: "Zugang senden: Lena Neu" });
  await expect(share).toBeVisible();
  await expect(share.getByTestId("invitation-link")).toContainText("/einladung/#token=demo-");
  await expect(share).toContainText("Einmalig gültig bis 27.11.2026");
  await expect(share).toContainText("Es wird kein Passwort verschickt.");
  const wa = share.getByRole("link", { name: "Per WhatsApp teilen" });
  const href = (await wa.getAttribute("href"))!;
  expect(href.startsWith("https://wa.me/?text=")).toBe(true);
  expect(decodeURIComponent(href)).toContain("Hallo Lena, du wurdest zur Zeiterfassung von Demo Krankentransporte eingeladen.");
  await share.getByRole("button", { name: "Schließen", exact: true }).click();

  // Later: a new link for the invited person (the old one becomes invalid).
  const row = page.getByRole("row", { name: /Lena Neu/ });
  await expect(row).toContainText("Eingeladen");
  await row.getByRole("button", { name: "Zugang an Lena Neu senden" }).click();
  await share.getByRole("button", { name: "Link erstellen (WhatsApp / kopieren)" }).click();
  await expect(share.getByTestId("invitation-link")).toBeVisible();
  await share.getByRole("button", { name: "Schließen", exact: true }).click();
  await row.getByRole("button", { name: "Zugang an Lena Neu senden" }).click();
  await share.getByRole("button", { name: "Per E-Mail senden" }).click();
  await expect(share.getByTestId("invitation-status")).toContainText("Demo: Für Lena Neu wurde eine Einladung erstellt");
});

test("chef: company logo in the PDF head and as watermark, name only in the footer (generic brand)", async ({ page }) => {
  await loginChef(page, "leitung@muster-pflege.example");
  await go(page, "#/firma");
  await page.getByLabel("Firmenname (Anzeige)").fill("Muster Pflegedienst Köln GmbH");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Firmenprofil gespeichert." })).toBeVisible();
  await expect(page.locator(".sidebar")).toContainText("Muster Pflegedienst Köln GmbH");

  await go(page, "#/stunden?m=2026-10");
  const table = page.getByRole("table", { name: "Stundenübersicht Oktober 2026" });
  await expect(table.getByRole("row", { name: /Mia Musterfrau/ })).toBeVisible();
  const pdf = await downloadText(page, () => table.getByRole("button", { name: "PDF-Stundenzettel für Mia Musterfrau" }).click());
  expect(pdf.text).toContain("/Subtype /Image");
  expect(pdf.text).toContain("/Filter /DCTDecode");
  // Logo top left and as watermark on every page; the name is not repeated next to the logo (decision 30.10.2026).
  const pages = Number(/\/Count (\d+)/.exec(pdf.text)![1]);
  expect(pdf.text.split("/Logo Do").length - 1).toBe(2 * pages);
  expect(pdf.text.split("/GSWatermark gs").length - 1).toBe(pages);
  expect(pdf.text).not.toMatch(/\(Muster Pflegedienst K\xf6ln GmbH\) Tj/);
});

test("chef on a phone: collapsible menu, tables as cards, no horizontal scrolling", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone layout");
  await loginChef(page);
  const menu = page.getByRole("button", { name: "Menü öffnen" });
  await expect(menu).toBeVisible();
  await expect(page.locator("#sidebar")).toBeHidden();
  await menu.click();
  await page.locator("#sidebar").getByRole("link", { name: "Stundenübersicht" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Stundenübersicht" })).toBeVisible();
  await expect(page.locator("#sidebar")).toBeHidden();
  // Table rows become cards with labels; the page does not scroll sideways.
  const row = page.getByRole("row", { name: /Anna Beispiel/ });
  await expect(row).toBeVisible();
  await expect(page.locator("table.table-responsive thead").first()).toHaveCSS("position", "absolute");
  for (const hash of ["#/stunden", "#/mitarbeiter", "#/nachweise", "#/zeiten", "#/firma"]) {
    await go(page, hash);
    await expect(page.locator("main h1")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, hash).toBeLessThanOrEqual(1);
  }
});

test("super-admin: overview, free test customer, deactivate and reactivate, system status", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  await expect(statValue(page, "Mitarbeitende gesamt")).not.toHaveText("0");
  await expect(statValue(page, "Umsatz netto November 2026")).toHaveText("0,00 €");

  await page.getByRole("button", { name: "Kostenlosen Testkunden anlegen" }).click();
  const dialog = page.getByRole("dialog", { name: "Kostenlosen Testkunden anlegen" });
  await dialog.getByLabel("Firmenname").fill("Test Fahrdienst Aachen");
  await dialog.getByLabel("E-Mail des Inhabers").fill("inhaber@test-fahrdienst.example");
  await expect(dialog.getByLabel("Kostenlos testen")).toBeChecked();
  await expect(dialog.getByLabel("Kostenlos bis")).toHaveValue("2026-12-20");
  await dialog.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Kostenloser Testkunde „Test Fahrdienst Aachen“ angelegt." })).toBeVisible();
  const row = page.getByRole("row", { name: /Test Fahrdienst Aachen/ });
  await expect(row).toContainText("0,00 € – kostenloses Konto");
  await expect(statValue(page, "Pilotkunden \\(kostenlos\\)").locator("xpath=..")).toContainText("1 kostenlose Testkunden");

  // Deactivate (contract ended) – data stays, reactivation possible.
  await page.getByRole("link", { name: "Muster Pflegedienst GmbH verwalten" }).click();
  await page.getByRole("button", { name: "Deaktivieren" }).click();
  const ask = page.getByRole("dialog", { name: "Muster Pflegedienst GmbH deaktivieren?" });
  await expect(ask).toContainText("Es werden keine Daten gelöscht");
  await ask.getByRole("textbox").fill("Vertrag beendet");
  await ask.getByRole("button", { name: "Deaktivieren" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Mandant deaktiviert." })).toBeVisible();
  await expect(page.getByRole("main").locator(".badge").filter({ hasText: "Deaktiviert" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Reaktivieren" })).toBeVisible();

  const user = await page.context().newPage();
  await user.clock.setFixedTime(new Date("2026-11-20T10:00:00+01:00"));
  await user.goto(APP);
  await user.getByRole("button", { name: "mia@muster-pflege.example", exact: true }).click();
  await user.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(user.getByText("Der Firmenzugang ist deaktiviert.")).toBeVisible();
  await user.close();

  await go(page, "#/protokoll");
  await expect(page.getByRole("table", { name: "Protokoll" })).toContainText("Mandant deaktiviert");
  await expect(page.getByRole("table", { name: "Protokoll" })).toContainText("Vertrag beendet");

  await go(page, "#/system");
  const status = page.getByTestId("system-status");
  await expect(status).toContainText("Zahlungsdienst");
  await expect(status).toContainText("keiner");
  await expect(status).toContainText("Letzte Sicherung");
  await expect(status).toContainText("nicht bekannt");
});

test("employee app: install hint for the home screen, dismissible; full card in the settings", async ({ page }, testInfo) => {
  await loginEmployee(page);
  const hint = page.getByTestId("install-hint");
  await expect(hint).toBeVisible();
  await expect(hint.getByRole("heading", { name: "Zum Home-Bildschirm hinzufügen" })).toBeVisible();
  // Android shows the browser-menu steps; the iPhone project gets the Safari steps (tested below).
  if (testInfo.project.name === "mobile-android") await expect(hint.getByTestId("install-steps-browser")).toContainText("⋮ oben rechts");
  await hint.getByRole("button", { name: "Hinweis ausblenden" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Anna" })).toBeVisible();
  await expect(page.getByTestId("install-hint")).toHaveCount(0);
  await go(page, "#/einstellungen");
  await expect(page.getByRole("heading", { name: "App auf dem Startbildschirm" })).toBeVisible();
  // iOS meta tags for "Zum Home-Bildschirm".
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /icon-180\.png$/);
});

test("employee app on an iPhone user agent: Safari steps", async ({ browser }) => {
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "de-DE", timezoneId: "Europe/Berlin",
  });
  const page = await ctx.newPage();
  await freeze(page);
  await loginEmployee(page);
  await expect(page.getByTestId("install-steps-ios")).toContainText("„Zum Home-Bildschirm“");
  await ctx.close();
});

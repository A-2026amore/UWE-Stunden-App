import { expect, test, type Locator, type Page } from "@playwright/test";
import { ANNA_ID, CHEF, MIA_ID, freeze, go, login, loginEmployee, patchDb } from "./helpers";

// Editions Basic / Pro (migration 0027), demo frozen at 20.11.2026. Muster Pflegedienst runs the monthly plan from
// 01.12.2026 (existing tenant); its owner is "leitung@muster-pflege.example".

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

/** Link in the chef navigation (also when the phone menu is closed). */
const navLink = (page: Page, path: string): Locator => page.locator(`#sidebar a[href="#${path}"]`);
/** Tab of the employee app's bottom navigation. */
const tab = (page: Page, name: string): Locator => page.locator(".bottom-nav").getByRole("link", { name, exact: true });

/** Basic from 01.11.2026 for the tenant of the given employee (no trial). */
async function makeBasic(page: Page, employeeId: string): Promise<void> {
  await patchDb(page, `
    const t = db.employees.find((e) => e.id === arg).tenantId;
    const s = db.subscriptions.find((x) => x.tenantId === t);
    s.trialEndsOn = null;
    s.editions = [{ startsOn: "2026-11-01", edition: "basic" }];`, employeeId);
  await page.reload();
}

test("owner: Basic is planned from the next month and can be withdrawn", async ({ page }) => {
  await login(page, CHEF, "leitung@muster-pflege.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/abrechnung");
  const card = page.getByTestId("edition-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("edition-basic")).toContainText("1,99 € je Mitarbeiter/Monat");
  await expect(page.getByTestId("edition-pro")).toContainText("aktuell");

  await page.getByRole("button", { name: "Zu Basic wechseln" }).click();
  const confirm = page.getByRole("dialog", { name: "Zu Basic wechseln?" });
  await expect(confirm).toContainText("Basic gilt ab 01.12.2026");
  await confirm.getByRole("button", { name: "Verbindlich wechseln" }).click();
  await expect(page.getByTestId("edition-next")).toContainText("Geplant: Basic ab 01.12.2026");
  await expect(page.getByTestId("subscription-plan")).toContainText("Basic, Monatstarif: 1,99 € je Mitarbeiter/Monat ab 01.12.2026");
  // still Pro this month
  await expect(navLink(page, "/konten")).toHaveCount(1);

  await page.getByRole("button", { name: "Bei Pro bleiben" }).click();
  await page.getByRole("dialog", { name: "Bei Pro bleiben?" }).getByRole("button", { name: "Wechsel zurücknehmen" }).click();
  await expect(page.getByTestId("edition-next")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zu Basic wechseln" })).toBeVisible();
});

test("Basic: the chef portal hides Pro pages; switching to Pro opens them at once", async ({ page }) => {
  await login(page, CHEF, "leitung@muster-pflege.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await makeBasic(page, MIA_ID);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  for (const path of ["/stunden", "/korrekturen", "/konten"]) await expect(navLink(page, path)).toHaveCount(0);
  await expect(navLink(page, "/nachweise")).toHaveCount(1);
  await go(page, "#/konten");
  await expect(page.getByTestId("pro-only")).toBeVisible();

  await go(page, "#/abrechnung");
  await expect(page.getByTestId("edition-basic")).toContainText("aktuell");
  await page.getByRole("button", { name: "Zu Pro wechseln" }).click();
  const confirm = page.getByRole("dialog", { name: "Zu Pro wechseln?" });
  await expect(confirm).toContainText("ab sofort");
  await confirm.getByRole("button", { name: "Verbindlich wechseln" }).click();
  await expect(page.getByTestId("edition-pro")).toContainText("aktuell");
  await page.reload();
  await expect(navLink(page, "/konten")).toHaveCount(1);
});

test("Basic: the employee app has no account tab and no correction requests", async ({ page }) => {
  await loginEmployee(page);
  await expect(tab(page, "Konto")).toBeVisible();
  await makeBasic(page, ANNA_ID);
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Anna" })).toBeVisible();
  await expect(tab(page, "Konto")).toHaveCount(0);
  await expect(tab(page, "Erfassen")).toBeVisible();
  await go(page, "#/konto");
  await expect(page.getByTestId("pro-only")).toBeVisible();
  await go(page, "#/monat?m=2026-10");
  await expect(page.getByRole("button", { name: /Korrektur für Einsatz/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fehlenden Einsatz melden" })).toHaveCount(0);
});

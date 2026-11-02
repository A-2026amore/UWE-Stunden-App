import { expect, test } from "@playwright/test";
import { ADMIN, CHEF, freeze, go, login, statValue } from "./helpers";

// Free offer "until further notice" (migration 0029), demo frozen at 20.11.2026.

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

test("super admin switches everything free; the chef portal shows 0 €; ending needs one month notice", async ({ page }) => {
  await login(page, ADMIN, "admin@plattform.example");
  await expect(page.getByRole("heading", { level: 1, name: "Mandanten" })).toBeVisible();
  await go(page, "#/lizenzen");
  const card = page.getByTestId("free-offer");
  await expect(card).toContainText("Wenn Sie es einschalten");
  await card.getByLabel("Grund für die Änderung (Protokoll)").fill("Erfahrungen sammeln");
  await card.getByRole("button", { name: "Alles kostenlos einschalten" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Die Nutzung ist jetzt kostenlos." })).toBeVisible();
  await expect(card).toContainText("Seit 01.11.2026 zahlt keine Firma etwas, bis Sie es beenden.");

  const chef = await page.context().newPage();
  await freeze(chef);
  await login(chef, CHEF, "leitung@muster-pflege.example");
  await expect(chef.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(chef, "#/abrechnung");
  await expect(chef.getByTestId("free-offer-notice")).toContainText("bis auf Weiteres kostenlos");
  await expect(statValue(chef, "Summe brutto")).toHaveText("0,00 €");
  await expect(statValue(chef, "Preis je Person")).toHaveText("0,00 €");
  await chef.close();

  await expect(card.getByLabel("Kostenlos bis")).toHaveValue("2026-12-31");
  await card.getByLabel("Grund für die Änderung (Protokoll)").fill("Preise ab Januar");
  await card.getByRole("button", { name: "Kostenlos beenden" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Das kostenlose Angebot endet am 31.12.2026." })).toBeVisible();
  await expect(card).toContainText("bis einschließlich 31.12.2026");
  await expect(card.getByRole("button", { name: "Weiter unbefristet kostenlos" })).toBeVisible();
});

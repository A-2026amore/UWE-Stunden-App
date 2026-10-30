import { expect, test } from "@playwright/test";
import { BASE } from "./helpers";

// Legal pages (drafts from the legal thread): visible, marked as draft, versions match the "Stand" notes.

test("AGB page shows AGB, Anlage A and Anlage B with the draft notice and the accepted version", async ({ page }) => {
  await page.goto(`${BASE}/rechtliches/agb/`);
  await expect(page.getByTestId("legal-draft")).toContainText("Entwurf");
  await expect(page.getByTestId("legal-version")).toHaveText("Fassung: AGB 0.9.3, Anlage A 0.9.3, Anlage B 0.9.1");
  await expect(page.getByRole("heading", { level: 1, name: /Allgemeine Geschäftsbedingungen/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Anlage A/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Anlage B/ })).toBeVisible();
  await expect(page.locator(".legal-text")).toContainText("Stand: Entwurf 0.9.3");
  // no horizontal page scroll on phones
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("AVV, Datenschutz and Impressum pages load and link to each other", async ({ page }) => {
  await page.goto(`${BASE}/rechtliches/avv/`);
  await expect(page.getByTestId("legal-version")).toHaveText("Fassung: AVV 0.9.2, Anlage 1 (TOM) 0.9.1");
  await expect(page.getByRole("heading", { level: 1, name: /Auftragsverarbeitung/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Technische und organisatorische/ })).toBeVisible();
  await page.getByRole("navigation", { name: "Rechtliches" }).getByRole("link", { name: "Datenschutzerklärung" }).click();
  await expect(page).toHaveURL(/\/rechtliches\/datenschutz\/$/);
  await expect(page.getByRole("heading", { level: 1, name: /Datenschutzerklärung/ })).toBeVisible();
  await page.getByRole("navigation", { name: "Rechtliches" }).getByRole("link", { name: "Impressum" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Impressum" })).toBeVisible();
  await expect(page.getByTestId("legal-draft")).toBeVisible();
});

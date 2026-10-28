import { expect, type Page } from "@playwright/test";

/** The legacy static server from playwright.config.ts (the config has no global baseURL). */
export const LEGACY_BASE = "http://127.0.0.1:4173";

/** Frozen "today" for all legacy E2E tests: a Friday inside NRW school year 2026/27. */
export const NOW = new Date("2026-11-20T10:00:00+01:00");
export const MONTH = "2026-11";
export const TEST_HOURS_KEY = "uwe_test_hours_v1_only";
export const TEST_ACCOUNT_KEY = "uwe_arbeitszeitkonto_v1_TEST001";

export interface EntryInput {
  date: string;
  start: string;
  end: string;
  /** Omit to keep the app's automatic pause suggestion. */
  pause?: number;
  note?: string;
}

/** Records every alert/confirm text and accepts it (like a user tapping OK). */
export function collectDialogs(page: Page): string[] {
  const messages: string[] = [];
  page.on("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  return messages;
}

export async function fillEntry(page: Page, e: EntryInput): Promise<void> {
  await page.locator("#date").fill(e.date);
  await page.locator("#start").fill(e.start);
  await page.locator("#end").fill(e.end);
  if (e.pause !== undefined) await page.locator("#pause").fill(String(e.pause));
  if (e.note !== undefined) await page.locator("#note").fill(e.note);
}

export async function addEntry(page: Page, e: EntryInput): Promise<void> {
  await fillEntry(page, e);
  await page.locator("#saveBtn").click();
}

export async function storedEntries(page: Page, key = TEST_HOURS_KEY): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "[]"), key);
}

/** Data rows of the month table (without the per-day summary rows). */
export function entryRows(page: Page) {
  return page.locator("#rows tr:not(.day-summary)");
}

export async function openTestApp(page: Page, path = "/test-mitarbeiter.html"): Promise<void> {
  await page.clock.install({ time: NOW });
  await page.goto(new URL(path, LEGACY_BASE).href);
  await expect(page.locator("#app")).toBeVisible();
}

/** Writes entries directly into localStorage (legacy format) and reloads the page. */
export async function seedEntries(page: Page, entries: unknown[], key = TEST_HOURS_KEY): Promise<void> {
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), [key, entries] as const);
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
}

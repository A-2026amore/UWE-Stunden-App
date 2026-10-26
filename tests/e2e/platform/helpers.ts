import { expect, type Locator, type Page } from "@playwright/test";

/** Platform preview server from playwright.config.ts (the config has no global baseURL). */
export const BASE = "http://127.0.0.1:4174";
export const APP = `${BASE}/app/`;
export const CHEF = `${BASE}/chef/`;
export const ADMIN = `${BASE}/admin/`;

/** Frozen "today": Friday 20.11.2026, inside NRW school year 2026/27. Demo data is seeded relative to it. */
export const NOW = new Date("2026-11-20T10:00:00+01:00");
/** A Sunday in the current month – the demo seed never creates entries on Sundays. */
export const FREE_DAY = "2026-11-15";

export const DEMO_DB_KEY = "stundenwerk_demo_db_v1";
export const ANNA_ID = "30000000-0000-4000-8000-000000000101";
export const MIA_ID = "30000000-0000-4000-8000-000000000201";

export interface DbEntry {
  id: string; employeeId: string; tenantId: string; date: string; start: string; end: string;
  pauseMinutes: number; note: string; version: number; deletedAt: string | null; source: string;
}

/**
 * Every test runs in a fresh browser context (empty localStorage → fresh demo seed).
 * Date is frozen (timers keep running) so the seed and "today" are deterministic.
 */
export async function freeze(page: Page, now: Date = NOW): Promise<void> {
  await page.clock.setFixedTime(now);
}

export async function login(page: Page, url: string, email: string): Promise<void> {
  await page.goto(url);
  await page.getByRole("button", { name: email, exact: true }).click();
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

export async function loginEmployee(page: Page, email = "anna@demo-kt.example", firstName = "Anna"): Promise<void> {
  await login(page, APP, email);
  await expect(page.getByRole("heading", { level: 1, name: `Hallo ${firstName}` })).toBeVisible();
}

/** Hash navigation inside the already loaded app (no reload). */
export async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => { location.hash = h; }, hash);
}

/** Reads the demo database ("server" of the demo build) from localStorage. */
export async function dbEntries(page: Page, filter: { employeeId?: string; note?: string; includeDeleted?: boolean } = {}): Promise<DbEntry[]> {
  const all = await page.evaluate((key) => (JSON.parse(localStorage.getItem(key) || "{\"entries\":[]}") as { entries: unknown[] }).entries, DEMO_DB_KEY) as DbEntry[];
  return all.filter((e) => (filter.includeDeleted || !e.deletedAt) &&
    (!filter.employeeId || e.employeeId === filter.employeeId) && (filter.note === undefined || e.note === filter.note));
}

/** Modifies the demo database directly (simulates a change made on another device / by the server). */
export async function patchDb(page: Page, fn: string, arg: unknown): Promise<void> {
  await page.evaluate(([key, body, a]) => {
    const db = JSON.parse(localStorage.getItem(key as string)!);
    new Function("db", "arg", body as string)(db, a);
    localStorage.setItem(key as string, JSON.stringify(db));
  }, [DEMO_DB_KEY, fn, arg]);
}

/** "12,50 Std." → 750 minutes. */
export function minutesOf(text: string): number {
  const m = /(–|-)?\s*([\d.]+),(\d{2})/.exec(text.replace(/\u00a0/g, " "));
  if (!m) throw new Error(`no hours in "${text}"`);
  const value = Number(m[2]!.replace(/\./g, "")) * 60 + Math.round((Number(m[3]) / 100) * 60);
  return m[1] ? -value : value;
}

export function statValue(scope: Page | Locator, label: string): Locator {
  const page = "goto" in scope ? scope : scope.page();
  return scope.locator(".stat").filter({ has: page.locator(".stat-label", { hasText: new RegExp(`^${label}$`) }) }).locator(".stat-value");
}

export async function fillEntry(page: Page, e: { date?: string; start: string; end: string; pause?: string; note?: string }): Promise<void> {
  if (e.date) await page.getByLabel("Datum", { exact: true }).fill(e.date);
  await page.getByLabel("Arbeitsbeginn", { exact: true }).fill(e.start);
  await page.getByLabel("Arbeitsende", { exact: true }).fill(e.end);
  if (e.pause !== undefined) await page.getByLabel("Pause", { exact: true }).fill(e.pause);
  if (e.note !== undefined) await page.getByLabel("Bemerkung", { exact: false }).fill(e.note);
}

export async function saveEntry(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Arbeitszeit speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Arbeitszeit gespeichert." }).last()).toBeVisible();
}

export function syncIndicator(page: Page): Locator {
  return page.getByTestId("sync-indicator");
}

export async function confirmDialog(page: Page, button: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
}

export async function signOutEmployee(page: Page): Promise<void> {
  await go(page, "#/einstellungen");
  await page.getByRole("main").getByRole("button", { name: "Abmelden" }).click();
  await confirmDialog(page, "Abmelden");
  await expect(page.getByRole("heading", { name: "Anmeldung für Mitarbeitende" })).toBeVisible();
}

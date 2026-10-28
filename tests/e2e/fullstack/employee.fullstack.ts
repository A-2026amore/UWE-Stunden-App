/**
 * Employee app against the real API + PostgreSQL (api-mode build).
 * Jo Demo (fahrer2, tenant A) records times in November 2026.
 */
import type { Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDS, PASSWORD, USERS, apiStatus, expect, fillEntry, go, rows, saveEntry, signIn, test } from "./support/stack";

const JO = IDS.employees.emp2A;

async function loginJo(page: Page) {
  await signIn(page, "/app/", USERS.emp2A);
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Jo" })).toBeVisible();
}

test("real login: no demo accounts, no demo banner", async ({ page }) => {
  await page.goto("/app/");
  await expect(page.getByRole("heading", { name: "Anmeldung für Mitarbeitende" })).toBeVisible();
  await expect(page.getByText("Demo-Zugänge")).toHaveCount(0);
  await expect(page.getByText("Demo-Umgebung")).toHaveCount(0);
  await expect(page).toHaveTitle("Zeiterfassung · Mitarbeiter-App");

  await page.getByLabel("E-Mail-Adresse").fill(USERS.emp2A);
  await page.getByLabel("Passwort", { exact: true }).fill("falsches-passwort-123");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "E-Mail-Adresse oder Passwort ist falsch." })).toBeVisible();
});

test("create entry → reload → still there, loaded from the server", async ({ page, stack }) => {
  await loginJo(page);
  await go(page, "#/erfassen?datum=2026-11-02");
  await expect(page.getByRole("heading", { level: 1, name: "Arbeitszeit erfassen" })).toBeVisible();
  await fillEntry(page, { start: "07:00", end: "11:30", pause: "0", note: "fullstack-online" });
  await saveEntry(page);

  const db = await rows<{ id: string; start: string; version: number; source: string }>(stack.db,
    "select id, to_char(start_time, 'HH24:MI') as start, version, source from public.time_entries where employee_id = $1 and note = 'fullstack-online' and deleted_at is null", [JO]);
  expect(db).toMatchObject([{ start: "07:00", version: 1, source: "app" }]);

  // Drop everything the browser cached locally; the HttpOnly session cookie stays.
  await page.evaluate(() => localStorage.clear());
  await page.goto("/app/#/monat?m=2026-11");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Monatsübersicht" })).toBeVisible();
  await expect(page.locator(".shift").filter({ hasText: "fullstack-online" })).toContainText("07:00–11:30 Uhr");
  await expect(page.locator(".shift").filter({ hasText: "fullstack-online" })).not.toContainText("wartet auf Übertragung");
});

test("offline capture → reconnect → exactly one row in the database", async ({ page, context, stack }) => {
  await loginJo(page);
  await go(page, "#/erfassen?datum=2026-11-03");
  await expect(page.getByRole("heading", { level: 1, name: "Arbeitszeit erfassen" })).toBeVisible();
  const indicator = page.getByTestId("sync-indicator");
  await expect(indicator).toContainText("Online");

  await context.setOffline(true);
  await expect(indicator).toContainText("Offline");
  await fillEntry(page, { start: "06:00", end: "09:00", pause: "0", note: "fullstack-offline" });
  await saveEntry(page);
  await expect(indicator).toContainText("1 Änderung wartet auf Übertragung");
  const count = async () => Number((await rows<{ n: string }>(stack.db,
    "select count(*) as n from public.time_entries where employee_id = $1 and note = 'fullstack-offline'", [JO]))[0]!.n);
  expect(await count()).toBe(0);

  await context.setOffline(false);
  await expect(indicator).toContainText("Online");
  await expect(page.getByTestId("sync-pending")).toHaveCount(0);
  await expect.poll(count).toBe(1);

  // Repeated synchronisation never creates a duplicate.
  await go(page, "#/einstellungen");
  await page.getByRole("button", { name: "Jetzt synchronisieren" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Alle Änderungen sind übertragen." })).toBeVisible();
  await page.getByRole("button", { name: "Jetzt synchronisieren" }).click();
  expect(await count()).toBe(1);
  // No demo-only switches in the API build.
  await expect(page.getByLabel("Offline simulieren (nur Demo)")).toHaveCount(0);
});

test("expired session → back to the login with a German hint; the unsent entry is kept and sent after sign-in", async ({ page, stack }) => {
  await loginJo(page);
  await go(page, "#/erfassen?datum=2026-11-04");
  await expect(page.getByRole("heading", { level: 1, name: "Arbeitszeit erfassen" })).toBeVisible();
  await expect(page.getByText("Einsätze am Mittwoch, 04.11.2026")).toBeVisible();

  // The server ends the session (expiry / idle timeout / revoked).
  await stack.db.query("delete from auth.sessions where user_id = $1", [IDS.users.emp2A]);
  await fillEntry(page, { start: "13:00", end: "15:00", pause: "0", note: "fullstack-expired" });
  await page.getByRole("button", { name: "Arbeitszeit speichern" }).click();
  await expect(page.getByRole("heading", { name: "Anmeldung für Mitarbeitende" })).toBeVisible();
  await expect(page.getByText("Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.")).toBeVisible();
  const count = async () => Number((await rows<{ n: string }>(stack.db,
    "select count(*) as n from public.time_entries where employee_id = $1 and note = 'fullstack-expired'", [JO]))[0]!.n);
  expect(await count()).toBe(0);

  await page.getByLabel("E-Mail-Adresse").fill(USERS.emp2A);
  await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Jo" })).toBeVisible();
  await expect.poll(count).toBe(1);
  await expect(page.getByTestId("sync-pending")).toHaveCount(0);
});

test("suspended company: German message at login", async ({ page, stack }) => {
  await stack.db.query("update public.tenants set status = 'suspended' where id = $1", [IDS.tenantB]);
  try {
    await signIn(page, "/app/", USERS.empB);
    await expect(page.getByRole("alert").filter({ hasText: "Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber." })).toBeVisible();
  } finally {
    await stack.db.query("update public.tenants set status = 'active' where id = $1", [IDS.tenantB]);
  }
});

test("service worker: caches only the app shell, re-caches after foreign deletion, opens offline", async ({ page, context }) => {
  await loginJo(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const cacheState = () => page.evaluate(async () => {
    const keys = await caches.keys();
    const urls: string[] = [];
    for (const k of keys) for (const r of await (await caches.open(k)).keys()) urls.push(r.url);
    return { keys, urls };
  });
  await expect.poll(async () => (await cacheState()).urls.length).toBeGreaterThan(5);
  let state = await cacheState();
  expect(state.keys.every((k) => k.startsWith("stundenwerk-app-"))).toBe(true);
  expect(state.urls.some((u) => u.includes("/api/"))).toBe(false);
  expect(state.urls.some((u) => /\/assets\/chef-/.test(u))).toBe(false);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope);
  expect(new URL(scope!).pathname).toBe("/app/");

  // Another app on the same origin (e.g. the legacy UWE service worker) deletes our cache …
  await page.evaluate(async () => { for (const k of await caches.keys()) await caches.delete(k); });
  expect((await cacheState()).keys).toEqual([]);
  // … the next app start fills it again.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Jo" })).toBeVisible();
  await expect.poll(async () => (await cacheState()).urls.length).toBe(state.urls.length);
  state = await cacheState();
  expect(state.keys.every((k) => k.startsWith("stundenwerk-app-"))).toBe(true);

  // Without network the app shell still opens (data from the local sync cache).
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Jo" })).toBeVisible();
  await expect(page.getByTestId("sync-indicator")).toContainText("Offline");
  await context.setOffline(false);
});

test("new version: 'Neue Version verfügbar – neu laden', own old cache replaced, foreign caches untouched", async ({ page }) => {
  await loginJo(page);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.evaluate(async () => { await (await caches.open("fremde-app-cache")).put("/fremd.txt", new Response("x")); });
  const oldKeys = await page.evaluate(() => caches.keys());
  const file = join(process.env.FULLSTACK_DIST!, "app", "sw.js");
  const original = readFileSync(file, "utf8");
  try {
    // Deploy a "new build" of the service worker.
    writeFileSync(file, original.replace(/const CACHE = PREFIX \+ "([^"]+)";/, 'const CACHE = PREFIX + "$1-neu";'));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    const button = page.getByRole("button", { name: "Neue Version verfügbar – neu laden" });
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByRole("heading", { level: 1, name: "Hallo Jo" })).toBeVisible();
    await expect(button).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => caches.keys())).toContain(oldKeys.find((k) => k.startsWith("stundenwerk-app-")) + "-neu");
    const keys = await page.evaluate(() => caches.keys());
    expect(keys).toContain("fremde-app-cache");
    expect(keys.filter((k) => k.startsWith("stundenwerk-app-"))).toHaveLength(1);
  } finally {
    writeFileSync(file, original);
  }
});

test("employee cannot read another employee's times via the API", async ({ page }) => {
  await loginJo(page);
  expect(await apiStatus(page, `/api/employees/${IDS.employees.emp1A}/time-entries?month=2026-10`)).toBe(403);
  expect(await apiStatus(page, `/api/employees/${JO}/time-entries?month=2026-10`)).toBe(200);
});

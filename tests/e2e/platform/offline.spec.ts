import { expect, test } from "@playwright/test";
import {
  ANNA_ID, FREE_DAY, dbEntries, fillEntry, freeze, go, loginEmployee, patchDb, saveEntry, syncIndicator,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

test("offline capture without network: queued, then synchronised on reconnect without duplicates", async ({ page, context }) => {
  await loginEmployee(page);
  await expect(syncIndicator(page)).toContainText("Online");
  await go(page, `#/erfassen?datum=${FREE_DAY}`);
  await expect(page.getByRole("heading", { level: 1, name: "Arbeitszeit erfassen" })).toBeVisible();

  await context.setOffline(true);
  await expect(syncIndicator(page)).toContainText("Offline");

  await fillEntry(page, { start: "06:00", end: "08:00", pause: "0", note: "offline-netz" });
  await saveEntry(page);
  await expect(syncIndicator(page)).toContainText("1 Änderung wartet auf Übertragung");
  await fillEntry(page, { start: "09:00", end: "11:00", pause: "0", note: "offline-netz" });
  await saveEntry(page);
  await expect(syncIndicator(page)).toContainText("2 Änderungen warten auf Übertragung");
  const dayCard = page.locator(".card").filter({ hasText: "Einsätze am Sonntag, 15.11.2026" });
  await expect(dayCard.getByText("wartet auf Übertragung")).toHaveCount(2);
  // Nothing has reached the "server" (demo database) yet.
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "offline-netz" })).toHaveLength(0);

  // Reconnect → "online" event → automatic flush.
  await context.setOffline(false);
  await expect(syncIndicator(page)).toContainText("Online");
  await expect(page.getByTestId("sync-pending")).toHaveCount(0);
  await expect(dayCard.getByText("wartet auf Übertragung")).toHaveCount(0);
  expect((await dbEntries(page, { employeeId: ANNA_ID, note: "offline-netz" })).map((e) => e.start).sort()).toEqual(["06:00", "09:00"]);

  // Repeated synchronisation never duplicates.
  await go(page, "#/einstellungen");
  await page.getByRole("button", { name: "Jetzt synchronisieren" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Alle Änderungen sind übertragen." })).toBeVisible();
  await page.getByRole("button", { name: "Jetzt synchronisieren" }).click();
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "offline-netz" })).toHaveLength(2);
});

test("dev toggle 'Offline simulieren': outbox survives a reload and is sent when switched back", async ({ page }) => {
  await loginEmployee(page);
  await go(page, "#/einstellungen");
  await page.getByLabel("Offline simulieren (nur Demo)").check();
  await expect(syncIndicator(page)).toContainText("Offline");

  await go(page, `#/erfassen?datum=${FREE_DAY}`);
  await fillEntry(page, { start: "07:00", end: "09:30", pause: "0", note: "offline-toggle" });
  await saveEntry(page);
  await expect(syncIndicator(page)).toContainText("1 Änderung wartet auf Übertragung");

  // Reload: still offline, change still queued and visible.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Arbeitszeit erfassen" })).toBeVisible();
  await expect(syncIndicator(page)).toContainText("Offline");
  await expect(syncIndicator(page)).toContainText("1 Änderung wartet auf Übertragung");
  await expect(page.locator(".shift").filter({ hasText: "07:00–09:30 Uhr" })).toContainText("wartet auf Übertragung");
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "offline-toggle" })).toHaveLength(0);

  // Monthly statement needs a connection.
  await go(page, "#/monat?m=2026-11");
  await page.getByRole("button", { name: "Monatsnachweis einreichen" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Einreichen" }).click();
  await expect(page.locator(".toast").filter({ hasText: "nur mit Internetverbindung" })).toBeVisible();

  await go(page, "#/einstellungen");
  await page.getByLabel("Offline simulieren (nur Demo)").uncheck();
  await expect(syncIndicator(page)).toContainText("Online");
  await expect(page.getByTestId("sync-pending")).toHaveCount(0);
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "offline-toggle" })).toMatchObject([{ start: "07:00", end: "09:30", version: 1 }]);
  await expect(page.getByText("Letzte Übertragung: 20.11.2026")).toBeVisible();
});

test("conflict: change made elsewhere is not overwritten; user keeps own version", async ({ page }) => {
  await loginEmployee(page);
  await go(page, `#/erfassen?datum=${FREE_DAY}`);
  await fillEntry(page, { start: "06:00", end: "10:00", pause: "0", note: "konflikt" });
  await saveEntry(page);
  const [server] = await dbEntries(page, { employeeId: ANNA_ID, note: "konflikt" });
  expect(server).toMatchObject({ end: "10:00", version: 1 });

  await go(page, "#/einstellungen");
  await page.getByLabel("Offline simulieren (nur Demo)").check();
  await go(page, `#/erfassen/${server!.id}?datum=${FREE_DAY}`);
  await expect(page.getByRole("heading", { level: 1, name: "Einsatz bearbeiten" })).toBeVisible();
  await page.getByLabel("Arbeitsende", { exact: true }).fill("10:30");
  await page.getByRole("button", { name: "Änderung speichern" }).click();
  await expect(syncIndicator(page)).toContainText("1 Änderung wartet auf Übertragung");

  // Meanwhile a manager corrects the same entry on the server.
  await patchDb(page, "const e = db.entries.find((x) => x.id === arg); e.end = '09:45'; e.version += 1; e.source = 'correction';", server!.id);

  await go(page, "#/einstellungen");
  await page.getByLabel("Offline simulieren (nur Demo)").uncheck();
  await expect(syncIndicator(page).getByRole("button", { name: "1 Konflikt lösen" })).toBeVisible();
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "konflikt" })).toMatchObject([{ end: "09:45", version: 2 }]);

  await syncIndicator(page).getByRole("button", { name: "1 Konflikt lösen" }).click();
  const dialog = page.getByRole("dialog", { name: "Konflikte bei der Synchronisierung" });
  await expect(dialog.getByTestId("conflict-mine")).toContainText("06:00–10:30 Uhr");
  await expect(dialog.getByTestId("conflict-server")).toContainText("06:00–09:45 Uhr");
  await dialog.getByRole("button", { name: "Meine Version behalten" }).click();
  await expect(dialog).toBeHidden();
  await expect(syncIndicator(page).getByRole("button", { name: /Konflikt/ })).toHaveCount(0);
  await expect(page.getByTestId("sync-pending")).toHaveCount(0);
  expect(await dbEntries(page, { employeeId: ANNA_ID, note: "konflikt" })).toMatchObject([{ end: "10:30", version: 3 }]);
});

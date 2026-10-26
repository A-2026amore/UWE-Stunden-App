/**
 * Loads the migration fixtures into the real legacy employee app (index.html) to prove that the
 * simulated snapshots look exactly like what real devices hold.
 */
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_PUBLIC_JWK, snapshots, type LegacySnapshot } from "../../fixtures/legacy-storage";
import { LEGACY_BASE, NOW, addEntry, collectDialogs, entryRows } from "./helpers";

async function openWithSnapshot(page: Page, snapshot: LegacySnapshot, revoked: string[] = []) {
  await page.route("**/uwe-config.js*", (route) =>
    route.fulfill({ contentType: "text/javascript", body: `window.UWE_ACCESS_PUBLIC_KEY = ${JSON.stringify(FIXTURE_PUBLIC_JWK)};` }),
  );
  await page.route(/\/uwe-access-control\.json/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, revoked }) }),
  );
  await page.route("https://api.github.com/**", (route) => route.abort());
  // Seed once per page (not again on reload).
  await page.addInitScript((data) => {
    if (sessionStorage.getItem("__seeded")) return;
    for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
    sessionStorage.setItem("__seeded", "1");
  }, snapshot);
  await page.clock.install({ time: NOW });
  await page.goto(LEGACY_BASE + "/index.html");
}

async function selectMonth(page: Page, month: string) {
  await page.locator("#month").fill(month);
  await page.locator("#month").dispatchEvent("change");
}

const raw = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test.describe("legacy app with migration fixtures", () => {
  test("plainV27: session restores E1001 with entries and work account", async ({ page }) => {
    await openWithSnapshot(page, snapshots.plainV27);
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#employeeHeading")).toHaveText("Erika Musterfrau");
    await expect(entryRows(page)).toHaveCount(5);
    await expect(page.locator("#monthGrossHours")).toHaveText("30,75 Std.");
    await expect(page.locator("#monthDepositedHours")).toHaveText("–10,00 Std.");
    await expect(page.locator("#monthNetHours")).toHaveText("20,75 Std.");
    await expect(page.locator("#uwaBalance")).toHaveText("-85,00 Std.");
    await expect(page.locator("#monthBreakNote")).toBeHidden();
  });

  test("legacyNoIds: id-less v2 entries are shown and get legacy ids on the next save", async ({ page }) => {
    collectDialogs(page);
    await openWithSnapshot(page, snapshots.legacyNoIds);
    await selectMonth(page, "2026-10");
    await expect(entryRows(page)).toHaveCount(5);
    await expect(page.locator("#monthGrossHours")).toHaveText("36,50 Std.");
    await addEntry(page, { date: "2026-11-02", start: "08:00", end: "12:00", pause: 0 });
    const stored = JSON.parse((await raw(page, "uwe_hours_2_E1002"))!);
    expect(stored).toHaveLength(6);
    expect(stored.filter((e: { id: string }) => e.id.startsWith("legacy-")).map((e: { id: string }) => e.id)).toEqual([
      "legacy-79r8q4", "legacy-1eodjyu", "legacy-snbh87", "legacy-18vv1yy", "legacy-1q7qujg",
    ]);
  });

  test("duplicates: legacy shows 9 of 10 raw entries and flags the overlap day", async ({ page }) => {
    await openWithSnapshot(page, snapshots.duplicates);
    await expect(entryRows(page)).toHaveCount(9);
    await expect(page.locator("#monthGrossHours")).toHaveText("28,00 Std.");
    await expect(page.locator("#monthBreakNote")).toBeVisible();
  });

  test("midnight: night shifts counted on the start date; v1 work account accepted", async ({ page }) => {
    await openWithSnapshot(page, snapshots.midnight);
    await expect(entryRows(page)).toHaveCount(3);
    await expect(page.locator("#monthGrossHours")).toHaveText("19,00 Std.");
    await expect(page.locator("#monthDepositedHours")).toHaveText("–15,00 Std.");
    await selectMonth(page, "2026-12");
    await expect(entryRows(page)).toHaveCount(4);
    await expect(page.locator("#monthGrossHours")).toHaveText("16,25 Std.");
  });

  test("corrupt: invalid entries are hidden, foreign work account blocks the account UI", async ({ page }) => {
    await openWithSnapshot(page, snapshots.corrupt);
    await expect(entryRows(page)).toHaveCount(3);
    await expect(page.locator("#uwaNotice")).toContainText("anderen Mitarbeiter");
    await expect(page.locator("#uwaSave")).toBeDisabled();
    await expect(page.locator("#monthNetHours")).toHaveText("—");
  });

  test("sharedDevice: revoked E1007 is sent to sign-in, all hours on the device stay", async ({ page }) => {
    await openWithSnapshot(page, snapshots.sharedDevice, ["E1007"]);
    await expect(page.locator("#signin")).toBeVisible();
    await expect(page.locator("#notice")).toContainText("gesperrt");
    expect(await raw(page, "uwe_session")).toBeNull();
    expect(await raw(page, "uwe_hours_2_E1007")).toBe(snapshots.sharedDevice.uwe_hours_2_E1007);
    expect(await raw(page, "uwe_hours_2_E1001")).toBe(snapshots.sharedDevice.uwe_hours_2_E1001);
  });

  // LEGACY BUG (documented, not fixed): unreadable stored hours are treated as "no entries" and
  // silently overwritten by the next save – the original (possibly recoverable) data is lost.
  test("LEGACY BUG: unparsable stored hours are overwritten by the next save", async ({ page }) => {
    test.fail(!process.env.SHOW_LEGACY_BUGS, "legacy app overwrites unreadable data (see docs/testplan.md)");
    collectDialogs(page);
    await openWithSnapshot(page, snapshots.unparsable);
    await expect(entryRows(page)).toHaveCount(0);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "12:00", pause: 0 });
    await expect(entryRows(page)).toHaveCount(1);
    expect(await raw(page, "uwe_hours_2_E1006")).toContain('"date":"2026-11-02"');
  });
});

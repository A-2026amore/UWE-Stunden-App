import { expect, test, type Page } from "@playwright/test";
import { generateTestKeyPair, inviteLink, signInvite, type TestKeyPair } from "../../fixtures/legacy-invite";
import { LEGACY_BASE, NOW, addEntry, collectDialogs, entryRows } from "./helpers";

const EID = "E1001";
const NAME = "Erika Testfrau";
const PIN = "48151623";
const HOURS_KEY = `uwe_hours_2_${EID}`;

let keys: TestKeyPair;
let foreignKeys: TestKeyPair;
let validCode: string;

test.beforeAll(async () => {
  keys = await generateTestKeyPair();
  foreignKeys = await generateTestKeyPair();
  validCode = await signInvite(keys.privateKey, { eid: EID, name: NAME, pin: PIN, exp: "2027-11-30" });
});

interface AccessServer {
  revoked: string[];
  status: number;
  requests: number;
}

/** Serves the TEST public key and a controllable revocation list; blocks GitHub. */
async function prepare(page: Page): Promise<AccessServer> {
  const server: AccessServer = { revoked: [], status: 200, requests: 0 };
  await page.route("**/uwe-config.js*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.UWE_ACCESS_PUBLIC_KEY = ${JSON.stringify(keys.publicJwk)};`,
    }),
  );
  await page.route(/\/uwe-access-control\.json/, (route) => {
    server.requests++;
    if (server.status !== 200) return route.fulfill({ status: server.status, body: "" });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ version: 1, updatedAt: "2026-11-20", revoked: server.revoked }),
    });
  });
  await page.route("https://api.github.com/**", (route) => route.abort("blockedbyclient"));
  await page.clock.install({ time: NOW });
  return server;
}

async function openWithCode(page: Page, code: string) {
  await page.goto(inviteLink(LEGACY_BASE, code));
  await expect(page.locator("#signin")).toBeVisible();
}

async function login(page: Page, code = validCode, pin = PIN) {
  await openWithCode(page, code);
  await page.locator("#pin").fill(pin);
  await page.locator("#loginBtn").click();
}

const storage = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test.describe("index.html – signed invite login", () => {
  test("login with ?code= link and PIN", async ({ page }) => {
    const server = await prepare(page);
    await openWithCode(page, validCode);
    await expect(page.locator("#token")).toHaveValue(validCode);
    // The code is removed from the address bar right away.
    expect(new URL(page.url()).search).toBe("");
    await page.locator("#pin").fill(PIN);
    await page.locator("#loginBtn").click();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#employeeHeading")).toHaveText(NAME);
    await expect(page.locator("#employeeId")).toHaveText(`Personalnummer: ${EID}`);
    await expect(page.locator("#accessStatus")).toContainText("Zugang online geprüft");
    expect(await storage(page, "uwe_session")).toBe(validCode);
    expect(server.requests).toBeGreaterThan(0);
  });

  test("pasting the whole invitation link into the field also works", async ({ page }) => {
    await prepare(page);
    await page.goto(LEGACY_BASE + "/index.html");
    await expect(page.locator("#signin")).toBeVisible();
    await page.locator("#token").fill(inviteLink("https://example.invalid/app", validCode));
    await page.locator("#pin").fill(PIN);
    await page.locator("#loginBtn").click();
    await expect(page.locator("#app")).toBeVisible();
  });

  test("wrong PIN is rejected", async ({ page }) => {
    await prepare(page);
    await login(page, validCode, "11112222");
    await expect(page.locator("#notice")).toHaveText("PIN stimmt nicht.");
    await expect(page.locator("#app")).toBeHidden();
    expect(await storage(page, "uwe_session")).toBeNull();
  });

  test("PIN with wrong format is rejected", async ({ page }) => {
    await prepare(page);
    await login(page, validCode, "1234");
    await expect(page.locator("#notice")).toHaveText("Die PIN muss 6 bis 12 Ziffern haben.");
  });

  test("expired code is rejected; a code expiring today is still valid", async ({ page }) => {
    await prepare(page);
    const expired = await signInvite(keys.privateKey, { eid: EID, name: NAME, pin: PIN, exp: "2026-11-19" });
    await login(page, expired);
    await expect(page.locator("#notice")).toContainText("Dieser Zugang ist abgelaufen");
    await expect(page.locator("#app")).toBeHidden();

    const today = await signInvite(keys.privateKey, { eid: EID, name: NAME, pin: PIN, exp: "2026-11-20" });
    await login(page, today);
    await expect(page.locator("#app")).toBeVisible();
  });

  test("code signed with another key or tampered payload is rejected", async ({ page }) => {
    await prepare(page);
    const foreign = await signInvite(foreignKeys.privateKey, { eid: EID, name: NAME, pin: PIN, exp: "2027-11-30" });
    await login(page, foreign);
    await expect(page.locator("#notice")).toHaveText("Dieser Zugang wurde nicht von UWE ausgestellt.");

    const [body, sig] = validCode.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    const tampered = Buffer.from(JSON.stringify({ ...payload, exp: "2099-12-31" })).toString("base64url") + "." + sig;
    await login(page, tampered);
    await expect(page.locator("#notice")).toHaveText("Dieser Zugang wurde nicht von UWE ausgestellt.");

    await login(page, "kaputt");
    await expect(page.locator("#notice")).toHaveText("Ungültiger Zugangscode.");
  });

  test("session survives reload and hours are stored under uwe_hours_2_<eid>", async ({ page }) => {
    await prepare(page);
    collectDialogs(page);
    await login(page);
    await expect(page.locator("#app")).toBeVisible();
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "16:00", pause: 30, note: "Login-Test" });
    await expect(entryRows(page)).toHaveCount(1);
    const stored = JSON.parse((await storage(page, HOURS_KEY))!);
    expect(stored).toEqual([expect.objectContaining({ date: "2026-11-10", start: "08:00", end: "16:00", pause: 30, note: "Login-Test" })]);
    expect(await storage(page, "uwe_test_hours_v1_only")).toBeNull();

    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#signin")).toBeHidden();
    await expect(entryRows(page)).toHaveCount(1);
    await expect(page.locator("#monthGrossHours")).toHaveText("7,50 Std.");
  });

  test("logout keeps the hours on the device", async ({ page }) => {
    await prepare(page);
    collectDialogs(page);
    await login(page);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "12:00", pause: 0 });
    await expect(entryRows(page)).toHaveCount(1);
    await page.locator("#logoutBtn").click();
    await expect(page.locator("#signin")).toBeVisible();
    expect(await storage(page, "uwe_session")).toBeNull();
    expect(JSON.parse((await storage(page, HOURS_KEY))!)).toHaveLength(1);
  });

  test("revoked employee is logged out during use, but their hours remain in localStorage", async ({ page }) => {
    const server = await prepare(page);
    collectDialogs(page);
    await login(page);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "16:00", pause: 30 });
    await expect(entryRows(page)).toHaveCount(1);

    server.revoked = ["e1001"]; // case-insensitive match
    await page.clock.fastForward(60_000); // older than the 45 s check cache
    await addEntry(page, { date: "2026-11-11", start: "08:00", end: "12:00", pause: 0 });

    await expect(page.locator("#signin")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
    await expect(page.locator("#notice")).toContainText("Dieser Mitarbeiterzugang wurde von UWE gesperrt");
    expect(await storage(page, "uwe_session")).toBeNull();
    const kept = JSON.parse((await storage(page, HOURS_KEY))!);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ date: "2026-11-10" });

    // Logging in again is refused while revoked.
    await login(page);
    await expect(page.locator("#notice")).toContainText("gesperrt");
    await expect(page.locator("#app")).toBeHidden();
  });

  test("revocation takes effect on the next app start (stored session)", async ({ page }) => {
    const server = await prepare(page);
    collectDialogs(page);
    await login(page);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "12:00", pause: 0 });
    server.revoked = [EID];
    await page.reload();
    await expect(page.locator("#signin")).toBeVisible();
    await expect(page.locator("#notice")).toContainText("gesperrt");
    expect(await storage(page, "uwe_session")).toBeNull();
    expect(JSON.parse((await storage(page, HOURS_KEY))!)).toHaveLength(1);
  });

  for (const status of [500, 404]) {
    test(`login fails closed when the revocation list is unavailable (HTTP ${status}, GitHub blocked)`, async ({ page }) => {
      const server = await prepare(page);
      server.status = status;
      await login(page);
      await expect(page.locator("#notice")).toContainText("Die UWE-Zugangsprüfung ist derzeit nicht erreichbar");
      await expect(page.locator("#app")).toBeHidden();
      expect(await storage(page, "uwe_session")).toBeNull();
    });
  }

  test("saving needs a fresh online check; offline the entry is not saved but nothing is lost", async ({ page }) => {
    const server = await prepare(page);
    const dialogs = collectDialogs(page);
    await login(page);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "12:00", pause: 0 });
    await expect(entryRows(page)).toHaveCount(1);
    server.status = 500;
    await page.clock.fastForward(60_000);
    await addEntry(page, { date: "2026-11-11", start: "08:00", end: "12:00", pause: 0 });
    await expect.poll(() => dialogs.at(-1) ?? "").toContain("nicht erreichbar");
    await expect(page.locator("#app")).toBeVisible();
    expect(JSON.parse((await storage(page, HOURS_KEY))!)).toHaveLength(1);
  });

  test("without a configured public key the setup screen is shown", async ({ page }) => {
    await page.route("**/uwe-config.js*", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
    await page.route(/\/uwe-access-control\.json/, (route) => route.abort());
    await page.goto(LEGACY_BASE + "/index.html");
    await expect(page.locator("#setup")).toBeVisible();
  });
});

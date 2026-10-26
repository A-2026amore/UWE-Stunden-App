import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { inspectPdf } from "../../legacy/support/pdf-inspect";
import {
  MONTH,
  TEST_ACCOUNT_KEY,
  TEST_HOURS_KEY,
  addEntry,
  collectDialogs,
  entryRows,
  fillEntry,
  openTestApp,
  seedEntries,
  storedEntries,
} from "./helpers";

test.describe("test-mitarbeiter.html (test mode, no login)", () => {
  test.beforeEach(async ({ page }) => {
    await openTestApp(page);
  });

  test("starts in test mode with frozen date and test employee", async ({ page }) => {
    await expect(page.locator(".demoBanner")).toContainText("TESTMODUS");
    await expect(page.locator("#employeeHeading")).toHaveText("Test Mitarbeiter");
    await expect(page.locator("#employeeId")).toHaveText("Test-Personalnummer: TEST001");
    await expect(page.locator("#date")).toHaveValue("2026-11-20");
    await expect(page.locator("#month")).toHaveValue(MONTH);
    // Default form 08:00–16:00 gets the automatic 30 min pause.
    await expect(page.locator("#pause")).toHaveValue("30");
  });

  test("add, edit and delete an entry", async ({ page }) => {
    const dialogs = collectDialogs(page);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "16:00", pause: 30, note: "Schülertour" });
    await expect(entryRows(page)).toHaveCount(1);
    await expect(entryRows(page).first()).toContainText("10.11.2026");
    await expect(entryRows(page).first()).toContainText("7,50");
    let saved = await storedEntries(page);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ date: "2026-11-10", start: "08:00", end: "16:00", pause: 30, note: "Schülertour" });
    expect(saved[0]!.id).toMatch(/^[a-zA-Z0-9_-]{4,100}$/);
    const id = saved[0]!.id;

    // Edit
    await entryRows(page).first().getByRole("button", { name: "Ändern" }).click();
    await expect(page.locator("#saveBtn")).toHaveText("Änderungen speichern");
    await expect(page.locator("#start")).toHaveValue("08:00");
    await page.locator("#end").fill("15:00");
    await page.locator("#saveBtn").click();
    await expect(entryRows(page)).toHaveCount(1);
    await expect(entryRows(page).first()).toContainText("6,50");
    saved = await storedEntries(page);
    expect(saved).toEqual([expect.objectContaining({ id, end: "15:00", pause: 30 })]);

    // Delete (confirm dialog accepted)
    await entryRows(page).first().getByRole("button", { name: "×" }).click();
    await expect(entryRows(page)).toHaveCount(0);
    expect(await storedEntries(page)).toEqual([]);
    expect(dialogs.some((m) => m.startsWith("Einsatz 10.11.2026 von 08:00 bis 15:00 löschen?"))).toBe(true);
  });

  test("deleting is cancelled when the confirm dialog is dismissed", async ({ page }) => {
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "12:00", pause: 0 });
    page.once("dialog", (d) => void d.dismiss());
    await entryRows(page).first().getByRole("button", { name: "×" }).click();
    await expect(entryRows(page)).toHaveCount(1);
    expect(await storedEntries(page)).toHaveLength(1);
  });

  test("two shifts on the same day show a day total and month total", async ({ page }) => {
    collectDialogs(page);
    await addEntry(page, { date: "2026-11-10", start: "06:00", end: "09:30", pause: 0 });
    // After saving, the form keeps the date for the next block; the 2:30 h gap counts as break.
    await expect(page.locator("#date")).toHaveValue("2026-11-10");
    await addEntry(page, { date: "2026-11-10", start: "12:00", end: "15:30", pause: 0 });
    await addEntry(page, { date: "2026-11-11", start: "08:00", end: "12:00", pause: 0 });
    await expect(entryRows(page)).toHaveCount(3);
    await expect(page.locator("#rows tr.day-summary").first()).toContainText("Tagessumme 10.11.2026");
    await expect(page.locator("#rows tr.day-summary").first()).toContainText("7,00");
    await expect(page.locator("#total")).toHaveText("3 Einsätze an 2 Tagen");
    await expect(page.locator("#monthGrossHours")).toHaveText("11,00 Std.");
    await expect(page.locator("#monthNetHours")).toHaveText("11,00 Std.");
    await expect(page.locator("#monthBreakNote")).toBeHidden();
  });

  test("midnight shift 22:00–06:00 is stored on its start date with 7,50 h", async ({ page }) => {
    collectDialogs(page);
    await addEntry(page, { date: "2026-11-12", start: "22:00", end: "06:00", pause: 30 });
    await expect(entryRows(page)).toHaveCount(1);
    await expect(entryRows(page).first()).toContainText("12.11.2026");
    await expect(entryRows(page).first()).toContainText("7,50");
    expect(await storedEntries(page)).toEqual([expect.objectContaining({ date: "2026-11-12", start: "22:00", end: "06:00" })]);
  });

  test("overlapping shift on the same day is rejected", async ({ page }) => {
    const dialogs = collectDialogs(page);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "12:00", pause: 0 });
    await addEntry(page, { date: "2026-11-10", start: "11:00", end: "13:00", pause: 0 });
    expect(dialogs.at(-1)).toContain("überschneidet sich mit 08:00–12:00");
    await expect(page.locator("#breakError")).toBeVisible();
    expect(await storedEntries(page)).toHaveLength(1);
  });

  test("shift longer than 12 h is rejected", async ({ page }) => {
    const dialogs = collectDialogs(page);
    await addEntry(page, { date: "2026-11-10", start: "06:00", end: "18:30", pause: 45 });
    expect(dialogs.at(-1)).toContain("mehr als 12 Stunden");
    expect(await storedEntries(page)).toHaveLength(0);
  });

  test("two shifts adding up to more than 12 h per day are rejected", async ({ page }) => {
    const dialogs = collectDialogs(page);
    await addEntry(page, { date: "2026-11-10", start: "05:00", end: "11:00", pause: 30 });
    await addEntry(page, { date: "2026-11-10", start: "12:00", end: "18:30", pause: 30 });
    expect(dialogs.at(-1)).toContain("zusammen mehr als 12 Stunden");
    expect(await storedEntries(page)).toHaveLength(1);
  });

  test("missing pause is rejected; the automatic suggestion fills the required pause", async ({ page }) => {
    const dialogs = collectDialogs(page);
    // Manually entered 0 min for a 7 h shift -> rejected.
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "15:00", pause: 0 });
    expect(dialogs.at(-1)).toContain("mindestens 30 Minuten Pause erforderlich");
    expect(await storedEntries(page)).toHaveLength(0);

    // Fresh form: let the app suggest the pause (not manually edited).
    await page.locator("#clearBtn").click();
    await fillEntry(page, { date: "2026-11-11", start: "07:00", end: "17:00" });
    await expect(page.locator("#pause")).toHaveValue("45");
    await expect(page.locator("#pauseHint")).toContainText("45 Minuten Mindestpause");
    await page.locator("#saveBtn").click();
    expect(await storedEntries(page)).toEqual([expect.objectContaining({ date: "2026-11-11", pause: 45 })]);
  });

  test("pause suggestion for a second block counts the gap between blocks", async ({ page }) => {
    collectDialogs(page);
    await addEntry(page, { date: "2026-11-10", start: "06:00", end: "10:00", pause: 0 });
    // Form keeps the date, pause not manually edited -> suggestion.
    await page.locator("#start").fill("10:30");
    await page.locator("#end").fill("13:00");
    await expect(page.locator("#pause")).toHaveValue("0");
    await expect(page.locator("#pauseHint")).toContainText("Freie Zeit zwischen Einsätzen: 30 Min.");
    await page.locator("#start").fill("10:05");
    await expect(page.locator("#pause")).toHaveValue("30");
  });

  test("month switch shows only that month's entries", async ({ page }) => {
    collectDialogs(page);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "12:00", pause: 0 });
    await addEntry(page, { date: "2026-12-01", start: "08:00", end: "10:00", pause: 0 });
    // Saving switches the month view to the entry's month.
    await expect(page.locator("#month")).toHaveValue("2026-12");
    await expect(entryRows(page)).toHaveCount(1);
    await expect(page.locator("#monthGrossHours")).toHaveText("2,00 Std.");
    await page.locator("#month").fill("2026-11");
    await page.locator("#month").dispatchEvent("change");
    await expect(page.locator("#monthGrossHours")).toHaveText("4,00 Std.");
  });

  test("work account: 50 h worked, 20 h allocated -> 30 h billing; re-allocation overwrites", async ({ page }) => {
    const dialogs = collectDialogs(page);
    const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
    await seedEntries(
      page,
      days.map((date, i) => ({ id: "seed-" + i, date, start: "08:00", end: "18:45", pause: 45, note: "" })),
    );
    await expect(page.locator("#monthGrossHours")).toHaveText("50,00 Std.");
    await expect(page.locator("#uwaSchoolYear")).toContainText("Schuljahr 2026/27 · 02.09.2026 bis 16.07.2027");
    await expect(page.locator("#uwaBalance")).toHaveText("-100,00 Std.");

    await page.locator("#uwaInput").fill("20");
    await expect(page.locator("#uwaPreview")).toContainText("20,00 Std. ins Testkonto, 30,00 Std. zur Abrechnung");
    await page.locator("#uwaSave").click();
    await expect(page.locator("#monthGrossHours")).toHaveText("50,00 Std.");
    await expect(page.locator("#monthDepositedHours")).toHaveText("–20,00 Std.");
    await expect(page.locator("#monthNetHours")).toHaveText("30,00 Std.");
    await expect(page.locator("#uwaBillable")).toHaveText("30,00 Std.");
    await expect(page.locator("#uwaBalance")).toHaveText("-80,00 Std.");
    await expect(page.locator("#uwaRemaining")).toHaveText("80,00 Std.");
    expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), TEST_ACCOUNT_KEY))!)).toMatchObject({
      version: 2,
      eid: "TEST001",
      openingMinutes: -6000,
      allocations: { "2026-11": 1200 },
    });

    // Second allocation for the same month replaces (no double booking).
    await page.locator("#uwaInput").fill("10");
    await page.locator("#uwaSave").click();
    await expect(page.locator("#monthDepositedHours")).toHaveText("–10,00 Std.");
    await expect(page.locator("#monthNetHours")).toHaveText("40,00 Std.");
    await expect(page.locator("#uwaBalance")).toHaveText("-90,00 Std.");

    // More than the school-time hours is refused.
    await page.locator("#uwaInput").fill("60");
    await page.locator("#uwaSave").click();
    expect(dialogs.at(-1)).toContain("höchstens 50,00 Stunden");
    await expect(page.locator("#uwaBalance")).toHaveText("-90,00 Std.");

    // Survives reload.
    await page.reload();
    await expect(page.locator("#monthNetHours")).toHaveText("40,00 Std.");
    await expect(page.locator("#uwaInput")).toHaveValue("10,00");
  });

  test("work account is closed in summer holiday months", async ({ page }) => {
    collectDialogs(page);
    await seedEntries(page, [{ id: "summer-1", date: "2027-08-10", start: "08:00", end: "12:00", pause: 0, note: "" }]);
    await page.locator("#month").fill("2027-08");
    await page.locator("#month").dispatchEvent("change");
    await expect(page.locator("#uwaSchoolYear")).toContainText("Sommerferien");
    await expect(page.locator("#uwaSave")).toBeDisabled();
    await expect(page.locator("#uwaInput")).toBeDisabled();
  });

  test("backup download and restore into a fresh browser context", async ({ page, browser }, testInfo) => {
    collectDialogs(page);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "16:00", pause: 30, note: "Backup-Test" });
    await addEntry(page, { date: "2026-11-10", start: "17:00", end: "19:00", pause: 0 });
    await page.locator("#uwaInput").fill("5");
    await page.locator("#uwaSave").click();
    await expect(page.locator("#monthNetHours")).toHaveText("4,50 Std.");

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#backupBtn").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("UWE-TEST-Backup-TEST001-2026-11-20.json");
    const backupPath = testInfo.outputPath("backup.json");
    await download.saveAs(backupPath);
    const backup = JSON.parse(await readFile(backupPath, "utf8"));
    expect(backup).toMatchObject({ app: "UWE Stunden Test", version: 4, eid: "TEST001", name: "Test Mitarbeiter" });
    expect(backup.entries).toHaveLength(2);
    expect(backup.arbeitszeitkonto).toMatchObject({ version: 2, eid: "TEST001", allocations: { "2026-11": 300 } });

    // Fresh context = new device / emptied storage.
    const context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Berlin" });
    const fresh = await context.newPage();
    const freshDialogs = collectDialogs(fresh);
    await openTestApp(fresh);
    await expect(entryRows(fresh)).toHaveCount(0);
    await fresh.locator("#restore").setInputFiles(backupPath);
    await expect(entryRows(fresh)).toHaveCount(2);
    expect(freshDialogs[0]).toContain("2 Arbeitszeiteinträge importieren?");
    expect(freshDialogs[1]).toContain("2 zusätzliche Einsätze übernommen");
    await expect(fresh.locator("#monthNetHours")).toHaveText("4,50 Std.");
    await expect(fresh.locator("#monthDepositedHours")).toHaveText("–5,00 Std.");
    expect(await storedEntries(fresh)).toEqual(backup.entries);

    // Restoring the same backup again does not duplicate entries.
    await fresh.locator("#restore").setInputFiles(backupPath);
    await expect.poll(() => freshDialogs.length).toBe(4);
    expect(freshDialogs[3]).toContain("0 zusätzliche Einsätze übernommen");
    expect(await storedEntries(fresh)).toHaveLength(2);
    await context.close();
  });

  test("restore rejects a backup of another employee / the production app", async ({ page }, testInfo) => {
    const dialogs = collectDialogs(page);
    const path = testInfo.outputPath("foreign.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ app: "UWE Stunden", version: 4, eid: "TEST001", entries: [] }));
    await page.locator("#restore").setInputFiles(path);
    await expect.poll(() => dialogs.at(-1) ?? "").toContain("Import fehlgeschlagen");
    expect(await storedEntries(page)).toEqual([]);
  });

  test("PDF download is a real multi-page PDF for many entries", async ({ page }, testInfo) => {
    collectDialogs(page);
    const entries = Array.from({ length: 40 }, (_, i) => {
      const day = String((i % 20) + 1).padStart(2, "0");
      const late = i >= 20;
      return { id: "pdf-" + i, date: `2026-11-${day}`, start: late ? "15:00" : "06:00", end: late ? "19:00" : "11:00", pause: 0, note: "Tour " + i };
    });
    await seedEntries(page, entries);
    await expect(entryRows(page)).toHaveCount(40);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfDownloadBtn").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("UWE-TEST-Stundenzettel-TEST001-2026-11.pdf");
    const path = testInfo.outputPath("sheet.pdf");
    await download.saveAs(path);
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const info = inspectPdf(bytes);
    expect(info.problems).toEqual([]);
    expect(info.pageCount).toBeGreaterThan(1);
    expect(info.texts).toContain("Mitarbeiter: Test Mitarbeiter");
    expect(info.texts).toContain("Personalnummer: TEST001");
    expect(info.texts).toContain("GESAMT GELEISTET: 180,00 Stunden");
    expect(info.texts).toContain("TESTDATEN - NICHT FUER LOHNABRECHNUNG");
    await expect(page.locator("#pdfStatus")).toContainText("PDF-Datei zum Speichern vorbereitet");
  });

  test("PDF export is blocked while a day violates the pause rule", async ({ page }) => {
    const dialogs = collectDialogs(page);
    await seedEntries(page, [{ id: "bad-pause", date: "2026-11-10", start: "08:00", end: "16:00", pause: 0, note: "" }]);
    await expect(page.locator("#monthBreakNote")).toBeVisible();
    let downloaded = false;
    page.on("download", () => (downloaded = true));
    await page.locator("#pdfDownloadBtn").click();
    await expect.poll(() => dialogs.at(-1) ?? "").toContain("Bitte zunächst die Pause korrigieren");
    expect(downloaded).toBe(false);
  });

  test("data persists after reload", async ({ page }) => {
    collectDialogs(page);
    await addEntry(page, { date: "2026-11-10", start: "08:00", end: "16:00", pause: 30 });
    await addEntry(page, { date: "2026-11-12", start: "22:00", end: "06:00", pause: 30 });
    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(entryRows(page)).toHaveCount(2);
    await expect(page.locator("#monthGrossHours")).toHaveText("15,00 Std.");
    expect(await storedEntries(page)).toHaveLength(2);
  });

  // LEGACY BUG (documented, not fixed): overlap detection only compares entries with the same
  // date. A night shift 22:00–06:00 on the 12th overlaps a shift on the 13th from 05:00, but the
  // app stores both. Expected: rejection like any other overlap.
  test("LEGACY BUG: overlap with a night shift from the previous date is not detected", async ({ page }) => {
    // Set SHOW_LEGACY_BUGS=1 to see the real assertion failure instead of an expected failure.
    test.fail(!process.env.SHOW_LEGACY_BUGS, "legacy app only checks overlaps within the same date (see docs/testplan.md)");
    const dialogs = collectDialogs(page);
    await addEntry(page, { date: "2026-11-12", start: "22:00", end: "06:00", pause: 30 });
    await addEntry(page, { date: "2026-11-13", start: "05:00", end: "09:00", pause: 0 });
    expect(dialogs.some((m) => m.includes("überschneidet"))).toBe(true);
    expect(await storedEntries(page)).toHaveLength(1);
  });
});

test("test mode keeps its data separate from real employee keys", async ({ page }) => {
  await openTestApp(page);
  collectDialogs(page);
  await addEntry(page, { date: "2026-11-10", start: "08:00", end: "12:00", pause: 0 });
  const keys = await page.evaluate(() => Object.keys(localStorage).sort());
  expect(keys).toContain(TEST_HOURS_KEY);
  expect(keys.some((k) => k.startsWith("uwe_hours_2_"))).toBe(false);
  expect(keys).not.toContain("uwe_session");
});

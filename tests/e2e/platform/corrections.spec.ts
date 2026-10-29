import { expect, test, type Page } from "@playwright/test";
import { ANNA_ID, APP, CHEF, confirmDialog, dbEntries, freeze, go, login, loginEmployee, statValue } from "./helpers";

// Demo seed (frozen today 20.11.2026): Anna's October 2026 is approved → locked for her.
const MONTH = "2026-10";

test.beforeEach(async ({ page }) => {
  await freeze(page);
});

/** Two single-shift days of Anna in October. */
async function annaShifts(page: Page) {
  const all = await dbEntries(page, { employeeId: ANNA_ID });
  const october = all.filter((e) => e.date.startsWith(MONTH));
  const single = october.filter((e) => october.filter((x) => x.date === e.date).length === 1);
  expect(single.length).toBeGreaterThanOrEqual(2);
  return [single[0]!, single[1]!];
}

/** "14:45" → "14:30" (a shorter shift never needs a longer break). */
const minus15 = (t: string) => {
  const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) - 15;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};


async function dbg(page: Page, loc: import("@playwright/test").Locator, tag: string) {
  for (let i = 0; i < 4; i++) {
    const info = await loc.evaluate((el) => {
      const r = el.getBoundingClientRect(); const chain: string[] = []; let n: Element | null = el;
      while (n) { const c = getComputedStyle(n); chain.push(`${n.tagName}.${String(n.className).slice(0, 40)} d=${c.display} v=${c.visibility} o=${c.opacity} t=${c.transform} a=${c.animationName}/${c.animationPlayState} pos=${c.position} h=${(n as HTMLElement).offsetHeight} w=${(n as HTMLElement).offsetWidth}`); n = n.parentElement; }
      return { r: [r.x, r.y, r.width, r.height], sy: window.scrollY, ih: window.innerHeight, chain, anims: document.getAnimations().map((a) => `${(a as CSSAnimation).animationName ?? "?"}:${a.playState}:${String((a.effect as KeyframeEffect | null)?.target?.className).slice(0, 40)}`) };
    }).catch((e) => String(e));
    console.log("DEBUG", tag, i, JSON.stringify(info));
    await page.waitForTimeout(400);
  }
  console.log("DEBUG", tag, "trial", await loc.click({ trial: true, timeout: 4000 }).then(() => "ok", (e) => String(e).slice(0, 1500)));
}

const de = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

test("correction request in an approved month: employee asks, chef accepts one and rejects one", async ({ page }) => {
  await loginEmployee(page);
  const [change, remove] = await annaShifts(page);
  const newEnd = minus15(change.end);
  await go(page, `#/monat?m=${MONTH}`);
  await expect(page.getByRole("heading", { level: 2, name: "Oktober 2026" })).toBeVisible();
  await expect(page.getByText("Dieser Monat ist freigegeben.")).toBeVisible();
  // locked: no direct edit, but a correction request
  await expect(page.getByRole("button", { name: `Einsatz am ${de(change.date)} ${change.start}–${change.end} bearbeiten` })).toHaveCount(0);

  // 1) change the end time
  await page.getByRole("button", { name: `Korrektur für Einsatz am ${de(change.date)} ${change.start}–${change.end} beantragen` }).click();
  let dialog = page.getByRole("dialog", { name: "Korrektur beantragen" });
  await dialog.getByLabel("Ende", { exact: true }).fill(newEnd);
  await dialog.getByRole("button", { name: "Anfrage senden" }).click();
  await expect(dialog.getByText("Bitte begründe die Korrekturanfrage (mind. 5 Zeichen).")).toBeVisible();
  await dialog.getByLabel("Begründung").fill("Ende laut Fahrtenbuch korrigiert");
  await dialog.getByRole("button", { name: "Anfrage senden" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".shift").filter({ hasText: "Korrektur angefragt" })).toHaveCount(1);

  // 2) deletion of another entry
  await page.getByRole("button", { name: `Korrektur für Einsatz am ${de(remove.date)} ${remove.start}–${remove.end} beantragen` }).click();
  dialog = page.getByRole("dialog", { name: "Korrektur beantragen" });
  await dialog.getByLabel("Dieser Einsatz soll gelöscht werden").check();
  await dialog.getByLabel("Begründung").fill("Doppelt erfasst, war frei");
  await dialog.getByRole("button", { name: "Anfrage senden" }).click();
  await expect(dialog).toBeHidden();
  const list = page.getByRole("region", { name: "Korrekturanfragen" });
  await expect(list.locator(".correction-request")).toHaveCount(2);
  await expect(list).toContainText("Offen");
  // the entries are unchanged until the leadership decides
  expect((await dbEntries(page, { employeeId: ANNA_ID })).find((e) => e.id === change.id)).toMatchObject({ end: change.end, source: "app" });

  // Chef-Portal (same browser = same demo database)
  await login(page, CHEF, "chef@demo-kt.example");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(statValue(page, "Offene Korrekturanfragen")).toHaveText("2");
  await go(page, "#/korrekturen");
  await expect(page.getByRole("heading", { level: 1, name: "Korrekturanfragen" })).toBeVisible();
  const accepted = page.locator(".correction-request").filter({ hasText: "Ende laut Fahrtenbuch" });
  await expect(accepted).toContainText("Monat freigegeben");
  await expect(accepted).toContainText(`${change.start}–${change.end}`);
  await expect(accepted).toContainText(`${change.start}–${newEnd}`);
  // decision 28.10.2026: an approved month is re-opened first (mandatory reason), then corrected
  await accepted.getByRole("button", { name: "Anfrage von Anna Beispiel annehmen" }).click();
  await expect(page.getByRole("dialog")).toContainText("erst nach einer dokumentierten Wiederöffnung");
  await page.getByRole("dialog", { name: "Monat ist freigegeben" }).getByRole("button", { name: "Monat wieder öffnen", exact: true }).click();
  const reopen = page.getByRole("dialog", { name: "Monat wieder öffnen" });
  await reopen.getByLabel("Begründung (Pflicht, mind. 5 Zeichen)").fill("Korrekturanfrage Fahrtenbuch");
  await reopen.getByRole("button", { name: "Wieder öffnen", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Korrekturanfrage annehmen?" })).toContainText("Der Monat ist wieder geöffnet.");
  await confirmDialog(page, "Annehmen");
  await expect(page.locator(".correction-request").filter({ hasText: "Ende laut Fahrtenbuch" })).toHaveCount(0);
  expect((await dbEntries(page, { employeeId: ANNA_ID })).find((e) => e.id === change.id)).toMatchObject({ end: newEnd, source: "correction", version: change.version + 1 });

  // reject with mandatory reason
  const rejected = page.locator(".correction-request").filter({ hasText: "Doppelt erfasst" });
  await dbg(page, rejected.getByRole("button", { name: "Anfrage von Anna Beispiel ablehnen" }), "ablehnen");
  await rejected.getByRole("button", { name: "Anfrage von Anna Beispiel ablehnen" }).click();
  const rd = page.getByRole("dialog", { name: "Korrekturanfrage ablehnen" });
  await rd.getByRole("button", { name: "Ablehnen", exact: true }).click();
  await expect(rd.getByText("Bitte eine Begründung angeben.")).toBeVisible();
  await rd.getByLabel("Begründung der Ablehnung (Pflicht)").fill("Einsatz ist im Fahrtenbuch belegt");
  await rd.getByRole("button", { name: "Ablehnen", exact: true }).click();
  await expect(page.getByText("Keine offenen Korrekturanfragen")).toBeVisible();
  expect((await dbEntries(page, { employeeId: ANNA_ID })).some((e) => e.id === remove.id)).toBe(true);

  // history of the corrected entry
  await page.getByRole("tab", { name: "Alle" }).click();
  await page.locator(".correction-request").filter({ hasText: "Ende laut Fahrtenbuch" }).getByRole("button", { name: "Verlauf" }).click();
  const history = page.getByRole("dialog", { name: "Verlauf des Eintrags" });
  await expect(history).toContainText("Geändert");
  await expect(history).toContainText("Korrektur");
  await expect(history).toContainText("Korrekturanfrage: Ende laut Fahrtenbuch korrigiert");
  await history.getByRole("button", { name: "Schließen", exact: true }).click();

  // re-opened statement: approve again (figures recalculated), history visible
  await go(page, "#/nachweise");
  const row = page.getByRole("row", { name: /Anna Beispiel/ });
  await expect(row).toContainText("Wieder geöffnet");
  await expect(row).toContainText("Korrekturanfrage Fahrtenbuch");
  await row.getByRole("button", { name: "Nachweis von Anna Beispiel erneut freigeben" }).click();
  await confirmDialog(page, "Freigeben");
  await expect(row).toContainText("Freigegeben");
  await expect(row.getByRole("button", { name: "Monat von Anna Beispiel wieder öffnen" })).toBeVisible();
  const vb = row.getByRole("button", { name: "Verlauf des Nachweises von Anna Beispiel" });
  await dbg(page, vb, "verlauf");
  await vb.click();
  const events = page.getByRole("dialog", { name: /^Verlauf – Anna Beispiel/ });
  await expect(events).toContainText("Wieder geöffnet");
  await expect(events).toContainText("Korrekturanfrage Fahrtenbuch");
  await expect(events.getByText("Freigegeben", { exact: true })).toHaveCount(2);
  await events.getByRole("button", { name: "Dialog schließen" }).click();

  // the audit log has the request and the decision
  await go(page, "#/protokoll");
  await expect(page.getByRole("table", { name: "Änderungsprotokoll" })).toContainText("Korrekturanfrage angenommen");
  await expect(page.getByRole("table", { name: "Änderungsprotokoll" })).toContainText("Korrekturanfrage abgelehnt");
  await expect(page.getByRole("table", { name: "Änderungsprotokoll" })).toContainText("Monatsnachweis wieder geöffnet");

  // employee sees status and answers
  await page.goto(`${APP}#/monat?m=${MONTH}`);
  const mine = page.getByRole("region", { name: "Korrekturanfragen" });
  await expect(mine.locator(".correction-request").filter({ hasText: "Ende laut Fahrtenbuch" })).toContainText("Angenommen");
  await expect(mine.locator(".correction-request").filter({ hasText: "Doppelt erfasst" })).toContainText("Einsatz ist im Fahrtenbuch belegt");
  await expect(page.getByText("Dieser Monat ist freigegeben.")).toBeVisible();
  await expect(page.locator(".shift").filter({ hasText: `${change.start}–${newEnd} Uhr` })).toContainText("korrigiert durch Vorgesetzte");
});

test("missing entry: employee reports it, withdraws one request; offline no request", async ({ page }) => {
  await loginEmployee(page);
  await go(page, `#/monat?m=${MONTH}`);
  await page.getByRole("button", { name: "Fehlenden Einsatz melden" }).click();
  const dialog = page.getByRole("dialog", { name: "Fehlenden Einsatz nachtragen lassen" });
  await dialog.getByLabel("Datum").fill("2026-10-04"); // a Sunday
  await dialog.getByLabel("Beginn").fill("08:00");
  await dialog.getByLabel("Ende", { exact: true }).fill("12:00");
  await dialog.getByLabel("Begründung").fill("Sonntagsdienst vergessen");
  await dialog.getByRole("button", { name: "Anfrage senden" }).click();
  await expect(dialog).toBeHidden();
  const item = page.getByRole("region", { name: "Korrekturanfragen" }).locator(".correction-request").filter({ hasText: "Nachtrag" });
  await expect(item).toContainText("Offen");
  await item.getByRole("button", { name: "Zurückziehen" }).click();
  await confirmDialog(page, "Zurückziehen");
  await expect(item).toContainText("Zurückgezogen");

  // offline (demo switch): the request cannot be sent
  await page.evaluate(() => localStorage.setItem("stundenwerk_demo_offline_sim", "1"));
  await page.reload();
  await go(page, `#/monat?m=${MONTH}`);
  await page.getByRole("button", { name: "Fehlenden Einsatz melden" }).click();
  const offline = page.getByRole("dialog", { name: "Fehlenden Einsatz nachtragen lassen" });
  await expect(offline.getByText("Korrekturanfragen können nur mit Internetverbindung gestellt werden.")).toBeVisible();
  await expect(offline.getByRole("button", { name: "Anfrage senden" })).toBeDisabled();
});

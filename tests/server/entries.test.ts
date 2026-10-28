/**
 * Time entries, break rules, statements and input validation over HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const c: Record<string, string> = {};
const E = IDS.employees;

beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["ownerA", "managerA", "emp1A", "emp2A", "ownerB", "empB"] as const) c[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
});

const entry = (id: string, date: string, start: string, end: string, pauseMinutes: number, note = "") => ({ id, date, start, end, pauseMinutes, note });
const countRows = async (employeeId: string, id: string) =>
  (await t.db.admin.query("select count(*)::int as n from public.time_entries where employee_id = $1 and id = $2", [employeeId, id])).rows[0].n as number;

describe("create / update / delete", () => {
  it("creates idempotently: same id twice → one row, second answer 200 with the stored entry", async () => {
    const body = entry("0b8c7a52-1f0e-4c7a-9a8e-000000000001", "2026-10-12", "08:00", "16:00", 30, "Frühdienst");
    const first = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id: body.id, employeeId: E.emp1A, tenantId: IDS.tenantA, date: "2026-10-12", start: "08:00", end: "16:00", pauseMinutes: 30, version: 1, source: "app", deletedAt: null });
    const again = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body: { ...body, note: "anders" } });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await countRows(E.emp1A, body.id)).toBe(1);
  });

  it("versioned update; a stale version gives 409 version_conflict", async () => {
    const id = "upd-entry-0001";
    await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body: entry(id, "2026-10-13", "08:00", "12:00", 0) });
    const ok = await t.call("PATCH", `/api/employees/${E.emp1A}/time-entries/${id}`, { cookie: c.emp1A, body: { patch: { end: "13:00", note: "länger" }, expectedVersion: 1 } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ end: "13:00", note: "länger", version: 2 });
    const stale = await t.call("PATCH", `/api/employees/${E.emp1A}/time-entries/${id}`, { cookie: c.emp1A, body: { patch: { note: "veraltet" }, expectedVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect(stale.body.error.message).toMatch(/zwischenzeitlich geändert/);
    // address by id only (Repository.updateTimeEntry signature)
    const unscoped = await t.call("PATCH", `/api/time-entries/${id}`, { cookie: c.emp1A, body: { patch: { note: "ohne Mitarbeiter-ID" }, expectedVersion: 2 } });
    expect(unscoped.status).toBe(200);
    expect(unscoped.body.version).toBe(3);
  });

  it("rejects overlapping entries with 409 and a German message", async () => {
    // seed: 2026-10-05 19:00 – 2026-10-06 03:00 (night shift)
    const r = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body: entry("overlap-0001", "2026-10-06", "02:00", "05:00", 0) });
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({ code: "overlap", message: "Einsätze überschneiden sich. Bitte die Zeiten korrigieren." });
    expect(await countRows(E.emp1A, "overlap-0001")).toBe(0);
  });

  it("soft-deletes (row stays, list hides it); deleting again fails", async () => {
    const id = "del-entry-0001";
    await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body: entry(id, "2026-10-14", "08:00", "10:00", 0) });
    const del = await t.call("DELETE", `/api/employees/${E.emp1A}/time-entries/${id}`, { cookie: c.emp1A, body: { expectedVersion: 1 } });
    expect(del.status).toBe(204);
    const row = (await t.db.admin.query("select deleted_at, version from public.time_entries where employee_id = $1 and id = $2", [E.emp1A, id])).rows[0];
    expect(row.deleted_at).not.toBeNull();
    expect(row.version).toBe(2);
    const list = await t.call("GET", `/api/employees/${E.emp1A}/time-entries?month=2026-10`, { cookie: c.emp1A });
    expect(list.body.map((e: { id: string }) => e.id)).not.toContain(id);
    const again = await t.call("DELETE", `/api/employees/${E.emp1A}/time-entries/${id}`, { cookie: c.emp1A, body: { expectedVersion: 2 } });
    expect(again.status).toBe(409);
  });

  it("an approved month is locked (423)", async () => {
    const r = await t.call("PATCH", `/api/employees/${E.emp1A}/time-entries/demo-a03-20260901`, { cookie: c.emp1A, body: { patch: { note: "nachträglich" }, expectedVersion: 1 } });
    expect(r.status).toBe(423);
    expect(r.body.error.message).toMatch(/freigegeben und gesperrt/);
  });

  it("validates input with German messages", async () => {
    const bad = [
      [{ ...entry("val-0001", "2026-02-30", "08:00", "10:00", 0) }, /gültiges Datum/],
      [{ ...entry("val-0002", "2026-10-15", "8:00", "10:00", 0) }, /HH:MM/],
      [{ ...entry("x", "2026-10-15", "08:00", "10:00", 0) }, /Eintrags-ID/],
      [{ ...entry("val-0004", "2026-10-15", "08:00", "10:00", -5) }, /Pause/],
      [{ ...entry("val-0005", "2026-10-15", "08:00", "10:00", 0), extra: 1 }, /Unbekanntes Feld: extra/],
      [{ ...entry("val-0006", "2026-10-15", "08:00", "10:00", 0, "x".repeat(501)) }, /höchstens 500 Zeichen/],
    ] as const;
    for (const [body, msg] of bad) {
      const r = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(msg);
    }
    const json = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, rawBody: "{kein json" });
    expect(json.status).toBe(400);
  });
});

describe("source \"migration\" (legacy import, QA B5)", () => {
  it("only for the signed-in person's own entries; managers cannot mark entries of others", async () => {
    const own = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body: { ...entry("legacy-own-0001", "2026-10-20", "08:00", "12:00", 0), source: "migration" } });
    expect(own.status).toBe(201);
    expect(own.body.source).toBe("migration");
    for (const who of ["managerA", "ownerA"] as const) {
      const other = await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c[who], body: { ...entry(`legacy-${who}-0001`, "2026-10-21", "08:00", "12:00", 0), source: "migration" } });
      expect(other.status).toBe(403);
      expect(other.body.error.message).toBe("Altdaten können nur für das eigene Konto übernommen werden.");
      expect(await countRows(E.emp2A, `legacy-${who}-0001`)).toBe(0);
    }
    // The same request without the marker is a normal entry by the manager.
    const normal = await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c.managerA, body: entry("legacy-managerA-0002", "2026-10-21", "08:00", "12:00", 0) });
    expect(normal.status).toBe(201);
    expect(normal.body.source).toBe("app");
    const bad = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body: { ...entry("legacy-own-0002", "2026-10-22", "08:00", "12:00", 0), source: "correction" } });
    expect(bad.status).toBe(400);
  });
});

describe("break rules (tenant breakPolicy, checked by the API with platform/src/core)", () => {
  it("tenant A (from exactly 6 h): 6:00 h without pause → 400 with the core message, nothing stored", async () => {
    const r = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body: entry("pause-0001", "2026-10-16", "08:00", "14:00", 0) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("break_rule");
    expect(r.body.error.message).toBe(
      "Für diesen Arbeitstag mit 6 Stunden erfasster Einsatzzeit sind mindestens 30 Minuten Pause erforderlich. Es fehlen noch 30 Minuten gültige Pause. Bitte die tatsächlich genommenen Pausen eintragen. Pausenabschnitte müssen mindestens 15 Minuten dauern.",
    );
    expect(await countRows(E.emp1A, "pause-0001")).toBe(0);
    const ok = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body: entry("pause-0002", "2026-10-16", "08:00", "14:00", 30) });
    expect(ok.status).toBe(201);
  });

  it("tenant B (more than 6 h: 361 min): exactly 6:00 h without pause is allowed", async () => {
    const r = await t.call("POST", `/api/employees/${E.empB}/time-entries`, { cookie: c.empB, body: entry("pause-b-0001", "2026-10-16", "08:00", "14:00", 0) });
    expect(r.status).toBe(201);
  });

  it("from 9 h, 45 minutes are required", async () => {
    const r = await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c.emp2A, body: entry("pause-0003", "2026-10-16", "06:00", "15:00", 30) });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/mindestens 45 Minuten Pause/);
  });

  it("checks the whole day (two shifts) and the daily 12 h sum", async () => {
    await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c.emp2A, body: entry("day-0001", "2026-10-19", "06:00", "10:00", 0) });
    const second = await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c.emp2A, body: entry("day-0002", "2026-10-19", "10:00", "13:00", 0) });
    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/7 Stunden erfasster Einsatzzeit/);
    await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c.emp2A, body: entry("day-0003", "2026-10-20", "00:00", "07:00", 30) });
    const tooMuch = await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c.emp2A, body: entry("day-0004", "2026-10-20", "12:00", "18:00", 30) });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.message).toMatch(/zusammen mehr als 12 Stunden/);
  });

  it("single shift over 12 h is rejected by the database rule (400)", async () => {
    const r = await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c.emp2A, body: entry("long-0001", "2026-10-21", "06:00", "18:30", 60) });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/höchstens 720 Minuten/);
  });

  it("an update that breaks the rule is rolled back (version unchanged)", async () => {
    const id = "pause-upd-0001";
    expect((await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c.emp2A, body: entry(id, "2026-10-22", "08:00", "16:00", 30) })).status).toBe(201);
    const r = await t.call("PATCH", `/api/time-entries/${id}`, { cookie: c.emp2A, body: { patch: { pauseMinutes: 10 }, expectedVersion: 1 } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("break_rule");
    const row = (await t.db.admin.query("select pause_minutes, version from public.time_entries where employee_id = $1 and id = $2", [E.emp2A, id])).rows[0];
    expect(row).toEqual({ pause_minutes: 30, version: 1 });
  });
});

describe("monthly statements and work account", () => {
  it("returning a statement requires a reason", async () => {
    const id = (await t.db.admin.query("select id from public.monthly_statements where employee_id = $1 and month = '2026-10'", [E.empB])).rows[0].id;
    const none = await t.call("POST", `/api/statements/${id}/return`, { cookie: c.ownerB, body: {} });
    expect(none.status).toBe(400);
    expect(none.body.error.message).toBe("Bitte einen Grund für die Rückgabe angeben.");
    const blank = await t.call("POST", `/api/statements/${id}/return`, { cookie: c.ownerB, body: { reason: "  " } });
    expect(blank.status).toBe(400);
    const ok = await t.call("POST", `/api/statements/${id}/return`, { cookie: c.ownerB, body: { reason: "Bitte Tour Süd prüfen" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "returned", reviewNote: "Bitte Tour Süd prüfen" });
  });

  it("submit → allocation review → approve → month locked → owner re-opens", async () => {
    const month = "2026-10";
    const sub = await t.call("POST", `/api/employees/${E.emp1A}/statements/${month}/submit`, { cookie: c.emp1A, body: {} });
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe("submitted");
    expect(sub.body.workedMinutes).toBeGreaterThan(0);
    const again = await t.call("POST", `/api/employees/${E.emp1A}/statements/${month}/submit`, { cookie: c.emp1A, body: {} });
    expect(again.status).toBe(409);

    // the employee cannot approve; the open allocation blocks approval
    expect((await t.call("POST", `/api/statements/${sub.body.id}/approve`, { cookie: c.emp1A, body: {} })).status).toBe(403);
    const blocked = await t.call("POST", `/api/statements/${sub.body.id}/approve`, { cookie: c.managerA, body: {} });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Zuweisung/);
    const rejectNoReason = await t.call("POST", `/api/employees/${E.emp1A}/allocations/${month}/review`, { cookie: c.managerA, body: { decision: "rejected" } });
    expect(rejectNoReason.status).toBe(400);
    const review = await t.call("POST", `/api/employees/${E.emp1A}/allocations/${month}/review`, { cookie: c.managerA, body: { decision: "approved" } });
    expect(review.status).toBe(200);
    expect(review.body).toEqual({ employeeId: E.emp1A, month, minutes: 300, status: "approved" });

    const approved = await t.call("POST", `/api/statements/${sub.body.id}/approve`, { cookie: c.managerA, body: {} });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    const listed = await t.call("GET", `/api/tenants/${IDS.tenantA}/statements?month=${month}`, { cookie: c.managerA });
    expect(listed.body.map((s: { id: string }) => s.id)).toContain(sub.body.id);
    expect((await t.call("GET", `/api/employees/${E.emp1A}/statements/${month}`, { cookie: c.emp1A })).body.status).toBe("approved");

    const locked = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c.emp1A, body: entry("locked-0001", "2026-10-28", "08:00", "10:00", 0) });
    expect(locked.status).toBe(423);

    const reopen = await t.call("POST", `/api/statements/${sub.body.id}/return`, { cookie: c.ownerA, body: { reason: "Korrektur nötig" } });
    expect(reopen.status).toBe(200);
    expect(reopen.body.status).toBe("returned");
  });

  it("refuses to submit a month with break-rule problems", async () => {
    await t.db.admin.query(
      `insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time, pause_minutes)
       values ('legacy-ohne-pause', $1, $2, '2026-11-03', '06:00', '14:00', 0)`, [IDS.tenantA, E.emp2A]);
    const r = await t.call("POST", `/api/employees/${E.emp2A}/statements/2026-11/submit`, { cookie: c.emp2A, body: {} });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/^Bitte zunächst die Pause korrigieren\. 03\.11\.2026: /);
  });

  it("allocations: employee proposes, list shows it", async () => {
    const set = await t.call("PUT", `/api/employees/${E.emp2A}/allocations/2026-11`, { cookie: c.emp2A, body: { minutes: 120 } });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ employeeId: E.emp2A, month: "2026-11", minutes: 120, status: "proposed" });
    const list = await t.call("GET", `/api/employees/${E.emp2A}/allocations`, { cookie: c.emp2A });
    expect(list.body).toContainEqual(set.body);
    const early = await t.call("PUT", `/api/employees/${E.emp2A}/allocations/2026-08`, { cookie: c.emp2A, body: { minutes: 60 } });
    expect(early.status).toBe(400);
    expect(early.body.error.message).toMatch(/erst ab 2026-09/);
  });
});

describe("tenant profile validation", () => {
  const png = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString("base64");

  it("owner updates branding with a PNG logo", async () => {
    const r = await t.call("PATCH", `/api/tenants/${IDS.tenantA}/branding`, { cookie: c.ownerA, body: { logoUrl: png, primaryColor: "#112233", slogan: "Neu" } });
    expect(r.status).toBe(200);
    expect(r.body.branding).toMatchObject({ logoUrl: png, primaryColor: "#112233", slogan: "Neu", accentColor: "#1D3557" });
  });

  it("rejects SVG, fake PNG, oversized images and bad colours", async () => {
    const svg = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
    const cases: [unknown, number, RegExp][] = [
      [{ logoUrl: svg }, 400, /SVG/],
      [{ logoUrl: "data:image/png;base64," + Buffer.from("<html>").toString("base64") }, 400, /passt nicht/],
      [{ logoUrl: "data:image/png;base64," + "A".repeat(500_000) }, 400, /zu groß/],
      [{ logoUrl: "javascript:alert(1)" }, 400, /https/],
      [{ logoUrl: "http://unsicher.example/logo.png" }, 400, /https/],
      [{ primaryColor: "red" }, 400, /#RRGGBB/],
      [{ unknownKey: 1 }, 400, /Unbekanntes Feld/],
    ];
    for (const [body, status, msg] of cases) {
      const r = await t.call("PATCH", `/api/tenants/${IDS.tenantA}/branding`, { cookie: c.ownerA, body });
      expect(r.status).toBe(status);
      expect(r.body.error.message).toMatch(msg);
    }
  });

  it("owner updates contact and settings (merged, validated)", async () => {
    const contact = await t.call("PATCH", `/api/tenants/${IDS.tenantA}/contact`, { cookie: c.ownerA, body: { city: "Neustadt", whatsapp: "4915100000009" } });
    expect(contact.status).toBe(200);
    expect(contact.body.contact).toMatchObject({ city: "Neustadt", whatsapp: "4915100000009", street: "Beispielweg 1" });
    const badWa = await t.call("PATCH", `/api/tenants/${IDS.tenantA}/contact`, { cookie: c.ownerA, body: { whatsapp: "+49 151" } });
    expect(badWa.status).toBe(400);
    const settings = await t.call("PATCH", `/api/tenants/${IDS.tenantA}/settings`, { cookie: c.ownerA, body: { workAccount: { approvalRequired: false } } });
    expect(settings.status).toBe(200);
    expect(settings.body.settings.workAccount).toMatchObject({ approvalRequired: false, enabled: true, startMonth: "2026-09" });
    expect(settings.body.settings.breakPolicy.maxShiftMinutes).toBe(720);
    const badOrder = await t.call("PATCH", `/api/tenants/${IDS.tenantA}/settings`, { cookie: c.ownerA, body: { breakPolicy: { thresholds: [{ minGrossMinutes: 540, minPauseMinutes: 45 }, { minGrossMinutes: 360, minPauseMinutes: 30 }] } } });
    expect(badOrder.status).toBe(400);
  });

  it("duplicate personnel number → 409 with German text", async () => {
    const r = await t.call("POST", `/api/tenants/${IDS.tenantA}/employees`, { cookie: c.ownerA, body: { displayName: "Doppelt", personnelNumber: "A-101", email: null, role: "employee" } });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("Diese Personalnummer ist bereits vergeben.");
  });

  it("public branding for the login page works without sign-in", async () => {
    const r = await t.call("GET", "/api/public/tenants/muster-pflegedienst/branding");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ slug: "muster-pflegedienst", name: "Muster Pflegedienst GmbH" });
    expect((await t.call("GET", "/api/public/tenants/gibt-es-nicht/branding")).status).toBe(404);
    expect((await t.call("GET", "/api/health")).body).toEqual({ ok: true });
  });
});

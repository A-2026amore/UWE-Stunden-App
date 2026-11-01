/**
 * Data protection endpoints over HTTP (migration 0016, server/src/privacy.ts):
 * personal data export (JSON/CSV), tenant export, retention setting, anonymisation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const c: Record<string, string> = {};
const A = IDS.tenantA;
const E = IDS.employees;

beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["ownerA", "managerA", "emp1A", "emp2A", "ownerB"] as const) c[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
});

describe("personal data export", () => {
  it("the person downloads their own data as JSON (attachment, not cached)", async () => {
    const r = await t.call("GET", `/api/employees/${E.emp1A}/data-export`, { cookie: c.emp1A });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="datenauskunft-A-101-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({ format: "stundenwerk.personal-data.v1", requestedBy: "self", person: { displayName: "Sam Probe" } });
    expect(r.body.account.email).toBe("fahrer1@demo-krankentransporte.example");
    expect(r.body.account.sessions.length).toBeGreaterThanOrEqual(1);
    expect(r.body.timeEntries).toHaveLength(4);
  });

  it("CSV is readable (BOM, sections) and formula-safe", async () => {
    const created = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, {
      cookie: c.emp1A, body: { id: "csv-injektion-1", date: "2026-10-20", start: "08:00", end: "12:00", pauseMinutes: 0, note: "=HYPERLINK(\"http://x.example\")" },
    });
    expect(created.status).toBe(201);
    const res = await fetch(`${t.url}/api/employees/${E.emp1A}/data-export?format=csv`, { headers: { Cookie: c.emp1A } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/\.csv"$/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for spreadsheet programs
    const text = bytes.toString("utf8");
    for (const s of ["Datenauskunft (Art. 15 DSGVO)", "Sam Probe", "Arbeitszeiten", "01.09.2026;06:00;14:30;30;8,00;Frühdienst", "Anmeldesitzungen", "Protokoll (Audit)"]) {
      expect(text).toContain(s);
    }
    expect(text).toContain("\"'=HYPERLINK(\"\"http://x.example\"\")\"");
    expect(text).not.toMatch(/(^|;)=HYPERLINK/m);
  });

  it("the owner gets the export without account data; leadership and others do not", async () => {
    const r = await t.call("GET", `/api/employees/${E.emp1A}/data-export`, { cookie: c.ownerA });
    expect(r.status).toBe(200);
    expect(r.body.requestedBy).toBe("owner");
    expect(r.body.account).toBeNull();
    for (const who of ["managerA", "emp2A", "ownerB"]) {
      const x = await t.call("GET", `/api/employees/${E.emp1A}/data-export`, { cookie: c[who] });
      expect(`${who} ${x.status}`).toBe(`${who} 403`);
      expect(JSON.stringify(x.body)).not.toContain("Sam Probe");
    }
    expect((await t.call("GET", `/api/employees/${E.emp1A}/data-export?format=xml`, { cookie: c.emp1A })).status).toBe(400);
    expect((await t.call("GET", `/api/employees/${E.emp1A}/data-export`)).status).toBe(401);
  });

  it("each export is in the audit log of the tenant (visible to leadership)", async () => {
    const audit = await t.call("GET", `/api/tenants/${A}/audit`, { cookie: c.managerA });
    const exports = audit.body.filter((a: { action: string }) => a.action === "employee.data_export");
    expect(exports.length).toBeGreaterThanOrEqual(3);
  });
});

describe("tenant data export", () => {
  it("owner gets all data as JSON and the working times as CSV", async () => {
    const r = await t.call("GET", `/api/tenants/${A}/data-export`, { cookie: c.ownerA });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/firmendaten-demo-krankentransporte-.*\.json/);
    expect(r.body.employees.map((e: { personnelNumber: string }) => e.personnelNumber)).toEqual(["A-001", "A-002", "A-101", "A-102"]);
    expect(JSON.stringify(r.body)).not.toContain("Muster Pflegedienst");
    const res = await fetch(`${t.url}/api/tenants/${A}/data-export?format=csv`, { headers: { Cookie: c.ownerA } });
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
    expect(text.split("\r\n")[0]).toBe("﻿Personalnummer;Name;Datum;Beginn;Ende;Pause (Min.);Arbeitszeit (Std.);Bemerkung;Herkunft;Version;Gelöscht am");
    expect(text).toContain("A-101;Sam Probe;01.09.2026;06:00;14:30;30;8,00;Frühdienst;App;1;");
  });

  it("nobody but the owner", async () => {
    for (const who of ["managerA", "emp1A", "ownerB"]) {
      expect((await t.call("GET", `/api/tenants/${A}/data-export`, { cookie: c[who] })).status).toBe(403);
    }
  });
});

describe("retention period and anonymisation", () => {
  it("only the owner sets the retention period (1–600 months or null)", async () => {
    expect((await t.call("PUT", `/api/tenants/${A}/privacy`, { cookie: c.managerA, body: { retentionMonthsAfterExit: 12 } })).status).toBe(403);
    expect((await t.call("PUT", `/api/tenants/${A}/privacy`, { cookie: c.ownerA, body: { retentionMonthsAfterExit: 0 } })).status).toBe(400);
    expect((await t.call("PUT", `/api/tenants/${A}/privacy`, { cookie: c.ownerA, body: { retentionMonthsAfterExit: "12" } })).status).toBe(400);
    const r = await t.call("PUT", `/api/tenants/${A}/privacy`, { cookie: c.ownerA, body: { retentionMonthsAfterExit: 24 } });
    expect(r.status).toBe(200);
    expect(r.body.retentionMonthsAfterExit).toBe(24);
    expect((await t.call("GET", `/api/tenants/${A}`, { cookie: c.emp1A })).body.retentionMonthsAfterExit).toBe(24);
  });

  it("anonymises a former employee only after the period, with confirmation, owner only", async () => {
    // Jo Demo leaves.
    const off = await t.call("POST", `/api/employees/${E.emp2A}/status`, { cookie: c.managerA, body: { status: "deactivated", reason: "Ausgeschieden" } });
    expect(off.status).toBe(200);
    const early = await t.call("POST", `/api/employees/${E.emp2A}/anonymize`, { cookie: c.ownerA, body: { confirmPersonnelNumber: "A-102" } });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/Aufbewahrungsfrist läuft noch bis zum \d\d\.\d\d\.\d{4}/);
    // Exit three years ago (test only: history moved directly in the database).
    await t.db.admin.query("delete from public.employee_status_history where employee_id = $1 and valid_to is not null", [E.emp2A]);
    await t.db.admin.query("update public.employee_status_history set valid_from = now() - interval '3 years' where employee_id = $1", [E.emp2A]);

    expect((await t.call("POST", `/api/employees/${E.emp2A}/anonymize`, { cookie: c.managerA, body: { confirmPersonnelNumber: "A-102" } })).status).toBe(403);
    expect((await t.call("POST", `/api/employees/${E.emp2A}/anonymize`, { cookie: c.ownerB, body: { confirmPersonnelNumber: "A-102" } })).status).toBe(403);
    expect((await t.call("POST", `/api/employees/${E.emp2A}/anonymize`, { cookie: c.ownerA, body: { confirmPersonnelNumber: "A-999" } })).status).toBe(400);
    expect((await t.call("POST", `/api/employees/${E.emp2A}/anonymize`, { cookie: c.ownerA, body: {} })).status).toBe(400);

    const r = await t.call("POST", `/api/employees/${E.emp2A}/anonymize`, { cookie: c.ownerA, body: { confirmPersonnelNumber: "A-102" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: E.emp2A, email: null, status: "deactivated" });
    expect(r.body.displayName).toMatch(/^Anonymisiert /);
    expect(r.body.anonymizedAt).toBeTruthy();

    // The tenant no longer knows the person; the old session and login are gone.
    const all = await t.call("GET", `/api/tenants/${A}/data-export`, { cookie: c.ownerA });
    expect(JSON.stringify(all.body)).not.toContain("Jo Demo");
    expect(JSON.stringify(all.body)).not.toContain("fahrer2@");
    expect((await t.call("GET", "/api/auth/session", { cookie: c.emp2A })).body).toBeNull();
    expect((await t.call("POST", "/api/auth/login", { body: { email: "fahrer2@demo-krankentransporte.example", password: "Demo-Passwort-nur-Test-1" } })).status).toBe(401);
    // Final: no renaming back, no second run.
    expect((await t.call("PATCH", `/api/employees/${E.emp2A}`, { cookie: c.ownerA, body: { displayName: "Jo Demo" } })).status).toBe(403);
    expect((await t.call("POST", `/api/employees/${E.emp2A}/status`, { cookie: c.ownerA, body: { status: "active", reason: "Zurück" } })).status).toBe(403);
  });
});

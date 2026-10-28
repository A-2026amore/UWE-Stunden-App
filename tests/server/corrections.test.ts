/**
 * Correction requests over HTTP (migration 0013): request, list, withdraw,
 * decide with break-rule check, revisions and the statement flag.
 * Seed: September 2026 of Sam Probe (emp1A) is approved → locked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const c: Record<string, string> = {};
const E = IDS.employees;
const A = IDS.tenantA;

beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["ownerA", "managerA", "emp1A", "emp2A", "ownerB", "superAdmin"] as const) c[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
});

const post = (who: string, path: string, body: unknown) => t.call("POST", path, { cookie: c[who], body });
const get = (who: string, path: string) => t.call("GET", path, { cookie: c[who] });

describe("correction requests", () => {
  let changeId = "";

  it("employee cannot edit the locked month directly (423) but can request a change (201)", async () => {
    const direct = await t.call("PATCH", `/api/employees/${E.emp1A}/time-entries/demo-a03-20260901`, { cookie: c.emp1A, body: { patch: { end: "14:45" }, expectedVersion: 1 } });
    expect(direct.status).toBe(423);
    const r = await post("emp1A", `/api/employees/${E.emp1A}/correction-requests`, { kind: "change", entryId: "demo-a03-20260901", proposed: { end: "14:45" }, reason: "Fahrtenbuch: Ende 14:45 Uhr" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      tenantId: A, employeeId: E.emp1A, kind: "change", entryId: "demo-a03-20260901", entryVersion: 1, status: "open",
      before: { date: "2026-09-01", start: "06:00", end: "14:30", pauseMinutes: 30, note: "Frühdienst" },
      proposed: { date: "2026-09-01", start: "06:00", end: "14:45", pauseMinutes: 30, note: "Frühdienst" },
      reason: "Fahrtenbuch: Ende 14:45 Uhr", decidedAt: null, decidedByName: null, decisionNote: null, appliedEntryId: null,
    });
    changeId = r.body.id;
  });

  it("validates the request: reason, kind, values, break rules, overlap, own entries only", async () => {
    const path = `/api/employees/${E.emp1A}/correction-requests`;
    const bad: Array<[unknown, number, string?]> = [
      [{ kind: "change", entryId: "demo-a03-20260902", proposed: { end: "07:00" }, reason: "kurz" }, 400],
      [{ kind: "rename", entryId: "demo-a03-20260902", reason: "Begründung lang genug" }, 400],
      [{ kind: "change", entryId: "demo-a03-20260902", proposed: {}, reason: "Begründung lang genug" }, 400],
      [{ kind: "delete", entryId: "demo-a03-20260902", proposed: { end: "07:00" }, reason: "Begründung lang genug" }, 400],
      [{ kind: "add", proposed: { date: "2026-09-10", start: "08:00" }, reason: "Begründung lang genug" }, 400],
      // 7 h without pause on a new day → statutory break rule of the tenant
      [{ kind: "add", proposed: { date: "2026-09-10", start: "08:00", end: "14:45", pauseMinutes: 0 }, reason: "Begründung lang genug" }, 400, "break_rule"],
      // overlaps the night shift 02.09. 22:00 – 03.09. 06:00
      [{ kind: "add", proposed: { date: "2026-09-03", start: "05:00", end: "07:00", pauseMinutes: 0 }, reason: "Begründung lang genug" }, 409, "overlap"],
      [{ kind: "change", entryId: "demo-a03-20260901", proposed: { end: "14:40" }, reason: "Zweite Anfrage" }, 409, "invalid_state"],
    ];
    for (const [body, status, code] of bad) {
      const r = await post("emp1A", path, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      if (code) expect(r.body.error.code).toBe(code);
    }
    const foreign = await post("emp2A", path, { kind: "delete", entryId: "demo-a03-20260902", reason: "fremder Eintrag" });
    expect(foreign.status).toBe(403);
    const manager = await post("managerA", path, { kind: "delete", entryId: "demo-a03-20260902", reason: "Leitung für andere" });
    expect(manager.status).toBe(403);
  });

  it("lists: own requests for the employee, the tenant for leadership; nothing for others", async () => {
    const own = await get("emp1A", `/api/tenants/${A}/correction-requests`);
    expect(own.status).toBe(200);
    expect(own.body.map((r: { id: string }) => r.id)).toEqual([changeId]);
    expect((await get("emp2A", `/api/tenants/${A}/correction-requests`)).body).toEqual([]);
    const open = await get("managerA", `/api/tenants/${A}/correction-requests?status=open&employeeId=${E.emp1A}`);
    expect(open.body).toHaveLength(1);
    expect((await get("ownerB", `/api/tenants/${A}/correction-requests`)).status).toBe(403);
    expect((await get("superAdmin", `/api/tenants/${A}/correction-requests`)).status).toBe(403);
    expect((await get("managerA", `/api/tenants/${A}/correction-requests?status=maybe`)).status).toBe(400);
  });

  it("the employee cannot decide; rejection needs a reason", async () => {
    expect((await post("emp1A", `/api/correction-requests/${changeId}/decide`, { decision: "accepted" })).status).toBe(403);
    expect((await post("ownerB", `/api/correction-requests/${changeId}/decide`, { decision: "accepted" })).status).toBe(403);
    expect((await post("managerA", `/api/correction-requests/${changeId}/decide`, { decision: "rejected" })).status).toBe(400);
  });

  it("approved month: accepting needs a documented re-opening; the re-approval stores new figures", async () => {
    const before = await get("managerA", `/api/tenants/${A}/statements?month=2026-09`);
    const st = before.body.find((s: { employeeId: string }) => s.employeeId === E.emp1A);
    expect(st).toMatchObject({ status: "approved", correctedAfterApproval: null });

    const locked = await post("managerA", `/api/correction-requests/${changeId}/decide`, { decision: "accepted", note: "Passt" });
    expect(locked.status).toBe(423);
    expect(locked.body.error.message).toContain("wieder geöffnet");

    expect((await post("emp1A", `/api/statements/${st.id}/reopen`, { reason: "Bitte öffnen" })).status).toBe(403);
    expect((await post("managerA", `/api/statements/${st.id}/reopen`, { reason: "kurz" })).status).toBe(400);
    const reopened = await post("managerA", `/api/statements/${st.id}/reopen`, { reason: "Korrekturanfrage Fahrtenbuch" });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: "reopened", reviewNote: "Korrekturanfrage Fahrtenbuch" });
    expect(reopened.body.reopenedAt).toBeTruthy();

    const r = await post("managerA", `/api/correction-requests/${changeId}/decide`, { decision: "accepted", note: "Passt" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "accepted", decidedByName: "Robin Leitung", decisionNote: "Passt", appliedEntryId: "demo-a03-20260901" });

    const list = await get("emp1A", `/api/employees/${E.emp1A}/time-entries?month=2026-09`);
    expect(list.body.find((e: { id: string }) => e.id === "demo-a03-20260901")).toMatchObject({ end: "14:45", version: 2, source: "correction" });
    const mine = await get("emp1A", `/api/employees/${E.emp1A}/statements/2026-09`);
    expect(mine.body).toMatchObject({ status: "reopened", correctedAfterApproval: null });

    const approved = await post("managerA", `/api/statements/${st.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.workedMinutes).not.toBe(st.workedMinutes);
    const events = await get("emp1A", `/api/statements/${st.id}/events`);
    expect(events.status).toBe(200);
    expect(events.body.map((e: { action: string }) => e.action).slice(-2)).toEqual(["reopen", "approve"]);
    expect(events.body.find((e: { action: string }) => e.action === "reopen")).toMatchObject({ reason: "Korrekturanfrage Fahrtenbuch", actorName: null });
    const lead = await get("managerA", `/api/statements/${st.id}/events`);
    expect(lead.body.find((e: { action: string }) => e.action === "reopen")).toMatchObject({ actorName: "Robin Leitung" });
    expect((await get("emp2A", `/api/statements/${st.id}/events`)).status).toBe(403);
    expect((await get("ownerB", `/api/statements/${st.id}/events`)).status).toBe(403);

    // the employee sees status, answer and who decided
    const own = (await get("emp1A", `/api/tenants/${A}/correction-requests`)).body[0];
    expect(own).toMatchObject({ status: "accepted", decisionNote: "Passt" });
    expect(own.decidedByName).toBeNull(); // employees do not see other people's names (RLS on employees)

    const again = await post("ownerA", `/api/correction-requests/${changeId}/decide`, { decision: "rejected", note: "zu spät" });
    expect(again.status).toBe(409);
  });

  it("history of an entry: revisions with correction flag, reason and name; not for colleagues", async () => {
    const r = await get("managerA", `/api/employees/${E.emp1A}/time-entries/demo-a03-20260901/revisions`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[0]).toMatchObject({ version: 1, operation: "insert", isCorrection: false, values: { start: "06:00", end: "14:30", pauseMinutes: 30 }, deleted: false, source: "app" });
    expect(r.body[1]).toMatchObject({
      version: 2, operation: "update", isCorrection: true, changedByName: "Robin Leitung", source: "correction",
      reason: "Korrekturanfrage: Fahrtenbuch: Ende 14:45 Uhr – Leitung: Passt", values: { date: "2026-09-01", end: "14:45" },
    });
    expect((await get("emp1A", `/api/employees/${E.emp1A}/time-entries/demo-a03-20260901/revisions`)).status).toBe(200);
    expect((await get("emp2A", `/api/employees/${E.emp1A}/time-entries/demo-a03-20260901/revisions`)).status).toBe(403);
    expect((await get("ownerB", `/api/employees/${E.emp1A}/time-entries/demo-a03-20260901/revisions`)).status).toBe(403);
  });

  it("a missing entry that violates the break rules is refused on acceptance (rollback, request stays open)", async () => {
    // 08:00–12:00 (seed) + 12:30–14:30: 6 h work with a 30-minute gap → plausible when requested.
    const add = await post("emp2A", `/api/employees/${E.emp2A}/correction-requests`, { kind: "add", proposed: { date: "2026-10-01", start: "12:30", end: "14:30", pauseMinutes: 0 }, reason: "Nachmittag vergessen" });
    expect(add.status).toBe(201);
    // meanwhile the morning entry is extended to 12:15 → only 15 minutes break left for 6:15 h
    const upd = await t.call("PATCH", `/api/employees/${E.emp2A}/time-entries/demo-a04-20261001`, { cookie: c.emp2A, body: { patch: { end: "12:15" }, expectedVersion: 1 } });
    expect(upd.status).toBe(200);
    const r = await post("managerA", `/api/correction-requests/${add.body.id}/decide`, { decision: "accepted" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("break_rule");
    const still = (await get("managerA", `/api/tenants/${A}/correction-requests?status=open`)).body.map((x: { id: string }) => x.id);
    expect(still).toContain(add.body.id);
    const n = (await t.db.admin.query("select count(*)::int n from public.time_entries where employee_id = $1 and work_date = '2026-10-01'", [E.emp2A])).rows[0].n;
    expect(n).toBe(1);
  });

  it("withdraw: own open request only", async () => {
    const r = await post("emp1A", `/api/employees/${E.emp1A}/correction-requests`, { kind: "delete", entryId: "demo-a03-20260902", reason: "Nachtdienst getauscht" });
    expect(r.status).toBe(201);
    expect((await post("emp2A", `/api/correction-requests/${r.body.id}/withdraw`, {})).status).toBe(403);
    expect((await post("managerA", `/api/correction-requests/${r.body.id}/withdraw`, {})).status).toBe(403);
    const w = await post("emp1A", `/api/correction-requests/${r.body.id}/withdraw`, {});
    expect(w.status).toBe(200);
    expect(w.body.status).toBe("withdrawn");
    expect((await post("emp1A", `/api/correction-requests/${r.body.id}/withdraw`, {})).status).toBe(409);
  });

  it("audit trail for leadership", async () => {
    const audit = await get("managerA", `/api/tenants/${A}/audit?limit=100`);
    const actions = audit.body.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["correction_request.create", "correction_request.accept", "correction_request.withdraw", "time_entry.correction"]));
  });
});

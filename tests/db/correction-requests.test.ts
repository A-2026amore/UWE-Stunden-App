/**
 * Correction requests (migration 0013): employees ask for a change, deletion
 * or a missing entry; leadership accepts (applied as a correction) or rejects.
 * Seed: September 2026 of Sam Probe (emp1A) is approved → locked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db?.close();
});

const A = IDS.tenantA;
const B = IDS.tenantB;
const U = IDS.users;
const E = IDS.employees;

type Req = Record<string, unknown> & { id: string; status: string };

const create = (user: string, employee: string, kind: string, entryId: string | null, proposed: unknown, reason: string | null, commit = true) =>
  db.as(user, async (q) => (await q.query("select * from public.create_correction_request($1, $2, $3, $4, $5)",
    [employee, kind, entryId, proposed === null ? null : JSON.stringify(proposed), reason])).rows[0] as Req, { commit });

const decide = (user: string, id: string, decision: string, note: string | null = null, commit = true) =>
  db.as(user, async (q) => (await q.query("select * from public.decide_correction_request($1, $2, $3)", [id, decision, note])).rows[0] as Req, { commit });

const entryRow = async (employee: string, id: string) =>
  (await db.admin.query(
    `select id, to_char(work_date, 'YYYY-MM-DD') as date, to_char(start_time, 'HH24:MI') as start, to_char(end_time, 'HH24:MI') as "end",
            pause_minutes, note, version, source, deleted_at from public.time_entries where employee_id = $1 and id = $2`, [employee, id])).rows[0];

describe("creating correction requests", () => {
  let changeId = "";

  it("employee requests a change of an entry in the approved (locked) month", async () => {
    const r = await create(U.emp1A, E.emp1A, "change", "demo-a03-20260901", { end: "15:00" }, "Fahrtenbuch: Ende 15:00 Uhr");
    changeId = r.id;
    expect(r).toMatchObject({
      tenant_id: A, employee_id: E.emp1A, kind: "change", entry_id: "demo-a03-20260901", entry_version: 1, status: "open",
      before: { date: "2026-09-01", start: "06:00", end: "14:30", pauseMinutes: 30, note: "Frühdienst" },
      proposed: { date: "2026-09-01", start: "06:00", end: "15:00", pauseMinutes: 30, note: "Frühdienst" },
      reason: "Fahrtenbuch: Ende 15:00 Uhr", created_by: U.emp1A, decided_at: null,
    });
    const audit = (await db.admin.query("select action, actor_id, reason from public.audit_log where entity = 'correction_request' and entity_id = $1", [changeId])).rows;
    expect(audit).toEqual([{ action: "correction_request.create", actor_id: U.emp1A, reason: "Fahrtenbuch: Ende 15:00 Uhr" }]);
    // the entry itself is untouched until a decision
    expect(await entryRow(E.emp1A, "demo-a03-20260901")).toMatchObject({ end: "14:30", version: 1, source: "app" });
  });

  it("validates input: reason, kind, keys, unchanged values, hard limits, one open request per entry", async () => {
    const cases: Array<[string, string | null, unknown, string | null, string]> = [
      ["change", "demo-a03-20260902", { end: "07:00" }, null, "22023"],
      ["change", "demo-a03-20260902", { end: "07:00" }, "kurz", "22023"],
      ["rename", "demo-a03-20260902", { end: "07:00" }, "Begründung lang genug", "22023"],
      ["change", "demo-a03-20260902", { end: "07:00", source: "app" }, "Begründung lang genug", "22023"],
      ["change", "demo-a03-20260902", { end: "06:00" }, "Begründung lang genug", "22023"], // unchanged
      ["change", "demo-a03-20260902", { end: "11:00" }, "Begründung lang genug", "23514"], // 13 h
      ["change", "demo-a03-20260902", { pauseMinutes: 600 }, "Begründung lang genug", "23514"],
      ["change", "demo-a03-20260902", { start: "25:00" }, "Begründung lang genug", "22023"],
      ["change", "demo-a03-20260902", { date: "2026-02-30" }, "Begründung lang genug", "22008"],
      ["delete", "demo-a03-20260902", { end: "07:00" }, "Begründung lang genug", "22023"],
      ["add", "demo-a03-20260902", { date: "2026-09-10", start: "08:00", end: "12:00", pauseMinutes: 0 }, "Begründung lang genug", "22023"],
      ["add", null, { date: "2026-09-10", start: "08:00" }, "Begründung lang genug", "22023"],
      ["change", "demo-a03-20260901", { end: "15:30" }, "Zweite Anfrage zum selben Eintrag", "55000"],
      ["change", "gibt-es-nicht", { end: "15:30" }, "Begründung lang genug", "42501"],
    ];
    for (const [kind, entry, proposed, reason, code] of cases) {
      const e = await pgError(create(U.emp1A, E.emp1A, kind, entry, proposed, reason, false));
      expect(e.code, `${kind} ${JSON.stringify(proposed)} ${reason}`).toBe(code);
    }
  });

  it("only for own entries: not for colleagues, other tenants or by leadership on behalf of others", async () => {
    const e1 = await pgError(create(U.emp2A, E.emp1A, "change", "demo-a03-20260901", { end: "15:00" }, "fremder Eintrag", false));
    expect(e1.code).toBe("42501");
    const e2 = await pgError(create(U.managerA, E.emp1A, "delete", "demo-a03-20261001", null, "Leitung für andere", false));
    expect(e2.code).toBe("42501");
    const e3 = await pgError(create(U.ownerB, E.emp1A, "delete", "demo-a03-20261001", null, "anderer Mandant", false));
    expect(e3.code).toBe("42501");
    const e4 = await pgError(create(U.emp1A, E.empB, "delete", "demo-b03-20261002", null, "anderer Mandant", false));
    expect(e4.code).toBe("42501");
    for (const user of [U.superAdmin, U.support]) {
      const e = await pgError(create(user, E.emp1A, "delete", "demo-a03-20261001", null, "Plattformpersonal", false));
      expect(e.code).toBe("42501");
    }
  });

  it("request roles cannot write the table directly", async () => {
    const e1 = await pgError(db.as(U.emp1A, (q) => q.query(
      "insert into public.correction_requests (tenant_id, employee_id, kind, proposed, reason) values ($1, $2, 'add', '{}', 'direkt eingefügt')", [A, E.emp1A])));
    expect(e1.code).toBe("42501");
    const e2 = await pgError(db.as(U.ownerA, (q) => q.query("update public.correction_requests set status = 'accepted' where id = $1", [changeId])));
    expect(e2.code).toBe("42501");
    const e3 = await pgError(db.as(U.ownerA, (q) => q.query("delete from public.correction_requests where id = $1", [changeId])));
    expect(e3.code).toBe("42501");
  });

  it("visibility: own requests, leadership of the tenant; colleagues, other tenants and platform staff see nothing", async () => {
    const count = (user: string) => db.as(user, async (q) => (await q.query("select count(*)::int n from public.correction_requests")).rows[0].n as number);
    expect(await count(U.emp1A)).toBe(1);
    expect(await count(U.managerA)).toBe(1);
    expect(await count(U.ownerA)).toBe(1);
    expect(await count(U.emp2A)).toBe(0);
    expect(await count(U.ownerB)).toBe(0);
    expect(await count(U.empB)).toBe(0);
    expect(await count(U.superAdmin)).toBe(0);
    expect(await count(U.support)).toBe(0);
    // the audit entry of the request is visible to the tenant's leadership, not to platform staff without a grant
    const audit = (user: string) => db.as(user, async (q) => (await q.query("select count(*)::int n from public.audit_log where entity = 'correction_request'")).rows[0].n as number);
    expect(await audit(U.managerA)).toBe(1);
    expect(await audit(U.superAdmin)).toBe(0);
    expect(await audit(U.ownerB)).toBe(0);
  });

  it("platform support reads requests only with an active grant of the owner (read only)", async () => {
    await db.as(U.ownerA, (q) => q.query("select public.grant_support_access($1, 2, 'Prüfung Korrekturanfrage', null)", [A]), { commit: true });
    const n = await db.as(U.support, async (q) => (await q.query("select count(*)::int n from public.correction_requests where tenant_id = $1", [A])).rows[0].n);
    expect(n).toBe(1);
    const e = await pgError(decide(U.support, changeId, "rejected", "Support darf nicht entscheiden", false));
    expect(e.code).toBe("42501");
    const grants = (await db.admin.query("select id from public.support_access_grants where tenant_id = $1 and revoked_at is null", [A])).rows;
    for (const g of grants) await db.as(U.ownerA, (q) => q.query("select public.revoke_support_access($1)", [g.id]), { commit: true });
    const after = await db.as(U.support, async (q) => (await q.query("select count(*)::int n from public.correction_requests")).rows[0].n);
    expect(after).toBe(0);
  });
});

describe("deciding correction requests", () => {
  it("the employee cannot decide (accept) the own request; other tenants cannot either", async () => {
    const id = (await db.admin.query("select id from public.correction_requests where entry_id = 'demo-a03-20260901'")).rows[0].id;
    for (const user of [U.emp1A, U.emp2A, U.ownerB]) {
      const e = await pgError(decide(user, id, "accepted", null, false));
      expect(e.code).toBe("42501");
    }
  });

  it("rejecting requires a reason; the entry stays unchanged; a decided request is final", async () => {
    const r = await create(U.emp1A, E.emp1A, "delete", "demo-a03-20260902", null, "Doppelt erfasst laut Dienstplan");
    for (const note of [null, "", "  "]) {
      const e = await pgError(decide(U.managerA, r.id, "rejected", note, false));
      expect(e.code).toBe("22023");
    }
    const e0 = await pgError(decide(U.managerA, r.id, "maybe", "x", false));
    expect(e0.code).toBe("22023");
    const rejected = await decide(U.managerA, r.id, "rejected", "Einsatz ist im Fahrtenbuch belegt");
    expect(rejected).toMatchObject({ status: "rejected", decided_by: U.managerA, decision_note: "Einsatz ist im Fahrtenbuch belegt", applied_entry_id: null });
    expect(await entryRow(E.emp1A, "demo-a03-20260902")).toMatchObject({ deleted_at: null, version: 1 });
    const again = await pgError(decide(U.ownerA, r.id, "accepted", null, false));
    expect(again.code).toBe("55000");
    const withdraw = await pgError(db.as(U.emp1A, (q) => q.query("select public.withdraw_correction_request($1)", [r.id])));
    expect(withdraw.code).toBe("55000");
    const audit = (await db.admin.query("select action, reason from public.audit_log where entity_id = $1 order by created_at", [r.id])).rows;
    expect(audit).toEqual([
      { action: "correction_request.create", reason: "Doppelt erfasst laut Dienstplan" },
      { action: "correction_request.reject", reason: "Einsatz ist im Fahrtenbuch belegt" },
    ]);
  });

  it("approved month: accepting is refused (PT423) until the leadership re-opens the month (decision 28.10.2026)", async () => {
    const id = (await db.admin.query("select id from public.correction_requests where entry_id = 'demo-a03-20260901' and status = 'open'")).rows[0].id;
    const locked = await pgError(decide(U.managerA, id, "accepted", "Passt, danke", false));
    expect(locked.code).toBe("PT423");
    expect(locked.message).toContain("wieder geöffnet");
    expect((await db.admin.query("select status from public.correction_requests where id = $1", [id])).rows[0].status).toBe("open");
    expect(await entryRow(E.emp1A, "demo-a03-20260901")).toMatchObject({ version: 1 });

    const st = (await db.admin.query("select id from public.monthly_statements where employee_id = $1 and month = '2026-09'", [E.emp1A])).rows[0];
    const reopened = await db.as(U.managerA, async (q) => (await q.query("select * from public.reopen_statement($1, $2)", [st.id, "Korrekturanfrage Fahrtenbuch"])).rows[0], { commit: true });
    expect(reopened).toMatchObject({ status: "reopened", review_note: "Korrekturanfrage Fahrtenbuch", reopened_by: U.managerA });

    const r = await decide(U.managerA, id, "accepted", "Passt, danke");
    expect(r).toMatchObject({ status: "accepted", decided_by: U.managerA, decision_note: "Passt, danke", applied_entry_id: "demo-a03-20260901", applied_version: 2 });
    expect(await entryRow(E.emp1A, "demo-a03-20260901")).toMatchObject({ end: "15:00", version: 2, source: "correction" });

    const rev = (await db.admin.query("select version, operation, is_correction, changed_by, reason from public.time_entry_revisions where entry_id = 'demo-a03-20260901' order by version")).rows;
    expect(rev).toHaveLength(2);
    expect(rev[1]).toMatchObject({ version: 2, operation: "update", is_correction: true, changed_by: U.managerA });
    expect(rev[1].reason).toBe("Korrekturanfrage: Fahrtenbuch: Ende 15:00 Uhr – Leitung: Passt, danke");
    const audit = (await db.admin.query("select action from public.audit_log where entity_id in ($1, $2) order by created_at, action", [id, `${E.emp1A}/demo-a03-20260901`])).rows.map((x) => x.action);
    expect(audit).toEqual(["correction_request.create", "correction_request.accept", "time_entry.correction"]);

    // the re-opened month is not "corrected after approval" (that state can no longer arise)
    for (const user of [U.managerA, U.emp1A]) {
      const flags = await db.as(user, async (q) => (await q.query("select * from public.statement_correction_flags where employee_id = $1", [E.emp1A])).rows);
      expect(flags).toEqual([]);
    }
  });

  it("accepting a deletion soft-deletes the entry", async () => {
    const r = await create(U.emp1A, E.emp1A, "delete", "demo-a03-20260902", null, "Nachtdienst wurde getauscht");
    const d = await decide(U.ownerA, r.id, "accepted");
    expect(d).toMatchObject({ status: "accepted", applied_entry_id: "demo-a03-20260902", decision_note: null });
    const row = await entryRow(E.emp1A, "demo-a03-20260902");
    expect(row.deleted_at).not.toBeNull();
    expect(row.source).toBe("correction");
  });

  it("accepting a missing entry inserts it as correction; an overlap is refused and the request stays open", async () => {
    const r = await create(U.emp1A, E.emp1A, "add", null, { date: "2026-09-03", start: "07:00", end: "12:00", pauseMinutes: 0, note: "Nachtrag" }, "Einsatz vergessen einzutragen");
    expect(r).toMatchObject({ kind: "add", entry_id: null, before: null, proposed: { date: "2026-09-03", start: "07:00", end: "12:00", pauseMinutes: 0, note: "Nachtrag" } });
    const d = await decide(U.managerA, r.id, "accepted");
    const newId = `kr-${r.id.replaceAll("-", "")}`;
    expect(d).toMatchObject({ status: "accepted", applied_entry_id: newId, applied_version: 1 });
    expect(await entryRow(E.emp1A, newId)).toMatchObject({ date: "2026-09-03", start: "07:00", end: "12:00", source: "correction", version: 1 });
    const rev = (await db.admin.query("select operation, is_correction, changed_by from public.time_entry_revisions where entry_id = $1", [newId])).rows;
    expect(rev).toEqual([{ operation: "insert", is_correction: true, changed_by: U.managerA }]);

    const overlap = await create(U.emp1A, E.emp1A, "add", null, { date: "2026-09-03", start: "11:00", end: "13:00", pauseMinutes: 0 }, "Noch ein Einsatz an dem Tag");
    const e = await pgError(decide(U.managerA, overlap.id, "accepted", null, false));
    expect(e.code).toBe("23P01");
    const still = (await db.admin.query("select status from public.correction_requests where id = $1", [overlap.id])).rows[0];
    expect(still.status).toBe("open");
  });

  it("re-approval recalculates and stores the figures; the history shows approval, re-opening and re-approval", async () => {
    const st = (await db.admin.query("select id, worked_minutes from public.monthly_statements where employee_id = $1 and month = '2026-09'", [E.emp1A])).rows[0];
    const expected = (await db.admin.query("select * from private.statement_figures($1, '2026-09')", [E.emp1A])).rows[0];
    expect(expected.worked).not.toBe(st.worked_minutes);
    const ok = await db.as(U.managerA, async (q) => (await q.query("select * from public.approve_statement($1)", [st.id])).rows[0], { commit: true });
    expect(ok).toMatchObject({ status: "approved", worked_minutes: expected.worked, allocated_minutes: expected.allocated, billing_minutes: expected.billing });
    const ev = await db.as(U.emp1A, async (q) => (await q.query("select action, reason, worked_minutes from public.monthly_statement_events where statement_id = $1 order by created_at, id", [st.id])).rows);
    expect(ev.map((x) => x.action)).toEqual(["approve", "reopen", "approve"]);
    expect(ev[1].reason).toBe("Korrekturanfrage Fahrtenbuch");
    expect(ev[2].worked_minutes).toBe(expected.worked);
    // locked again for everybody
    const r = await create(U.emp1A, E.emp1A, "change", "demo-a03-20260901", { end: "15:15" }, "Noch eine Viertelstunde");
    const e = await pgError(decide(U.managerA, r.id, "accepted", null, false));
    expect(e.code).toBe("PT423");
  });

  it("an entry changed since the request cannot be accepted (PT409)", async () => {
    const r = await create(U.emp2A, E.emp2A, "change", "demo-a04-20261001", { note: "Schülertour" }, "Bemerkung fehlt noch");
    await db.as(U.emp2A, (q) => q.query("select public.update_time_entry($1, 'demo-a04-20261001', '{\"end\":\"12:30\"}', 1)", [E.emp2A]), { commit: true });
    const e = await pgError(decide(U.managerA, r.id, "accepted", null, false));
    expect(e.code).toBe("PT409");
  });

  it("four eyes: a manager does not decide an own request, the owner may", async () => {
    const r = await create(U.managerA, E.managerA, "change", "demo-a02-20261002", { note: "Disposition Spätdienst" }, "Bemerkung präzisiert");
    const e = await pgError(decide(U.managerA, r.id, "accepted", null, false));
    expect(e.code).toBe("42501");
    const ok = await decide(U.ownerA, r.id, "accepted");
    expect(ok.status).toBe("accepted");
  });

  it("withdraw: only the employee, only open requests", async () => {
    const r = await create(U.emp1A, E.emp1A, "change", "demo-a03-20261001", { pauseMinutes: 45 }, "Pause war länger");
    for (const user of [U.emp2A, U.managerA, U.ownerB]) {
      const e = await pgError(db.as(user, (q) => q.query("select public.withdraw_correction_request($1)", [r.id])));
      expect(e.code).toBe("42501");
    }
    const w = await db.as(U.emp1A, async (q) => (await q.query("select * from public.withdraw_correction_request($1)", [r.id])).rows[0], { commit: true });
    expect(w).toMatchObject({ status: "withdrawn", decided_by: U.emp1A });
    const e = await pgError(decide(U.managerA, r.id, "accepted", null, false));
    expect(e.code).toBe("55000");
    // after withdrawing, a new request for the same entry is possible
    const again = await create(U.emp1A, E.emp1A, "change", "demo-a03-20261001", { pauseMinutes: 45 }, "Pause war doch länger");
    expect(again.status).toBe("open");
  });

  it("decided requests are immutable even for trusted code", async () => {
    const id = (await db.admin.query("select id from public.correction_requests where status = 'accepted' limit 1")).rows[0].id;
    const e = await pgError(db.admin.query("update public.correction_requests set decision_note = 'nachträglich' where id = $1", [id]));
    expect(e.code).toBe("55000");
    const open = (await db.admin.query("select id from public.correction_requests where status = 'open' limit 1")).rows[0].id;
    const e2 = await pgError(db.admin.query("update public.correction_requests set reason = 'umgeschrieben' where id = $1", [open]));
    expect(e2.code).toBe("42501");
  });

  it("tenant B rows stay invisible to tenant A", async () => {
    const r = await create(U.empB, E.empB, "delete", "demo-b03-20261003", null, "Tour Süd fiel aus");
    expect(r.tenant_id).toBe(B);
    for (const user of [U.ownerA, U.managerA, U.emp1A]) {
      const n = await db.as(user, async (q) => (await q.query("select count(*)::int n from public.correction_requests where tenant_id = $1", [B])).rows[0].n);
      expect(n).toBe(0);
    }
    const e = await pgError(decide(U.ownerA, r.id, "accepted", null, false));
    expect(e.code).toBe("42501");
  });
});

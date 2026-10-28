import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db?.close();
});

const U = IDS.users;
const E = IDS.employees;

describe("monthly statements", () => {
  let octId = "";

  it("employee submits own month; figures are computed in the database", async () => {
    const s = await db.as(U.emp1A, async (q) =>
      (await q.query("select * from public.submit_statement($1, '2026-10')", [E.emp1A])).rows[0], { commit: true });
    // 07–15 (−30) = 450, 19–03 (−30) = 450 → 900 worked; 300 proposed allocation
    expect(s).toMatchObject({ status: "submitted", worked_minutes: 900, allocated_minutes: 300, billing_minutes: 600 });
    octId = s.id;
  });

  it("employee cannot submit a colleague's month or review statements", async () => {
    const e = await pgError(db.as(U.emp1A, (q) => q.query("select public.submit_statement($1, '2026-10')", [E.emp2A])));
    expect(e.code).toBe("42501");
    const e2 = await pgError(db.as(U.emp1A, (q) => q.query("select public.approve_statement($1)", [octId])));
    expect(e2.code).toBe("42501");
    const e3 = await pgError(db.as(U.emp1A, (q) => q.query("update public.monthly_statements set status = 'approved' where id = $1", [octId])));
    expect(e3.code).toBe("42501");
  });

  it("returning a statement requires a reason", async () => {
    for (const reason of [null, "", "  "]) {
      const e = await pgError(db.as(U.managerA, (q) => q.query("select public.return_statement($1, $2)", [octId, reason])));
      expect(e.code).toBe("22023");
    }
    // also enforced by the table itself
    const e = await pgError(db.admin.query("update public.monthly_statements set status = 'returned', review_note = null where id = $1", [octId]));
    expect(e.code).toBe("23514");
    const r = await db.as(U.managerA, async (q) =>
      (await q.query("select * from public.return_statement($1, 'Bitte Nachtdienst am 05.10. prüfen')", [octId])).rows[0]);
    expect(r).toMatchObject({ status: "returned", review_note: "Bitte Nachtdienst am 05.10. prüfen", reviewed_by: U.managerA });
  });

  it("approval waits for the proposed work-account allocation (tenant setting approvalRequired)", async () => {
    const e = await pgError(db.as(U.managerA, (q) => q.query("select public.approve_statement($1)", [octId])));
    expect(e.code).toBe("55000");
    await db.as(U.managerA, (q) => q.query("select public.review_allocation($1, '2026-10', 'approved')", [E.emp1A]), { commit: true });
    const s = await db.as(U.managerA, async (q) => (await q.query("select * from public.approve_statement($1)", [octId])).rows[0], { commit: true });
    expect(s).toMatchObject({ status: "approved", reviewed_by: U.managerA });
    const audit = await db.admin.query("select action from public.audit_log where entity_id = $1 order by created_at", [octId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["statement.submit", "statement.approve"]);
  });

  it("approved month locks entries and allocations of that employee", async () => {
    const e1 = await pgError(db.as(U.emp1A, (q) => q.query("select public.update_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', '{\"note\":\"x\"}', 1)")));
    expect(e1.code).toBe("PT423");
    const e2 = await pgError(db.as(U.emp1A, (q) => q.query("select public.delete_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', 1)")));
    expect(e2.code).toBe("PT423");
    const e3 = await pgError(db.as(U.emp1A, (q) => q.query(
      "select public.create_time_entry($1, $2)", [E.emp1A, { id: "t-locked-001", date: "2026-10-28", start: "08:00", end: "10:00" }])));
    expect(e3.code).toBe("PT423");
    const e4 = await pgError(db.as(U.managerA, (q) => q.query("select public.update_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', '{\"note\":\"x\"}', 1)")));
    expect(e4.code).toBe("PT423");
    const e5 = await pgError(db.as(U.emp1A, (q) => q.query("select public.set_allocation($1, '2026-10', 10)", [E.emp1A])));
    expect(["PT423", "42501"]).toContain(e5.code);
    // a colleague's same month is not locked
    const ok = await db.as(U.emp2A, async (q) => (await q.query("select * from public.update_time_entry('ae000000-0000-4000-8000-000000000004', 'demo-a04-20261001', '{\"note\":\"ok\"}', 1)")).rows[0]);
    expect(ok.version).toBe(2);
  });

  it("the correction flag cannot be abused by a request role", async () => {
    const e = await pgError(db.as(U.managerA, async (q) => {
      await q.query("select set_config('app.statement_correction', 'on', true)");
      return q.query("select public.update_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', '{\"note\":\"x\"}', 1)");
    }));
    expect(e.code).toBe("PT423");
  });

  it("approved month: no correction at all, not even by the leadership (decision 28.10.2026)", async () => {
    const e = await pgError(db.as(U.managerA, (q) => q.query("select public.correct_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', '{\"end\":\"15:30\"}', 1, 'Fahrtenbuch belegt 15:30')")));
    expect(e.code).toBe("PT423");
    const e2 = await pgError(db.as(U.ownerA, (q) => q.query("select public.correct_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', '{\"deleted\":true}', 1, 'Doppelt erfasst')")));
    expect(e2.code).toBe("PT423");
    // moving an entry of another month INTO the approved month is refused as well
    const e3 = await pgError(db.as(U.managerA, (q) => q.query("select public.correct_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20260901', '{\"date\":\"2026-10-27\"}', 1, 'Datum verschoben')")));
    expect(["PT423", "23P01"]).toContain(e3.code);
    // the old way (return an approved statement) is closed
    const e4 = await pgError(db.as(U.ownerA, (q) => q.query("select public.return_statement($1, 'nochmal öffnen')", [octId])));
    expect(e4.code).toBe("55000");
  });

  it("re-opening: leadership with a mandatory reason, audited; not for employees, not other tenants", async () => {
    for (const user of [U.emp1A, U.emp2A, U.ownerB, U.superAdmin, U.support]) {
      const e = await pgError(db.as(user, (q) => q.query("select public.reopen_statement($1, 'Nachtrag Urlaubstag')", [octId])));
      expect(e.code).toBe("42501");
    }
    for (const reason of [null, "", "  ", "kurz"]) {
      const e = await pgError(db.as(U.managerA, (q) => q.query("select public.reopen_statement($1, $2)", [octId, reason])));
      expect(e.code).toBe("22023");
    }
    const r = await db.as(U.managerA, async (q) => (await q.query("select * from public.reopen_statement($1, 'Nachtrag Urlaubstag')", [octId])).rows[0], { commit: true });
    expect(r).toMatchObject({ status: "reopened", review_note: "Nachtrag Urlaubstag", reopened_by: U.managerA });
    const again = await pgError(db.as(U.managerA, (q) => q.query("select public.reopen_statement($1, 'Nachtrag Urlaubstag')", [octId])));
    expect(again.code).toBe("55000");
    const audit = await db.admin.query("select action, reason from public.audit_log where entity_id = $1 and action = 'statement.reopen'", [octId]);
    expect(audit.rows).toEqual([{ action: "statement.reopen", reason: "Nachtrag Urlaubstag" }]);
    // the table enforces the reason too
    const e = await pgError(db.admin.query("update public.monthly_statements set review_note = null where id = $1", [octId]));
    expect(e.code).toBe("23514");
  });

  it("re-opened month: employee still locked; leadership corrects with reason (revision, audit) and adjusts the allocation", async () => {
    const e1 = await pgError(db.as(U.emp1A, (q) => q.query("select public.update_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', '{\"note\":\"x\"}', 1)")));
    expect(e1.code).toBe("PT423");
    const e2 = await pgError(db.as(U.emp1A, (q) => q.query("select public.set_allocation($1, '2026-10', 10)", [E.emp1A])));
    expect(["PT423", "42501"]).toContain(e2.code);
    const e = await pgError(db.as(U.managerA, (q) => q.query("select public.correct_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', '{\"end\":\"15:30\"}', 1, '')")));
    expect(e.code).toBe("22023");
    const r = await db.as(U.managerA, async (q) =>
      (await q.query("select * from public.correct_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', '{\"end\":\"15:30\"}', 1, 'Fahrtenbuch belegt 15:30')")).rows[0], { commit: true });
    expect(r).toMatchObject({ version: 2, source: "correction", duration_minutes: 510 });
    const rev = await db.admin.query("select is_correction, reason, changed_by from public.time_entry_revisions where entry_id = 'demo-a03-20261001' and version = 2");
    expect(rev.rows[0]).toEqual({ is_correction: true, reason: "Fahrtenbuch belegt 15:30", changed_by: U.managerA });
    const audit = await db.admin.query("select reason, actor_id from public.audit_log where action = 'time_entry.correction'");
    expect(audit.rows).toEqual([{ reason: "Fahrtenbuch belegt 15:30", actor_id: U.managerA }]);
    const e3 = await pgError(db.as(U.managerA, (q) => q.query("select public.correct_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261001', '{\"end\":\"20:00\"}', 2, 'zu lang test')")));
    expect(e3.code).toBe("23514");
    // work-account allocation of the re-opened month: the leadership may review it
    const alloc = await db.as(U.managerA, async (q) => (await q.query("select * from public.review_allocation($1, '2026-10', 'approved')", [E.emp1A])).rows[0]);
    expect(alloc.status).toBe("approved");
  });

  it("re-approval stores recalculated figures; employee sees the status and the history", async () => {
    const before = (await db.admin.query("select worked_minutes from public.monthly_statements where id = $1", [octId])).rows[0];
    const mine = await db.as(U.emp1A, async (q) => (await q.query("select status, review_note from public.monthly_statements where id = $1", [octId])).rows[0]);
    expect(mine).toEqual({ status: "reopened", review_note: "Nachtrag Urlaubstag" });
    const s = await db.as(U.managerA, async (q) => (await q.query("select * from public.approve_statement($1)", [octId])).rows[0], { commit: true });
    expect(s.status).toBe("approved");
    expect(s.worked_minutes).toBe(before.worked_minutes + 30); // end 15:00 → 15:30
    const ev = await db.as(U.emp1A, async (q) => (await q.query("select action from public.monthly_statement_events where statement_id = $1 order by created_at, id", [octId])).rows);
    expect(ev.map((x) => x.action).slice(-3)).toEqual(["approve", "reopen", "approve"]);
    for (const user of [U.emp2A, U.ownerB, U.superAdmin]) {
      const rows = await db.as(user, async (q) => (await q.query("select * from public.monthly_statement_events where statement_id = $1", [octId])).rows);
      expect(rows).toEqual([]);
    }
    // history is append-only
    const e = await pgError(db.admin.query("update public.monthly_statement_events set reason = 'x' where statement_id = $1", [octId]));
    expect(e.code).toBe("42501");
    const e2 = await pgError(db.admin.query("delete from public.monthly_statement_events where statement_id = $1", [octId]));
    expect(e2.code).toBe("42501");
    // finally: re-open, return to the employee, employee can change again
    await db.as(U.ownerA, (q) => q.query("select public.reopen_statement($1, 'Nachtrag Urlaubstag')", [octId]), { commit: true });
    const ret = await db.as(U.ownerA, async (q) => (await q.query("select * from public.return_statement($1, 'Bitte selbst ergänzen')", [octId])).rows[0], { commit: true });
    expect(ret.status).toBe("returned");
    const ok = await db.as(U.emp1A, async (q) => (await q.query("select * from public.update_time_entry('ae000000-0000-4000-8000-000000000003', 'demo-a03-20261005', '{\"note\":\"ok\"}', 1)")).rows[0]);
    expect(ok.version).toBe(2);
  });

  it("a manager cannot approve their own statement", async () => {
    const s = await db.as(U.managerA, async (q) => (await q.query("select * from public.submit_statement($1, '2026-10')", [E.managerA])).rows[0], { commit: true });
    const e = await pgError(db.as(U.managerA, (q) => q.query("select public.approve_statement($1)", [s.id])));
    expect(e.code).toBe("42501");
    const ok = await db.as(U.ownerA, async (q) => (await q.query("select * from public.approve_statement($1)", [s.id])).rows[0]);
    expect(ok.status).toBe("approved");
  });
});

describe("work-account allocations", () => {
  it("employee proposes; status forced to proposed; minutes >= 0", async () => {
    const r = await db.as(U.emp2A, async (q) => (await q.query(
      "insert into public.work_account_allocations (tenant_id, employee_id, month, minutes, status) values ($1, $2, '2026-11', 120, 'approved') returning status",
      [IDS.tenantA, E.emp2A])).rows[0]);
    expect(r.status).toBe("proposed");
    const e = await pgError(db.as(U.emp2A, (q) => q.query("select public.set_allocation($1, '2026-11', -5)", [E.emp2A])));
    expect(e.code).toBe("23514");
  });

  it("respects tenant start month and rejection needs a reason", async () => {
    const e = await pgError(db.as(U.emp2A, (q) => q.query("select public.set_allocation($1, '2026-08', 60)", [E.emp2A])));
    expect(e.code).toBe("23514");
    await db.as(U.emp2A, (q) => q.query("select public.set_allocation($1, '2026-11', 60)", [E.emp2A]), { commit: true });
    const e2 = await pgError(db.as(U.managerA, (q) => q.query("select public.review_allocation($1, '2026-11', 'rejected', '')", [E.emp2A])));
    expect(e2.code).toBe("22023");
    const r = await db.as(U.managerA, async (q) =>
      (await q.query("select * from public.review_allocation($1, '2026-11', 'rejected', 'Zu viele Stunden')", [E.emp2A])).rows[0]);
    expect(r).toMatchObject({ status: "rejected", reviewed_by: U.managerA, review_note: "Zu viele Stunden" });
  });
});

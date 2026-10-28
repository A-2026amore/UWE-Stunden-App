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

type Entry = { id: string; date: string; start: string; end: string; pauseMinutes?: number; note?: string };
const create = (user: string, employee: string, entry: Entry, commit = false) =>
  db.as(user, async (q) => (await q.query("select * from public.create_time_entry($1, $2)", [employee, entry])).rows[0], { commit });

describe("time entries: hard limits", () => {
  it("employee creates an entry via RPC (version 1, source app)", async () => {
    const row = await create(U.emp1A, E.emp1A, { id: "t-create-0001", date: "2026-10-12", start: "08:00", end: "16:00", pauseMinutes: 30, note: "Test" });
    expect(row).toMatchObject({ version: 1, source: "app", duration_minutes: 480, created_by: U.emp1A });
  });

  it("rejects an overlapping entry on the same day", async () => {
    // seed: 2026-10-01 07:00–15:00
    const e = await pgError(create(U.emp1A, E.emp1A, { id: "t-overlap-001", date: "2026-10-01", start: "14:00", end: "18:00" }));
    expect(e.code).toBe("23P01");
  });

  it("rejects an entry overlapping a night shift on the next day (midnight crossing)", async () => {
    // seed: 2026-10-05 19:00 – 2026-10-06 03:00
    const e = await pgError(create(U.emp1A, E.emp1A, { id: "t-overlap-002", date: "2026-10-06", start: "02:00", end: "06:00" }));
    expect(e.code).toBe("23P01");
    // directly adjacent is fine ([) ranges)
    const ok = await create(U.emp1A, E.emp1A, { id: "t-adjacent-1", date: "2026-10-06", start: "03:00", end: "06:00" });
    expect(ok.id).toBe("t-adjacent-1");
  });

  it("rejects a night shift that runs into an existing next-day entry", async () => {
    await create(U.emp1A, E.emp1A, { id: "t-morning-01", date: "2026-10-21", start: "05:00", end: "09:00" }, true);
    const e = await pgError(create(U.emp1A, E.emp1A, { id: "t-night-0001", date: "2026-10-20", start: "22:00", end: "06:00", pauseMinutes: 30 }));
    expect(e.code).toBe("23P01");
  });

  it("does not treat entries of different employees as overlap", async () => {
    // same slot as the manager's seed entry 2026-10-02 09:00–17:00
    const other = await create(U.emp2A, E.emp2A, { id: "t-other-0001", date: "2026-10-02", start: "09:00", end: "17:00", pauseMinutes: 30 });
    expect(other.employee_id).toBe(E.emp2A);
  });

  it("rejects shifts longer than 12 hours (also across midnight)", async () => {
    const e1 = await pgError(create(U.emp1A, E.emp1A, { id: "t-long-00001", date: "2026-10-13", start: "06:00", end: "18:01" }));
    expect(e1.code).toBe("23514");
    const e2 = await pgError(create(U.emp1A, E.emp1A, { id: "t-long-00002", date: "2026-10-13", start: "18:00", end: "06:30" }));
    expect(e2.code).toBe("23514");
    const ok = await create(U.emp1A, E.emp1A, { id: "t-12h-000001", date: "2026-10-13", start: "18:00", end: "06:00", pauseMinutes: 45 });
    expect(ok.duration_minutes).toBe(720);
  });

  it("applies the stricter tenant maximum (tenant B: 10 h)", async () => {
    const e = await pgError(create(U.empB, E.empB, { id: "t-b-long-001", date: "2026-10-13", start: "06:00", end: "17:00", pauseMinutes: 45 }));
    expect(e.code).toBe("23514");
    expect(e.message).toContain("600 Minuten");
  });

  it("rejects pause < 0, pause >= duration and start = end even when writing directly", async () => {
    for (const [pause, start, end] of [[-5, "08:00", "10:00"], [120, "08:00", "10:00"], [0, "08:00", "08:00"]] as const) {
      const e = await pgError(db.as(U.emp1A, (q) => q.query(
        "insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time, pause_minutes) values ('t-pause-0001', $1, $2, '2026-10-14', $3, $4, $5)",
        [IDS.tenantA, E.emp1A, start, end, pause])));
      expect(e.code, `${pause} ${start}-${end}`).toBe("23514");
    }
  });

  it("same client id twice for the same employee is idempotent (no duplicate, no error)", async () => {
    const entry = { id: "t-idem-00001", date: "2026-10-15", start: "08:00", end: "12:00" };
    await create(U.emp1A, E.emp1A, entry, true);
    const again = await create(U.emp1A, E.emp1A, { ...entry, note: "erneut gesendet" }, true);
    expect(again).toMatchObject({ id: entry.id, employee_id: E.emp1A, version: 1, note: "" });
    const n = await db.admin.query("select count(*)::int n from public.time_entries where id = $1", [entry.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("same client id for a different employee is a separate entry (legacy ids are not globally unique)", async () => {
    // migrated ids are derived from shift content only, so two employees can share one
    const legacy = { id: "legacy-1x2y3z", date: "2026-10-16", start: "08:00", end: "12:00" };
    const mine = await create(U.emp1A, E.emp1A, legacy, true);
    const theirs = await create(U.emp2A, E.emp2A, legacy, true);
    expect(mine.employee_id).toBe(E.emp1A);
    expect(theirs.employee_id).toBe(E.emp2A);
    const rows = await db.admin.query("select employee_id from public.time_entries where id = $1 order by employee_id", [legacy.id]);
    expect(rows.rows.map((r) => r.employee_id)).toEqual([E.emp1A, E.emp2A]);
    // the same id in another tenant does not collide either
    const other = await create(U.empB, E.empB, legacy);
    expect(other.tenant_id).toBe(IDS.tenantB);
    // and updating one does not touch the other
    const upd = await db.as(U.emp1A, async (q) =>
      (await q.query("select * from public.update_time_entry($1, $2, $3, 1)", [E.emp1A, legacy.id, { note: "nur meins" }])).rows[0]);
    expect(upd.note).toBe("nur meins");
    const e = await pgError(db.as(U.emp1A, (q) => q.query("select public.update_time_entry($1, $2, $3, 1)", [E.emp2A, legacy.id, { note: "fremd" }])));
    expect(e.code).toBe("42501");
  });

  it("rejects malformed client ids", async () => {
    for (const id of ["abc", "x".repeat(101), "id with space", "id;drop"]) {
      const e = await pgError(create(U.emp1A, E.emp1A, { id, date: "2026-10-17", start: "08:00", end: "09:00" }));
      expect(e.code, id).toBe("23514");
    }
  });
});

describe("time entries: concurrency, soft delete, history", () => {
  const id = "t-version-01";
  beforeAll(async () => {
    await create(U.emp1A, E.emp1A, { id, date: "2026-10-19", start: "08:00", end: "12:00" }, true);
  });

  it("update increments version; stale version is rejected", async () => {
    const r = await db.as(U.emp1A, async (q) =>
      (await q.query("select * from public.update_time_entry($3, $1, $2, 1)", [id, { end: "13:00", note: "länger" }, E.emp1A])).rows[0], { commit: true });
    expect(r).toMatchObject({ version: 2, duration_minutes: 300, note: "länger" });
    const e = await pgError(db.as(U.emp1A, (q) => q.query("select * from public.update_time_entry($3, $1, $2, 1)", [id, { note: "alt" }, E.emp1A])));
    expect(e.code).toBe("PT409");
  });

  it("direct UPDATE with a stale version is rejected as well; id/tenant/employee are immutable", async () => {
    const e = await pgError(db.as(U.emp1A, (q) => q.query("update public.time_entries set note = 'x', version = 1 where id = $1", [id])));
    expect(e.code).toBe("PT409");
    const e2 = await pgError(db.as(U.managerA, (q) => q.query("update public.time_entries set employee_id = $2 where id = $1", [id, E.emp2A])));
    expect(e2.code).toBe("42501");
  });

  it("unknown patch fields are rejected", async () => {
    const e = await pgError(db.as(U.emp1A, (q) => q.query("select public.update_time_entry($3, $1, $2, 2)", [id, { employeeId: E.emp2A }, E.emp1A])));
    expect(e.code).toBe("22023");
  });

  it("hard DELETE is impossible; soft delete keeps row and history", async () => {
    const e = await pgError(db.as(U.emp1A, (q) => q.query("delete from public.time_entries where id = $1", [id])));
    expect(e.code).toBe("42501");
    const del = await db.as(U.emp1A, async (q) =>
      (await q.query("select * from public.delete_time_entry($2, $1, 2, 'doppelt erfasst')", [id, E.emp1A])).rows[0], { commit: true });
    expect(del.deleted_at).not.toBeNull();
    expect(del.deleted_by).toBe(U.emp1A);
    const row = await db.admin.query("select version, deleted_at is not null as deleted from public.time_entries where id = $1", [id]);
    expect(row.rows[0]).toEqual({ version: 3, deleted: true });
    const revs = await db.as(U.emp1A, async (q) =>
      (await q.query("select version, operation, reason, changed_by from public.time_entry_revisions where entry_id = $1 order by version", [id])).rows);
    expect(revs).toEqual([
      { version: 1, operation: "insert", reason: null, changed_by: U.emp1A },
      { version: 2, operation: "update", reason: null, changed_by: U.emp1A },
      { version: 3, operation: "delete", reason: "doppelt erfasst", changed_by: U.emp1A },
    ]);
    // deleted entries no longer block the time slot
    const again = await create(U.emp1A, E.emp1A, { id: "t-replace-01", date: "2026-10-19", start: "08:00", end: "12:00" });
    expect(again.version).toBe(1);
    // and cannot be edited any more
    const e2 = await pgError(db.as(U.emp1A, (q) => q.query("select public.update_time_entry($3, $1, $2, 3)", [id, { note: "x" }, E.emp1A])));
    expect(e2.code).toBe("PT409");
  });

  it("revisions are immutable", async () => {
    const e = await pgError(db.admin.query("update public.time_entry_revisions set reason = 'x' where entry_id = $1", [id]));
    expect(e.code).toBe("42501");
    const e2 = await pgError(db.as(U.managerA, (q) => q.query("delete from public.time_entry_revisions where entry_id = $1", [id])));
    expect(e2.code).toBe("42501");
  });

  it("suspended tenant: no more time writes", async () => {
    await db.admin.query("update public.tenants set status = 'suspended' where id = $1", [IDS.tenantB]);
    const e = await pgError(create(U.empB, E.empB, { id: "t-susp-00001", date: "2026-10-20", start: "08:00", end: "10:00" }));
    expect(e.code).toBe("42501");
    await db.admin.query("update public.tenants set status = 'active' where id = $1", [IDS.tenantB]);
  });
});

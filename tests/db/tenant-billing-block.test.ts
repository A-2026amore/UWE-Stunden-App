/**
 * Blocked customers (migration 0018): tenant status history and "not billed from the
 * month after the block" with month boundaries in Europe/Berlin.
 * Tenant B (standard price) is moved back to June 2026; its status history is rewritten per case.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
const A = IDS.tenantA;
const B = IDS.tenantB;
const U = IDS.users;

beforeAll(async () => {
  db = await setupTestDb();
  await db.admin.query("update public.tenants set created_at = '2026-06-01 00:00 Europe/Berlin' where id = $1", [B]);
  await db.admin.query("update public.employee_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [B]);
});
afterAll(async () => {
  await db?.close();
});

type P = [status: string, from: string, to: string | null, reason?: string];

async function history(periods: P[]) {
  await db.admin.query("delete from public.tenant_status_history where tenant_id = $1", [B]);
  for (const [status, from, to, reason] of periods) {
    await db.admin.query("insert into public.tenant_status_history (tenant_id, status, valid_from, valid_to, reason) values ($1, $2, $3, $4, $5)",
      [B, status, from, to, reason ?? null]);
  }
}
const cond = async (month: string) =>
  (await db.admin.query("select unit_price_cents, condition from private.billing_condition($1, $2)", [B, month])).rows[0];
const overview = async (month: string) =>
  db.as(U.superAdmin, async (q) => (await q.query("select * from public.platform_billing_overview($1) where tenant_id = $2", [month, B])).rows[0]);

describe("tenant status history", () => {
  it("is written by set_tenant_status with reason and actor; visible to leadership and platform staff only", async () => {
    await db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status($1, 'suspended', 'Offene Rechnung')", [B]), { commit: true });
    await db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status($1, 'active', 'Zahlung eingegangen')", [B]), { commit: true });
    const rows = (await db.admin.query("select status, reason, changed_by, valid_to is null as open from public.tenant_status_history where tenant_id = $1 order by valid_from", [B])).rows;
    expect(rows.slice(-2)).toEqual([
      { status: "suspended", reason: "Offene Rechnung", changed_by: U.superAdmin, open: false },
      { status: "active", reason: "Zahlung eingegangen", changed_by: U.superAdmin, open: true },
    ]);
    const own = await db.as(U.ownerB, async (q) => (await q.query("select tenant_id from public.tenant_status_history")).rows);
    expect(new Set(own.map((r) => r.tenant_id))).toEqual(new Set([B]));
    for (const user of [U.empB, U.emp1A]) {
      const r = await db.as(user, async (q) => (await q.query("select * from public.tenant_status_history where tenant_id = $1", [B])).rows);
      expect(r).toEqual([]);
    }
    const all = await db.as(U.support, async (q) => (await q.query("select distinct tenant_id from public.tenant_status_history")).rows);
    expect(all.map((r) => r.tenant_id).sort()).toEqual([A, B].sort());
    const e = await pgError(db.as(U.superAdmin, (q) => q.query("update public.tenant_status_history set reason = 'x'")));
    expect(e.code).toBe("42501");
  });
});

describe("billing of blocked tenants", () => {
  it("block on the 10th: that month is billed, the following month is 0 € (suspended)", async () => {
    await history([["active", "2026-06-01 00:00 Europe/Berlin", "2026-08-10 09:00 Europe/Berlin"],
                   ["suspended", "2026-08-10 09:00 Europe/Berlin", null, "Offene Rechnung"]]);
    expect(await cond("2026-08")).toEqual({ unit_price_cents: 500, condition: "standard" });
    expect(await cond("2026-09")).toEqual({ unit_price_cents: 0, condition: "tenant_suspended" });
    const sep = await overview("2026-09");
    expect(sep).toMatchObject({ condition: "tenant_suspended", unit_price_cents: 0, amount_cents: 0, block_reason: "Offene Rechnung" });
    expect(sep.billable_count).toBe(1); // persons still counted for information
    expect(new Date(sep.block_since).toISOString()).toBe(new Date("2026-08-10T07:00:00Z").toISOString());
    expect((await overview("2026-08")).block_since).toBeNull();
  });

  it("month boundaries in Europe/Berlin: 30.09. 23:30 → October free; 01.10. 00:30 → October still billed", async () => {
    await history([["active", "2026-06-01 00:00 Europe/Berlin", "2026-09-30 23:30 Europe/Berlin"],
                   ["deactivated", "2026-09-30 23:30 Europe/Berlin", null]]);
    expect((await cond("2026-09")).condition).toBe("standard");
    expect(await cond("2026-10")).toEqual({ unit_price_cents: 0, condition: "tenant_deactivated" });
    await history([["active", "2026-06-01 00:00 Europe/Berlin", "2026-10-01 00:30 Europe/Berlin"],
                   ["deactivated", "2026-10-01 00:30 Europe/Berlin", null]]);
    expect((await cond("2026-10")).condition).toBe("standard");
  });

  it("re-activation during a month makes that month billable again; pending is billed as before", async () => {
    await history([["active", "2026-06-01 00:00 Europe/Berlin", "2026-07-03 12:00 Europe/Berlin"],
                   ["suspended", "2026-07-03 12:00 Europe/Berlin", "2026-09-15 12:00 Europe/Berlin"],
                   ["active", "2026-09-15 12:00 Europe/Berlin", null]]);
    expect((await cond("2026-07")).condition).toBe("standard");
    expect((await cond("2026-08")).condition).toBe("tenant_suspended");
    expect((await cond("2026-09")).condition).toBe("standard");
    await history([["pending", "2026-06-01 00:00 Europe/Berlin", null]]);
    expect((await cond("2026-08")).condition).toBe("standard");
  });

  it("the customer sees the block (status and date, no reason); frozen months keep the condition", async () => {
    await history([["active", "2026-06-01 00:00 Europe/Berlin", "2026-07-20 10:00 Europe/Berlin"],
                   ["suspended", "2026-07-20 10:00 Europe/Berlin", "2026-10-02 10:00 Europe/Berlin", "Interner Grund"],
                   ["active", "2026-10-02 10:00 Europe/Berlin", null]]);
    const b = await db.as(U.ownerB, async (q) => (await q.query("select public.tenant_billing($1, '2026-08') as b", [B])).rows[0].b);
    expect(b).toMatchObject({ condition: "tenant_suspended", amountCents: 0, unitPriceCents: 0, tenantBlock: { status: "suspended" } });
    expect(JSON.stringify(b)).not.toContain("Interner Grund");
    const oct = await db.as(U.ownerB, async (q) => (await q.query("select public.tenant_billing($1, '2026-10') as b", [B])).rows[0].b);
    expect(oct.tenantBlock).toBeNull();
    const p = await db.as(U.superAdmin, async (q) => (await q.query("select * from public.platform_set_billing_status($1, '2026-08', 'invoiced')", [B])).rows[0], { commit: true });
    expect(p).toMatchObject({ condition: "tenant_suspended", amount_cents: 0 });
  });
});

/**
 * Migration 0031: the demo/test flag of a tenant ("TESTDATEN" on every PDF) can be switched
 * afterwards – only by a super admin, with a reason, audited.
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
const U = IDS.users;

const isDemo = async (id: string) =>
  (await db.admin.query("select is_demo v from public.tenants where id = $1", [id])).rows[0].v as boolean;

describe("tenant demo flag (0031)", () => {
  it("only super_admin switches it, with a reason; the change is audited", async () => {
    expect(await isDemo(A)).toBe(true);
    const call = (user: string, demo: boolean, reason: string) =>
      db.as(user, (q) => q.query("select * from public.platform_set_demo($1, $2, $3)", [A, demo, reason]));
    expect((await pgError(call(U.support, false, "Echte Firma"))).code).toBe("42501");
    expect((await pgError(call(U.ownerA, false, "Echte Firma"))).code).toBe("42501");
    expect((await pgError(call(U.superAdmin, false, ""))).code).toBe("22023");

    const row = await db.as(U.superAdmin, async (q) =>
      (await q.query("select * from public.platform_set_demo($1, false, 'Echte Firma')", [A])).rows[0], { commit: true });
    try {
      expect(row.is_demo).toBe(false);
      const audit = await db.admin.query(
        "select reason, (before->>'is_demo')::boolean b, (after->>'is_demo')::boolean a from public.audit_log where entity = 'tenant' and entity_id = $1 order by created_at desc limit 1", [A]);
      expect(audit.rows[0]).toEqual({ reason: "Echte Firma", b: true, a: false });
    } finally {
      await db.as(U.superAdmin, (q) => q.query("select public.platform_set_demo($1, true, 'Zurückgesetzt (Test)')", [A]), { commit: true });
    }
    expect(await isDemo(A)).toBe(true);
  });

  it("the owner still cannot switch it with a direct update (guard trigger)", async () => {
    const r = await db.as(U.ownerA, async (q) => (await q.query("update public.tenants set is_demo = false where id = $1", [A])).rowCount)
      .catch((e: { code?: string }) => e.code);
    expect([0, "42501"]).toContain(r);
    expect(await isDemo(A)).toBe(true);
  });
});

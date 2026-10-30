/**
 * Migration 0024: tenants.legacy_import_enabled – the import from the old UWE app is offered
 * only where the platform switched it on; only super admins change it (with reason, audited).
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

const enabled = async (id: string) =>
  (await db.admin.query("select legacy_import_enabled v from public.tenants where id = $1", [id])).rows[0].v as boolean;

describe("legacy import setting (0024)", () => {
  it("is off by default (demo seed tenants)", async () => {
    expect(await enabled(A)).toBe(false);
  });

  it("only super_admin switches it, with a reason; the change is audited", async () => {
    const call = (user: string, on: boolean, reason: string) =>
      db.as(user, (q) => q.query("select * from public.platform_set_legacy_import($1, $2, $3)", [A, on, reason]));
    expect((await pgError(call(U.support, true, "Alte App genutzt"))).code).toBe("42501");
    expect((await pgError(call(U.ownerA, true, "Alte App genutzt"))).code).toBe("42501");
    expect((await pgError(call(U.superAdmin, true, ""))).code).toBe("22023");

    const row = await db.as(U.superAdmin, async (q) =>
      (await q.query("select * from public.platform_set_legacy_import($1, true, 'Alte App genutzt')", [A])).rows[0], { commit: true });
    try {
      expect(row.legacy_import_enabled).toBe(true);
      const audit = await db.admin.query(
        "select reason, (before->>'legacy_import_enabled')::boolean b, (after->>'legacy_import_enabled')::boolean a from public.audit_log where entity = 'tenant' and entity_id = $1 order by created_at desc limit 1", [A]);
      expect(audit.rows[0]).toEqual({ reason: "Alte App genutzt", b: false, a: true });
      // Employees of the tenant can read the flag (it decides what the app shows).
      const seen = await db.as(U.emp1A, async (q) => (await q.query("select legacy_import_enabled v from public.tenants where id = $1", [A])).rows[0]?.v);
      expect(seen).toBe(true);
    } finally {
      await db.as(U.superAdmin, (q) => q.query("select public.platform_set_legacy_import($1, false, 'Zurückgesetzt (Test)')", [A]), { commit: true });
    }
    expect(await enabled(A)).toBe(false);
  });

  it("the owner cannot switch it with a direct update (guard trigger)", async () => {
    const r = await db.as(U.ownerA, async (q) => (await q.query("update public.tenants set legacy_import_enabled = true where id = $1", [A])).rowCount)
      .catch((e: { code?: string }) => e.code);
    expect([0, "42501"]).toContain(r);
    expect(await enabled(A)).toBe(false);
  });
});

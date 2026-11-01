/** Tests for db/migrations/0009_two_factor.sql: access, constraints, requirement, audit. */
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
const E = IDS.employees;

const TABLES = ["auth.totp_factors", "auth.totp_recovery_codes", "auth.two_factor_challenges"];
/** Well-formed ciphertext (the DB only checks the format, it never sees a key). */
const CT = `v1.0123abcd.${"A".repeat(16)}.${"B".repeat(22)}.${"C".repeat(27)}`;
const HASH = (n: number) => n.toString(16).padStart(64, "0");

async function enrol(userId: string, codes = 2): Promise<void> {
  await db.as(null, async (q) => {
    await q.query("insert into auth.totp_factors (user_id, secret_ciphertext) values ($1, $2)", [userId, CT]);
    await q.query("update auth.totp_factors set enrolled_at = now(), last_used_step = 100 where user_id = $1", [userId]);
    // One statement, as the API does it (one "recovery_codes_created" event per statement and user).
    if (codes) await q.query("insert into auth.totp_recovery_codes (user_id, code_hash) select $1, h from unnest($2::text[]) h", [userId, Array.from({ length: codes }, (_, i) => HASH(i + 1))]);
  }, { role: "app_auth", commit: true });
}

async function audit(userId: string): Promise<Array<{ action: string; tenant_id: string | null; actor_id: string | null }>> {
  return (await db.admin.query("select action, tenant_id, actor_id from public.audit_log where entity = 'user' and entity_id = $1 order by created_at, action, tenant_id", [userId])).rows;
}

describe("access to the 2FA tables", () => {
  it("app_user and app_anon cannot read or write them at all", async () => {
    for (const role of ["app_user", "app_anon"] as const) {
      const user = role === "app_user" ? U.emp1A : null;
      for (const t of TABLES) {
        expect((await pgError(db.as(user, (q) => q.query(`select * from ${t}`), { role }))).code, `${role} select ${t}`).toBe("42501");
        expect((await pgError(db.as(user, (q) => q.query(`delete from ${t}`), { role }))).code, `${role} delete ${t}`).toBe("42501");
      }
      expect((await pgError(db.as(user, (q) => q.query("insert into auth.totp_factors (user_id, secret_ciphertext) values ($1, $2)", [U.emp1A, CT]), { role }))).code).toBe("42501");
      expect((await pgError(db.as(user, (q) => q.query("select auth.two_factor_requirement($1)", [U.emp1A]), { role }))).code).toBe("42501");
      expect((await pgError(db.as(user, (q) => q.query("select * from auth.two_factor_state($1)", [U.emp1A]), { role }))).code).toBe("42501");
      expect((await pgError(db.as(user, (q) => q.query("select private.audit_two_factor($1, 'two_factor.enabled', null)", [U.emp1A]), { role }))).code).toBe("42501");
    }
  });

  it("app_auth can use them (and RLS is enabled)", async () => {
    await db.as(null, async (q) => {
      await q.query("insert into auth.totp_factors (user_id, secret_ciphertext) values ($1, $2)", [U.emp2A, CT]);
      await q.query("insert into auth.two_factor_challenges (user_id, token_hash, expires_at) values ($1, $2, now() + interval '5 minutes')", [U.emp2A, HASH(9)]);
      expect((await q.query("select count(*)::int n from auth.totp_factors")).rows[0].n).toBe(1);
      expect((await q.query("select * from auth.two_factor_state($1)", [U.emp2A])).rows[0]).toEqual({ enrolled: false, required_by: null });
      await q.query("delete from auth.two_factor_challenges where user_id = $1", [U.emp2A]);
      await q.query("delete from auth.totp_factors where user_id = $1", [U.emp2A]);
    }, { role: "app_auth" });
    const rls = (await db.admin.query(
      "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth' and c.relname in ('totp_factors', 'totp_recovery_codes', 'two_factor_challenges') order by 1")).rows;
    expect(rls).toEqual([
      { relname: "totp_factors", relrowsecurity: true },
      { relname: "totp_recovery_codes", relrowsecurity: true },
      { relname: "two_factor_challenges", relrowsecurity: true },
    ]);
  });
});

describe("constraints", () => {
  it("accepts only the ciphertext format – never a plain base32 secret", async () => {
    for (const bad of ["JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", "v1.zzzzzzzz.a.b.c", `v2.${CT.slice(3)}`]) {
      const e = await pgError(db.as(null, (q) => q.query("insert into auth.totp_factors (user_id, secret_ciphertext) values ($1, $2)", [U.emp1A, bad]), { role: "app_auth" }));
      expect(e.code, bad).toBe("23514");
    }
  });

  it("challenges live at most 10 minutes; recovery codes are hashes", async () => {
    const e1 = await pgError(db.as(null, (q) => q.query(
      "insert into auth.two_factor_challenges (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')", [U.emp1A, HASH(1)]), { role: "app_auth" }));
    expect(e1.code).toBe("23514");
    const e2 = await pgError(db.as(null, async (q) => {
      await q.query("insert into auth.totp_factors (user_id, secret_ciphertext) values ($1, $2)", [U.emp1A, CT]);
      await q.query("insert into auth.totp_recovery_codes (user_id, code_hash) values ($1, 'ABCD-EFGH-JKMN-PQRS')", [U.emp1A]);
    }, { role: "app_auth" }));
    expect(e2.code).toBe("23514");
  });

  it("the accepted time step never goes backwards once enrolled (replay protection)", async () => {
    await enrol(U.emp1A, 0);
    const e = await pgError(db.as(null, (q) => q.query("update auth.totp_factors set last_used_step = 99 where user_id = $1", [U.emp1A]), { role: "app_auth" }));
    expect(e.code).toBe("22023");
    await db.as(null, (q) => q.query("update auth.totp_factors set last_used_step = 101 where user_id = $1", [U.emp1A]), { role: "app_auth" });
    await db.admin.query("delete from auth.totp_factors where user_id = $1", [U.emp1A]);
  });
});

describe("requirement", () => {
  const req = (user: string) => db.as(null, async (q) => (await q.query("select auth.two_factor_requirement($1) as r", [user])).rows[0].r, { role: "app_auth" });

  it("platform staff always, managers/owners only when their active tenant requires it", async () => {
    expect(await req(U.superAdmin)).toBe("platform");
    expect(await req(U.support)).toBe("platform");
    for (const u of [U.ownerA, U.managerA, U.emp1A, U.ownerB]) expect(await req(u), u).toBeNull();
    await db.admin.query("update public.tenants set require_two_factor_for_managers = true where id = $1", [A]);
    try {
      expect(await req(U.ownerA)).toBe("tenant");
      expect(await req(U.managerA)).toBe("tenant");
      expect(await req(U.emp1A)).toBeNull();
      expect(await req(U.ownerB)).toBeNull();
      await db.admin.query("update public.employees set status = 'deactivated' where id = $1", [E.managerA]);
      expect(await req(U.managerA)).toBeNull();
      await db.admin.query("update public.employees set status = 'active' where id = $1", [E.managerA]);
      await db.admin.query("update public.tenants set status = 'suspended' where id = $1", [A]);
      expect(await req(U.ownerA)).toBeNull();
    } finally {
      await db.admin.query("update public.tenants set status = 'active', require_two_factor_for_managers = false where id = $1", [A]);
    }
  });

  it("only the owner changes the tenant setting (not managers, not platform staff)", async () => {
    const m = await db.as(U.managerA, (q) => q.query("update public.tenants set require_two_factor_for_managers = true where id = $1", [A]));
    expect(m.rowCount).toBe(0);
    // Since 0011 platform staff cannot update tenant rows at all (RLS tenants_update: owner only).
    const e = await db.as(U.superAdmin, (q) => q.query("update public.tenants set require_two_factor_for_managers = true where id = $1", [A]));
    expect(e.rowCount).toBe(0);
    const o = await db.as(U.ownerA, (q) => q.query("update public.tenants set require_two_factor_for_managers = true where id = $1 returning require_two_factor_for_managers as r", [A]));
    expect(o.rows[0].r).toBe(true);
    // Nor other tenant fields (QA 2026-10-28, B3).
    const s = await db.as(U.superAdmin, (q) => q.query("update public.tenants set name = name || ' ' where id = $1", [A]));
    expect(s.rowCount).toBe(0);
  });
});

describe("audit events", () => {
  it("enable, recovery code use, new codes and disable are logged per tenant (append-only)", async () => {
    await enrol(U.managerA, 3);
    await db.as(null, (q) => q.query(
      "update auth.totp_recovery_codes set used_at = now() where user_id = $1 and code_hash = $2", [U.managerA, HASH(2)]), { role: "app_auth", commit: true });
    await db.as(null, (q) => q.query("delete from auth.totp_factors where user_id = $1", [U.managerA]), { role: "app_auth", commit: true });
    expect((await db.admin.query("select count(*)::int n from auth.totp_recovery_codes where user_id = $1", [U.managerA])).rows[0].n).toBe(0);

    const rows = await audit(U.managerA);
    expect(rows.map((r) => r.action)).toEqual([
      "two_factor.enabled", "two_factor.recovery_codes_created", "two_factor.recovery_code_used", "two_factor.disabled",
    ]);
    for (const r of rows) expect(r).toMatchObject({ tenant_id: A, actor_id: U.managerA });
    const used = (await db.admin.query("select after from public.audit_log where entity_id = $1 and action = 'two_factor.recovery_code_used'", [U.managerA])).rows[0];
    expect(used.after).toEqual({ remaining: 2 });

    // Managers of tenant A see the events; tenant B and employees do not.
    const seen = (u: string) => db.as(u, async (q) => (await q.query("select count(*)::int n from public.audit_log where entity = 'user' and entity_id = $1", [U.managerA])).rows[0].n);
    expect(await seen(U.ownerA)).toBe(4);
    expect(await seen(U.ownerB)).toBe(0);
    expect(await seen(U.emp1A)).toBe(0);
    // The request roles cannot forge such events, and nobody can delete them.
    expect((await pgError(db.as(U.ownerA, (q) => q.query(
      "insert into public.audit_log (tenant_id, action, entity, entity_id) values ($1, 'two_factor.disabled', 'user', $2)", [A, U.ownerA])))).code).toBe("42501");
    expect((await pgError(db.admin.query("delete from public.audit_log where entity = 'user'"))).code).not.toBe("");
  });

  it("platform staff events have no tenant", async () => {
    await enrol(U.support, 1);
    const rows = await audit(U.support);
    expect(rows.map((r) => [r.action, r.tenant_id])).toEqual([
      ["two_factor.enabled", null], ["two_factor.recovery_codes_created", null],
    ]);
    await db.admin.query("delete from auth.totp_factors where user_id = $1", [U.support]);
  });
});

/** Tests for db/migrations/0008_hardening.sql (findings of the API review). */
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

const TENANT_TABLES = ["tenants", "licenses", "employees", "support_access_grants", "invitations", "time_entries",
  "time_entry_revisions", "work_account_allocations", "monthly_statements", "employment_contracts", "audit_log"];

async function visibleRows(user: string, tenant: string): Promise<Record<string, number>> {
  return db.as(user, async (q) => {
    const out: Record<string, number> = {};
    for (const t of TENANT_TABLES) {
      const col = t === "tenants" ? "id" : "tenant_id";
      out[t] = (await q.query(`select count(*)::int n from public.${t} where ${col} = $1`, [tenant])).rows[0].n;
    }
    return out;
  });
}

describe("(1) inactive tenants: members lose all access", () => {
  for (const status of ["suspended", "pending"] as const) {
    it(`${status}: no reads for employee, manager or owner; platform still sees metadata`, async () => {
      await db.admin.query("update public.tenants set status = $2 where id = $1", [A, status]);
      try {
        for (const user of [U.emp1A, U.managerA, U.ownerA]) {
          const counts = await visibleRows(user, A);
          expect(counts, user).toEqual(Object.fromEntries(TENANT_TABLES.map((t) => [t, 0])));
        }
        await db.as(U.superAdmin, async (q) => {
          expect((await q.query("select status from public.tenants where id = $1", [A])).rows).toEqual([{ status }]);
          expect((await q.query("select count(*)::int n from public.licenses where tenant_id = $1", [A])).rows[0].n).toBe(1);
          expect((await q.query("select count(*)::int n from public.time_entries where tenant_id = $1", [A])).rows[0].n).toBe(0);
        });
        // the other tenant is unaffected
        expect((await visibleRows(U.empB, B)).time_entries).toBeGreaterThan(0);
      } finally {
        await db.admin.query("update public.tenants set status = 'active' where id = $1", [A]);
      }
    });
  }

  it("suspended: no writes – direct, via RPC, own profile, statements, owner settings", async () => {
    await db.admin.query("update public.tenants set status = 'suspended' where id = $1", [A]);
    try {
      const e1 = await pgError(db.as(U.emp1A, (q) => q.query(
        "select public.create_time_entry($1, $2)", [E.emp1A, { id: "susp-entry-1", date: "2026-10-20", start: "08:00", end: "10:00" }])));
      expect(e1.code).toBe("42501");
      const e2 = await pgError(db.as(U.emp1A, (q) => q.query(
        "insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time) values ('susp-entry-2', $1, $2, '2026-10-20', '08:00', '10:00')", [A, E.emp1A])));
      expect(e2.code).toBe("42501");
      const e3 = await pgError(db.as(U.emp1A, (q) => q.query("select public.update_time_entry($1, 'demo-a03-20261001', '{\"note\":\"x\"}', 1)", [E.emp1A])));
      expect(e3.code).toBe("42501");
      const e4 = await pgError(db.as(U.emp1A, (q) => q.query("select public.submit_statement($1, '2026-10')", [E.emp1A])));
      expect(e4.code).toBe("42501");
      const e5 = await pgError(db.as(U.managerA, (q) => q.query("select public.correct_time_entry($1, 'demo-a03-20261001', '{\"note\":\"x\"}', 1, 'Korrektur Test')", [E.emp1A])));
      expect(e5.code).toBe("42501");
      for (const [user, sql] of [
        [U.emp1A, "update public.employees set display_name = 'x' where id = '" + E.emp1A + "'"],
        [U.ownerA, "update public.tenants set name = 'Gesperrt GmbH' where id = '" + A + "'"],
        [U.managerA, "update public.employees set display_name = 'x' where id = '" + E.emp2A + "'"],
      ] as const) {
        const n = await db.as(user, async (q) => (await q.query(sql)).rowCount);
        expect(n, sql).toBe(0);
      }
      const e6 = await pgError(db.as(U.managerA, (q) => q.query(
        "insert into public.employees (tenant_id, personnel_number, display_name) values ($1, 'A-500', 'Neu')", [A])));
      expect(e6.code).toBe("42501");
    } finally {
      await db.admin.query("update public.tenants set status = 'active' where id = $1", [A]);
    }
  });

  it("session context still lists the membership with tenantStatus (API shows 'gesperrt')", async () => {
    await db.admin.query("update public.tenants set status = 'suspended' where id = $1", [A]);
    try {
      const ctx = await db.as(U.emp1A, async (q) => (await q.query("select public.current_session_context() c")).rows[0].c);
      expect(ctx.memberships).toEqual([{ tenantId: A, employeeId: E.emp1A, role: "employee", tenantName: "Demo Krankentransporte", tenantStatus: "suspended" }]);
      const anon = await db.as(null, async (q) => (await q.query("select public.current_session_context() c")).rows[0].c);
      expect(anon.memberships).toEqual([]);
    } finally {
      await db.admin.query("update public.tenants set status = 'active' where id = $1", [A]);
    }
    // back to normal after reactivation
    expect((await visibleRows(U.emp1A, A)).time_entries).toBeGreaterThan(0);
  });
});

describe("(2) branding images", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const svg = "data:image/svg+xml;base64," + Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64");
  const setLogo = (url: string) => db.admin.query("update public.tenants set branding = jsonb_set(branding, '{logoUrl}', to_jsonb($2::text)) where id = $1", [A, url]);

  it("rejects SVG data URLs and unsafe URLs", async () => {
    for (const bad of [svg, "data:image/svg+xml;utf8,<svg/>", "data:image/gif;base64,R0lGOD==", "javascript:alert(1)",
      "http://example.com/logo.png", "//evil.example/logo.png", "/brands/../secret", "https://x.example/a\"onerror=1"]) {
      const e = await pgError(setLogo(bad));
      expect(e.code, bad).toBe("23514");
    }
  });

  it("accepts PNG/JPEG/WebP data URLs, https URLs and site-relative paths", async () => {
    for (const ok of [png, "data:image/jpeg;base64,/9j/4AAQ", "data:image/webp;base64,UklGRg==", "https://cdn.example/logo.png", "/brands/demo/logo.svg"]) {
      await setLogo(ok);
    }
    const e = await pgError(db.as(U.ownerA, (q) => q.query(
      "update public.tenants set branding = jsonb_set(branding, '{markUrl}', to_jsonb($2::text)) where id = $1", [A, svg])));
    expect(e.code).toBe("23514");
  });
});

describe("(3) invitation for an e-mail that already has an account", () => {
  it("raises a clear error when a password is typed; links without password change otherwise", async () => {
    // employee in tenant B with the e-mail of an existing account (owner of A)
    const emp = (await db.admin.query(
      "insert into public.employees (tenant_id, personnel_number, display_name, email) values ($1, 'P-50', 'Alex Beispiel', 'inhaber@demo-krankentransporte.example') returning id", [B])).rows[0].id;
    await db.admin.query("update auth.users set password_hash = 'scrypt$32768$8$1$c2FsdHNhbHQ=$YWx0ZXNQYXNzd29ydEhhc2g=' where id = $1", [U.ownerA]);
    const token = await db.as(U.ownerB, async (q) => (await q.query("select public.create_invitation($1) i", [emp])).rows[0].i.token, { commit: true });

    await db.as(null, async (q) => {
      expect((await q.query("select auth.invitation_needs_existing_login($1) x", [token])).rows[0].x).toBe(true);
      expect((await q.query("select auth.invitation_needs_existing_login($1) x", [IDS.invitationTokenB])).rows[0].x).toBe(false);
    }, { role: "app_auth" });

    const e = await pgError(db.as(null, (q) => q.query("select auth.accept_invitation($1, 'scrypt$32768$8$1$bmV1$bmV1ZXNQYXNzd29ydEhhc2g=')", [token]), { role: "app_auth" }));
    expect(e.code).toBe("PT409");
    expect(e.message).toContain("bereits ein Benutzerkonto");
    const uid = await db.as(null, async (q) => (await q.query("select auth.accept_invitation($1, null) u", [token])).rows[0].u, { role: "app_auth", commit: true });
    expect(uid).toBe(U.ownerA);
    const user = await db.admin.query("select password_hash from auth.users where id = $1", [U.ownerA]);
    expect(user.rows[0].password_hash).toBe("scrypt$32768$8$1$c2FsdHNhbHQ=$YWx0ZXNQYXNzd29ydEhhc2g=");
    const row = await db.admin.query("select user_id, status from public.employees where id = $1", [emp]);
    expect(row.rows[0]).toEqual({ user_id: U.ownerA, status: "active" });
  });

  it("a new account still requires a password", async () => {
    const e = await pgError(db.as(null, (q) => q.query("select auth.accept_invitation($1, null)", [IDS.invitationTokenB]), { role: "app_auth" }));
    expect(e.code).toBe("22023");
  });
});

describe("(4) session idle timeout", () => {
  it("touches last_seen_at, revokes idle sessions (default 120 min, configurable)", async () => {
    await db.as(null, async (q) => {
      const s = (await q.query("select * from auth.create_session($1, interval '1 day')", [U.emp1A])).rows[0];
      await q.query("update auth.sessions set last_seen_at = now() - interval '119 minutes' where id = $1", [s.session_id]);
      expect((await q.query("select user_id from auth.resolve_session($1)", [s.token])).rows).toEqual([{ user_id: U.emp1A }]);
      const seen = (await q.query("select last_seen_at = now() as fresh from auth.sessions where id = $1", [s.session_id])).rows[0];
      expect(seen.fresh).toBe(true);
      // shorter custom idle time
      await q.query("update auth.sessions set last_seen_at = now() - interval '31 minutes' where id = $1", [s.session_id]);
      expect((await q.query("select * from auth.resolve_session($1, 30)", [s.token])).rows).toEqual([]);
      expect((await q.query("select revoked_at is not null r from auth.sessions where id = $1", [s.session_id])).rows[0].r).toBe(true);

      const s2 = (await q.query("select * from auth.create_session($1, interval '1 day')", [U.emp1A])).rows[0];
      await q.query("update auth.sessions set created_at = now() - interval '3 hours', last_seen_at = null where id = $1", [s2.session_id]);
      expect((await q.query("select * from auth.resolve_session($1)", [s2.token])).rows).toEqual([]);
      const e = await pgError(q.query("select * from auth.resolve_session($1, 0)", [s2.token]));
      expect(e.code).toBe("22023");
    }, { role: "app_auth" });
    const e = await pgError(db.as(U.emp1A, (q) => q.query("select * from auth.resolve_session('x')")));
    expect(e.code).toBe("42501");
  });
});

describe("(5) German number format in the shift-length message", () => {
  it("uses a decimal comma", async () => {
    expect((await db.admin.query("select private.format_hours_de(750) a, private.format_hours_de(720) b, private.format_hours_de(630) c")).rows[0])
      .toEqual({ a: "12,5", b: "12", c: "10,5" });
    await db.admin.query("update public.tenants set settings = jsonb_set(settings, '{breakPolicy,maxShiftMinutes}', '630') where id = $1", [B]);
    const e = await pgError(db.as(U.empB, (q) => q.query("select public.create_time_entry($1, $2)",
      [E.empB, { id: "long-shift-01", date: "2026-10-20", start: "06:00", end: "17:00", pauseMinutes: 45 }])));
    expect(e.code).toBe("23514");
    expect(e.message).toBe("Ein Einsatz darf höchstens 630 Minuten (10,5 Stunden) dauern. Bitte die Uhrzeiten prüfen.");
    const e2 = await pgError(db.as(U.emp1A, (q) => q.query("select public.create_time_entry($1, $2)",
      [E.emp1A, { id: "long-shift-02", date: "2026-10-20", start: "06:00", end: "18:30", pauseMinutes: 45 }])));
    expect(e2.message).toContain("720 Minuten (12 Stunden)");
  });
});

describe("(6) platform employee counts", () => {
  it("employee_count excludes deactivated employees; total includes them", async () => {
    await db.admin.query("update public.employees set status = 'deactivated' where id = $1", [E.emp2A]);
    try {
      const rows = await db.as(U.support, async (q) => (await q.query(
        "select slug, employee_count, active_employee_count, total_employee_count from public.platform_list_tenants() where slug = 'demo-krankentransporte'")).rows);
      expect(rows).toEqual([{ slug: "demo-krankentransporte", employee_count: 3, active_employee_count: 3, total_employee_count: 4 }]);
      const b = await db.as(U.support, async (q) => (await q.query(
        "select employee_count, active_employee_count, total_employee_count from public.platform_list_tenants() where slug = 'muster-pflegedienst'")).rows[0]);
      expect(b).toMatchObject({ active_employee_count: b.employee_count - 1 }); // one invited
    } finally {
      await db.admin.query("update public.employees set status = 'active' where id = $1", [E.emp2A]);
    }
    const e = await pgError(db.as(U.ownerA, (q) => q.query("select * from public.platform_list_tenants()")));
    expect(e.code).toBe("42501");
  });
});

describe("(7) e-mail of employees linked to an account", () => {
  it("cannot be changed by managers, owners or the person; unlinked rows can", async () => {
    for (const [user, id] of [[U.managerA, E.emp1A], [U.ownerA, E.managerA], [U.emp1A, E.emp1A]] as const) {
      const e = await pgError(db.as(user, (q) => q.query("update public.employees set email = 'neu@beispiel.example' where id = $1", [id])));
      expect(e.code, `${user} → ${id}`).toBe("42501");
    }
    const login = await db.admin.query("select email from auth.users where id = $1", [U.emp1A]);
    expect(login.rows[0].email).toBe("fahrer1@demo-krankentransporte.example");
    // other fields of linked rows stay editable
    expect(await db.as(U.managerA, async (q) => (await q.query("update public.employees set display_name = 'Sam Probe' where id = $1", [E.emp1A])).rowCount)).toBe(1);
    // unlinked (invited) employee: e-mail may be corrected before the invitation is accepted
    const n = await db.as(U.ownerB, async (q) => (await q.query(
      "update public.employees set email = 'pflege2-neu@muster-pflegedienst.example' where id = $1", [E.invitedB])).rowCount);
    expect(n).toBe(1);
  });
});

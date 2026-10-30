/**
 * End of contract (migration 0020): operator export and deletion of a whole
 * tenant. The completeness checks read every table with a tenant_id column
 * from the catalogue, so tables added later are covered automatically.
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
const SLUG_A = "demo-krankentransporte";
const SLUG_B = "muster-pflegedienst";
const SHA = "a".repeat(64);
const KEPT = ["public.billing_periods", "public.invoices"];
const CONTACT = { legalName: "Test GmbH", street: "Weg 1", postalCode: "12345", city: "Musterstadt" };

/** All base tables (any schema) with a tenant_id column. */
async function tenantTables(): Promise<string[]> {
  const r = await db.admin.query(
    `select format('%I.%I', n.nspname, c.relname) as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
      order by 1`);
  return r.rows.map((x) => x.t as string);
}

/** Rows per tenant_id table for one tenant (only tables with rows). */
async function rowsOf(tenant: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await tenantTables()) {
    const c = (await db.admin.query(`select count(*)::int as c from ${t} where tenant_id = $1`, [tenant])).rows[0].c as number;
    if (c > 0) out[t] = c;
  }
  return out;
}

/** Fingerprint of everything that belongs to a tenant (rows of all tenant_id tables, the tenant row, its accounts). */
async function fingerprint(tenant: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of await tenantTables()) {
    out[t] = (await db.admin.query(
      `select count(*)::int || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as f from ${t} x where tenant_id = $1`,
      [tenant])).rows[0].f as string;
  }
  out.tenant = (await db.admin.query("select md5(x::text) as f from public.tenants x where id = $1", [tenant])).rows[0].f as string;
  out.users = (await db.admin.query(
    `select coalesce(md5(string_agg(u::text, '|' order by u.id)), '') as f from auth.users u
      where u.id in (select user_id from public.employees where tenant_id = $1)`, [tenant])).rows[0].f as string;
  out.sessions = (await db.admin.query(
    `select count(*)::int as f from auth.sessions s where s.user_id in (select user_id from public.employees where tenant_id = $1)`,
    [tenant])).rows[0].f as string;
  return out;
}

const exportAsOperator = (slug: string) =>
  db.admin.query("select private.operator_export_tenant($1) as d", [slug]).then((r) => r.rows[0].d);
const deleteTenant = (slug: string, confirm: string, sha: string | null, without = false) =>
  db.admin.query("select private.operator_delete_tenant($1, $2, $3, $4) as r", [slug, confirm, sha, without]).then((r) => r.rows[0].r);

async function deactivate(tenant: string) {
  await db.admin.query("update public.tenants set status = 'deactivated' where id = $1", [tenant]);
}

describe("rights", () => {
  it("only the database owner may run the operator functions; request roles and app_api cannot", async () => {
    for (const role of ["app_user", "app_auth", "app_anon", "app_service", "app_api"]) {
      for (const fn of ["private.operator_export_tenant(text)", "private.operator_delete_tenant(text, text, text, boolean)",
        "private.tenant_export_json(uuid)"]) {
        const r = await db.admin.query("select has_function_privilege($1, $2, 'execute') as ok", [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
      }
    }
    const e = await pgError(db.as(U.ownerA, (q) => q.query("select private.operator_delete_tenant($1, $1, null, true)", [SLUG_A])));
    expect(e.code).toBe("42501");
  });

  it("request roles cannot delete audit rows even with a marker-like call", async () => {
    const e = await pgError(db.as(U.ownerA, (q) => q.query("delete from public.audit_log where tenant_id = $1", [A])));
    expect(e.code).toBe("42501");
    const owner = await pgError(db.admin.query("delete from public.audit_log where tenant_id = $1", [A]));
    expect(owner.message).toMatch(/unveränderlich/);
  });
});

describe("operator export", () => {
  it("exports a deactivated tenant completely (the owner cannot sign in any more) and audits it", async () => {
    await deactivate(A);
    const ownerTry = await pgError(db.as(U.ownerA, (q) => q.query("select public.export_tenant_data($1)", [A])));
    expect(ownerTry.code).toBe("42501");

    const d = await exportAsOperator(SLUG_A);
    expect(d.format).toBe("stundenwerk.tenant-data.v1");
    expect(d.tenant).toMatchObject({ id: A, slug: SLUG_A, status: "deactivated" });
    const employees = (await db.admin.query("select count(*)::int as c from public.employees where tenant_id = $1", [A])).rows[0].c;
    expect(d.employees).toHaveLength(employees);
    const entries = (await db.admin.query("select count(*)::int as c from public.time_entries where tenant_id = $1", [A])).rows[0].c;
    expect(d.employees.reduce((n: number, e: { timeEntries: unknown[] }) => n + e.timeEntries.length, 0)).toBe(entries);
    // nothing of tenant B
    expect(JSON.stringify(d)).not.toContain(B);
    const audit = (await db.admin.query(
      "select actor_id, after, reason from public.audit_log where tenant_id = $1 and action = 'tenant.operator_export'", [A])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: null, after: { via: "cli", tenantStatus: "deactivated" } });
  });

  it("the owner's export of an active tenant still works (same body)", async () => {
    const d = await db.as(U.ownerB, async (q) => (await q.query("select public.export_tenant_data($1) as d", [B])).rows[0].d, { commit: true });
    expect(d.tenant).toMatchObject({ id: B, slug: SLUG_B });
    expect(d.employees.length).toBeGreaterThan(0);
  });

  it("unknown slug", async () => {
    expect((await pgError(exportAsOperator("gibt-es-nicht"))).code).toBe("P0002");
  });
});

describe("deletion: preconditions", () => {
  it("refuses wrong confirmation, active tenants and a missing export", async () => {
    expect((await pgError(deleteTenant(SLUG_A, "falsch", SHA))).code).toBe("22023");
    expect((await pgError(deleteTenant(SLUG_B, SLUG_B, SHA))).message).toMatch(/nur deaktivierte/);
    // a deactivated tenant that was never exported
    await db.admin.query(`insert into public.tenants (slug, name, status, contact) values ('zz-ohne-export', 'Ohne Export GmbH', 'deactivated', $1)`,
      [CONTACT]);
    expect((await pgError(deleteTenant("zz-ohne-export", "zz-ohne-export", SHA))).message).toMatch(/noch keinen Datenexport/);
    expect((await pgError(deleteTenant(SLUG_A, SLUG_A, null))).message).toMatch(/Prüfsumme/);
    // explicitly without export: allowed
    const r = await deleteTenant("zz-ohne-export", "zz-ohne-export", null, true);
    expect(r.tenantRow).toBe("deleted");
    const a = (await db.admin.query("select after from public.audit_log where action = 'tenant.deleted' and entity_id = $1", [r.tenantId])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].after).toMatchObject({ withoutExport: true, exportSha256: null, lastExportAt: null });
  });

  it("aborts atomically on an error: nothing is deleted, the marker is gone", async () => {
    const before = await fingerprint(A);
    // A table added later that cannot be emptied: the sweep fails → full rollback.
    await db.admin.query("create table public.zz_offboarding_block (tenant_id uuid not null, x int)");
    await db.admin.query("insert into public.zz_offboarding_block values ($1, 1)", [A]);
    await db.admin.query(`create function public.zz_block() returns trigger language plpgsql as $$ begin raise exception 'blockiert'; end $$`);
    await db.admin.query("create trigger zz_block before delete on public.zz_offboarding_block for each row execute function public.zz_block()");
    const e = await pgError(deleteTenant(SLUG_A, SLUG_A, SHA));
    expect(e.message).toMatch(/blockiert/);
    await db.admin.query("drop table public.zz_offboarding_block");
    await db.admin.query("drop function public.zz_block()");
    expect(await fingerprint(A)).toEqual(before);
    expect((await db.admin.query("select count(*)::int as c from private.tenant_deletions")).rows[0].c).toBe(0);
  });
});

describe("deletion of a deactivated tenant without retained documents", () => {
  let result: { tenantRow: string; deletedRows: Record<string, number> };
  let bBefore: Record<string, string>;
  let tenantAPeople: string[];
  let usersA: string[];

  it("deletes every row of the tenant; other tenants stay unchanged", async () => {
    // Shared account: the owner of B is also a (deactivated) member of A → account must stay.
    await db.admin.query(
      `insert into public.employees (tenant_id, user_id, personnel_number, display_name, email, role, status)
       values ($1, $2, 'A-900', 'Geteiltes Konto', null, 'employee', 'active')`, [A, U.ownerB]);
    // A session of an A-only account and a new table with tenant_id (catalogue sweep).
    await db.admin.query("insert into auth.sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')",
      [U.emp1A, "b".repeat(64)]);
    await db.admin.query("create table public.zz_offboarding_extra (tenant_id uuid not null, note text)");
    await db.admin.query("insert into public.zz_offboarding_extra values ($1, 'A'), ($2, 'B')", [A, B]);

    tenantAPeople = (await db.admin.query("select display_name from public.employees where tenant_id = $1 and display_name <> 'Geteiltes Konto'", [A])).rows.map((r) => r.display_name);
    usersA = [U.ownerA, U.managerA, U.emp1A, U.emp2A];
    bBefore = await fingerprint(B);
    const bAuditBefore = (await db.admin.query("select count(*)::int as c from public.audit_log where tenant_id = $1", [B])).rows[0].c;
    expect(Object.keys(await rowsOf(A)).length).toBeGreaterThan(5);

    result = await deleteTenant(SLUG_A, SLUG_A, SHA);
    expect(result.tenantRow).toBe("deleted");
    expect(result.deletedRows["public.time_entries"]).toBeGreaterThan(0);

    // Catalogue: no table with tenant_id contains a row of A.
    expect(await rowsOf(A)).toEqual({});
    expect((await db.admin.query("select count(*)::int as c from public.tenants where id = $1", [A])).rows[0].c).toBe(0);
    // Accounts used only by A are gone (sessions, 2FA, tokens by cascade); the shared one stays.
    expect((await db.admin.query("select count(*)::int as c from auth.users where id = any($1)", [usersA])).rows[0].c).toBe(0);
    expect((await db.admin.query("select count(*)::int as c from auth.sessions where user_id = any($1)", [usersA])).rows[0].c).toBe(0);
    expect((await db.admin.query("select count(*)::int as c from auth.users where id = $1", [U.ownerB])).rows[0].c).toBe(1);
    // Other tenant: unchanged (all tenant_id tables, tenant row, accounts, sessions, audit rows).
    expect(await fingerprint(B)).toEqual(bBefore);
    expect((await db.admin.query("select count(*)::int as c from public.audit_log where tenant_id = $1", [B])).rows[0].c).toBe(bAuditBefore);
    expect((await db.admin.query("select count(*)::int as c from public.zz_offboarding_extra")).rows[0].c).toBe(1);
    await db.admin.query("drop table public.zz_offboarding_extra");
  });

  it("leaves exactly one anonymised audit entry without personal data", async () => {
    const rows = (await db.admin.query("select * from public.audit_log where entity_id = $1 or after::text like '%' || $1 || '%'", [A])).rows;
    expect(rows).toHaveLength(1);
    const a = rows[0];
    expect(a).toMatchObject({ tenant_id: null, action: "tenant.deleted", entity: "tenant", entity_id: A, actor_id: null });
    expect(a.after).toMatchObject({ tenantRow: "deleted", exportSha256: SHA, withoutExport: false });
    expect(a.after.lastExportAt).toBeTruthy();
    const text = JSON.stringify(a);
    for (const n of [...tenantAPeople, SLUG_A, "demo-krankentransporte.example", "Demo Krankentransporte"]) expect(text).not.toContain(n);
    // No other row anywhere mentions A's people or e-mail domain.
    const tables = (await db.admin.query(
      "select format('%I.%I', table_schema, table_name) as t from information_schema.tables where table_schema in ('public', 'auth') and table_type = 'BASE TABLE'")).rows;
    for (const { t } of tables) {
      for (const n of [...tenantAPeople, "demo-krankentransporte.example"]) {
        const c = (await db.admin.query(`select count(*)::int as c from ${t} x where x::text ilike '%' || $1 || '%'`, [n])).rows[0].c;
        expect(c, `${t} contains ${n}`).toBe(0);
      }
    }
  });

  it("is idempotent: a second run finds nothing and changes nothing", async () => {
    expect((await pgError(deleteTenant(SLUG_A, SLUG_A, SHA))).code).toBe("P0002");
  });
});

describe("deletion with retained platform invoices (tombstone)", () => {
  it("keeps invoices and closed billing months, anonymises the tenant row and blocks reactivation", async () => {
    await db.admin.query(
      `insert into public.billing_periods (tenant_id, month, status, billable_count, unit_price_cents, amount_cents, condition, closed_at)
       values ($1, '2026-09', 'invoiced', 2, 500, 1000, 'standard', now()), ($1, '2026-10', 'open', null, null, null, null, null)
       on conflict (tenant_id, month) do update set status = excluded.status, billable_count = excluded.billable_count,
         unit_price_cents = excluded.unit_price_cents, amount_cents = excluded.amount_cents, condition = excluded.condition,
         closed_at = excluded.closed_at`, [B]);
    await db.admin.query(
      `insert into public.invoices (tenant_id, kind, number, year, seq, month, issue_date, service_period_start, service_period_end,
         payment_terms_days, due_date, issuer, recipient, lines, net_cents, vat_rate_percent, vat_cents, gross_cents, vat_rate_confirmed)
       values ($1, 'invoice', 'SW-2026-999001', 2026, 999001, '2026-09', '2026-10-01', '2026-09-01', '2026-09-30', 14, '2026-10-15',
         '{"name": "Plattform Test"}', '{"name": "Muster Pflegedienst"}', '[]', 1000, 19, 190, 1190, false)`, [B]);
    await deactivate(B);
    await exportAsOperator(SLUG_B);
    const r = await deleteTenant(SLUG_B, SLUG_B, SHA);
    expect(r.tenantRow).toBe("tombstone");
    expect(r.retainedRows).toEqual({ "public.billing_periods": 1, "public.invoices": 1 });

    const left = await rowsOf(B);
    expect(Object.keys(left).sort()).toEqual(KEPT);
    const t = (await db.admin.query("select * from public.tenants where id = $1", [B])).rows[0];
    expect(t.slug).toMatch(/^geloescht-[0-9a-f]{12}$/);
    expect(t.name).toMatch(/^Gelöschter Mandant /);
    expect(t.contact).toEqual({ legalName: "Gelöschter Mandant", street: "", postalCode: "", city: "" });
    expect(t.status).toBe("deactivated");
    expect(t.deleted_at).not.toBeNull();
    // no audit row of B remains; the deletion entry has no tenant_id
    expect((await db.admin.query("select count(*)::int as c from public.audit_log where tenant_id = $1", [B])).rows[0].c).toBe(0);

    // Tombstone is final.
    const re = await pgError(db.admin.query("update public.tenants set status = 'active' where id = $1", [B]));
    expect(re.message).toMatch(/gelöscht/);
    const emp = await pgError(db.admin.query(
      "insert into public.employees (tenant_id, personnel_number, display_name, role, status) values ($1, 'X-1', 'Neu Person', 'employee', 'invited')", [B]));
    expect(emp.message).toMatch(/gelöscht/);
    expect((await pgError(exportAsOperator(t.slug))).code).toBe("55000");
    expect((await pgError(deleteTenant(t.slug, t.slug, SHA))).message).toMatch(/bereits gelöscht/);
  });

  it("nobody outside the deletion can set deleted_at", async () => {
    const id = (await db.admin.query(
      `insert into public.tenants (slug, name, status, contact) values ('zz-neu', 'Neu GmbH', 'active', $1) returning id`, [CONTACT])).rows[0].id;
    const e = await pgError(db.admin.query("update public.tenants set deleted_at = now() where id = $1", [id]));
    expect(e.code).toBe("42501");
  });
});

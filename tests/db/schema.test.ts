import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db?.close();
});

describe("schema and seed", () => {
  it("applies migrations and seed with two demo tenants", async () => {
    const { rows } = await db.admin.query("select slug, is_demo from public.tenants order by slug");
    expect(rows).toEqual([
      { slug: "demo-krankentransporte", is_demo: true },
      { slug: "muster-pflegedienst", is_demo: true },
    ]);
  });

  it("enables RLS on every table in public and auth", async () => {
    const { rows } = await db.admin.query(`
      select n.nspname || '.' || c.relname as t, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public', 'auth')`);
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const r of rows) expect(r, r.t).toMatchObject({ rls: true });
  });

  it("keeps tenant-specific rules in settings (no UWE rules for everyone)", async () => {
    const { rows } = await db.admin.query(
      "select slug, settings #> '{breakPolicy,thresholds,0,minGrossMinutes}' as t, settings #>> '{workAccount,openingMinutes}' as o from public.tenants order by slug",
    );
    expect(rows).toEqual([
      { slug: "demo-krankentransporte", t: 360, o: "-6000" },
      { slug: "muster-pflegedienst", t: 361, o: "0" },
    ]);
    const d = await db.admin.query("select private.default_tenant_settings() #>> '{workAccount,enabled}' as e");
    expect(d.rows[0].e).toBe("false");
  });

  it("rejects invalid settings, branding and contact documents", async () => {
    const bad = [
      ["settings", `jsonb_set(settings, '{breakPolicy,maxShiftMinutes}', '800')`],
      ["settings", `jsonb_set(settings, '{workAccount,model}', '"weekly"')`],
      ["branding", `jsonb_set(branding, '{primaryColor}', '"red"')`],
      ["branding", `jsonb_set(branding, '{logoUrl}', '"javascript:alert(1)"')`],
      ["contact", `jsonb_set(contact, '{whatsapp}', '"+49 151 123"')`],
    ];
    for (const [col, expr] of bad) {
      const e = await pgError(db.admin.query(`update public.tenants set ${col} = ${expr} where id = $1`, [IDS.tenantA]));
      expect(e.code, `${col}: ${expr}`).toBe("23514");
    }
  });

  it("pilot_free licence must have price 0 and billing none", async () => {
    const e1 = await pgError(
      db.admin.query("update public.licenses set price_cents = 4900 where tenant_id = $1", [IDS.tenantA]),
    );
    expect(e1.code).toBe("23514");
    expect(e1.message).toContain("licenses_pilot_free_is_free");
    const e2 = await pgError(
      db.admin.query("update public.licenses set billing = 'provider' where tenant_id = $1", [IDS.tenantA]),
    );
    expect(e2.code).toBe("23514");
    const ok = await db.admin.query("select plan, price_cents, billing, valid_until from public.licenses where tenant_id = $1", [IDS.tenantA]);
    expect(ok.rows[0]).toEqual({ plan: "pilot_free", price_cents: 0, billing: "none", valid_until: null });
  });

  it("allows only one active licence per tenant", async () => {
    const e = await pgError(
      db.admin.query("insert into public.licenses (tenant_id, plan) values ($1, 'standard')", [IDS.tenantA]),
    );
    expect(e.code).toBe("23505");
  });

  it("computes duration and night-shift period", async () => {
    const { rows } = await db.admin.query(
      "select duration_minutes, upper(period)::text as up from public.time_entries where id = 'demo-a03-20260902'",
    );
    expect(rows[0]).toEqual({ duration_minutes: 480, up: "2026-09-03 06:00:00" });
  });

  it("migrations are re-runnable for roles (cluster-wide objects exist only once)", async () => {
    const { rows } = await db.admin.query(
      "select rolname, rolcanlogin, rolinherit, rolbypassrls from pg_roles where rolname like 'app\\_%' order by rolname",
    );
    expect(rows.map((r) => r.rolname)).toEqual(["app_anon", "app_api", "app_auth", "app_service", "app_user"]);
    for (const r of rows) {
      expect(r.rolcanlogin).toBe(false);
      expect(r.rolbypassrls).toBe(r.rolname === "app_service");
    }
  });
});

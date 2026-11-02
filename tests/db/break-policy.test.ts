/**
 * Break rules per tenant (migration 0014): stricter than §4 ArbZG is allowed,
 * laxer is rejected by the database for every writer. The SQL default for new
 * tenants mirrors the single TypeScript place (NEW_TENANT_BREAK_RULE).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BREAK_RULE_THRESHOLDS, defaultBreakPolicy } from "../../platform/src/core/breaks";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db?.close();
});

const A = IDS.tenantA;
const setThresholds = (t: unknown) =>
  `update public.tenants set settings = jsonb_set(settings, '{breakPolicy,thresholds}', '${JSON.stringify(t)}'::jsonb) where id = $1`;

describe("break policy vs. §4 ArbZG", () => {
  it("default for new tenants equals the TypeScript default (single place of the decision)", async () => {
    const { rows } = await db.admin.query("select private.default_tenant_settings() -> 'breakPolicy' as bp");
    expect(rows[0].bp).toEqual(defaultBreakPolicy());
  });

  it("seed: \"Demo Krankentransporte\" uses the optional strict rule, the other tenant the statutory one", async () => {
    const { rows } = await db.admin.query("select slug, settings #> '{breakPolicy,thresholds}' as t from public.tenants order by slug");
    expect(rows).toEqual([
      { slug: "demo-krankentransporte", t: BREAK_RULE_THRESHOLDS.strict },
      { slug: "muster-pflegedienst", t: BREAK_RULE_THRESHOLDS.statutory },
    ]);
  });

  it("the constraint is validated for existing rows", async () => {
    const { rows } = await db.admin.query(
      "select convalidated from pg_constraint where conname = 'tenants_break_policy_statutory'");
    expect(rows).toEqual([{ convalidated: true }]);
  });

  it("owner may switch between statutory and strict, and choose stricter values", async () => {
    for (const t of [BREAK_RULE_THRESHOLDS.statutory, BREAK_RULE_THRESHOLDS.strict,
      [{ minGrossMinutes: 300, minPauseMinutes: 30 }, { minGrossMinutes: 480, minPauseMinutes: 60 }]]) {
      const n = await db.as(IDS.users.ownerA, async (q) => (await q.query(setThresholds(t), [A])).rowCount);
      expect(n, JSON.stringify(t)).toBe(1);
    }
  });

  it("rejects rules laxer than the statute (owner and superuser alike)", async () => {
    const lax: unknown[] = [
      [{ minGrossMinutes: 362, minPauseMinutes: 30 }, { minGrossMinutes: 541, minPauseMinutes: 45 }],
      [{ minGrossMinutes: 361, minPauseMinutes: 29 }, { minGrossMinutes: 541, minPauseMinutes: 45 }],
      [{ minGrossMinutes: 361, minPauseMinutes: 30 }, { minGrossMinutes: 542, minPauseMinutes: 45 }],
      [{ minGrossMinutes: 361, minPauseMinutes: 30 }, { minGrossMinutes: 541, minPauseMinutes: 44 }],
      [{ minGrossMinutes: 361, minPauseMinutes: 30 }],
      [],
    ];
    for (const t of lax) {
      const e1 = await pgError(db.as(IDS.users.ownerA, (q) => q.query(setThresholds(t), [A])));
      expect(e1.code, JSON.stringify(t)).toBe("23514");
      expect(e1.message).toContain("tenants_break_policy_statutory");
      const e2 = await pgError(db.admin.query(setThresholds(t), [A]));
      expect(e2.code, JSON.stringify(t)).toBe("23514");
    }
  });

  it("rejects counting pause pieces under 15 minutes", async () => {
    const e = await pgError(db.admin.query(
      "update public.tenants set settings = jsonb_set(settings, '{breakPolicy,minPauseSegmentMinutes}', '10') where id = $1", [A]));
    expect(e.code).toBe("23514");
    expect(e.message).toContain("tenants_break_policy_statutory");
  });

  it("a new tenant row gets the statutory default", async () => {
    await db.admin.query("begin");
    try {
      const r = await db.admin.query(
        "insert into public.tenants (slug, name, contact) select 'pausen-test', 'Pausen Test GmbH', contact from public.tenants where slug = 'muster-pflegedienst' returning settings -> 'breakPolicy' as bp");
      expect(r.rows[0].bp.thresholds).toEqual(BREAK_RULE_THRESHOLDS.statutory);
    } finally {
      await db.admin.query("rollback");
    }
  });

  it("migration 0030 moves tenants on the old strict rule (45 min from 9 h) to 60 min, nothing else", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const sql = readFileSync(resolve(__dirname, "../../db/migrations/0030_strict_break_60.sql"), "utf8");
    const oldStrict = [{ minGrossMinutes: 360, minPauseMinutes: 30 }, { minGrossMinutes: 540, minPauseMinutes: 45 }];
    const custom = [{ minGrossMinutes: 300, minPauseMinutes: 30 }, { minGrossMinutes: 540, minPauseMinutes: 45 }];
    await db.admin.query(setThresholds(oldStrict), [A]);
    await db.admin.query(setThresholds(custom), [IDS.tenantB]);
    await db.admin.query(sql);
    const t = async (id: string) => (await db.admin.query("select settings #> '{breakPolicy,thresholds}' as t from public.tenants where id = $1", [id])).rows[0].t;
    expect(await t(A)).toEqual(BREAK_RULE_THRESHOLDS.strict);
    expect(await t(IDS.tenantB)).toEqual(custom);
    await db.admin.query(setThresholds(BREAK_RULE_THRESHOLDS.statutory), [IDS.tenantB]);
  });
});

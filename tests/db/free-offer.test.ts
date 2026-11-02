/**
 * Free offer "until further notice" (migration 0029): switch (super admin, audited), billing 0 €,
 * Pro functions for every tenant, settings/subscription show it, no reminder mails for free months.
 * Same rules as platform/src/core/free-offer.ts.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "../../platform/src/core/subscription";
import { earliestFreeEnd } from "../../platform/src/core/free-offer";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
const A = IDS.tenantA;
const B = IDS.tenantB;
const U = IDS.users;
let today = "";

beforeAll(async () => {
  db = await setupTestDb();
  today = (await db.admin.query("select private.berlin_today()::text as d")).rows[0].d;
  // Demo tenant A is a free pilot in the seed; here it pays like a normal customer, in Basic.
  await db.admin.query("update public.licenses set plan = 'standard', free_of_charge = false where tenant_id = $1", [A]);
  await db.admin.query("insert into public.tenant_editions (tenant_id, starts_on, edition) values ($1, date_trunc('month', $2::date), 'basic')", [A, today]);
});
afterAll(async () => {
  await db?.close();
});

const month = (d: string) => d.slice(0, 7);
const firstOf = (d: string) => `${month(d)}-01`;
const setFree = (on: boolean, endsOn: string | null, user: string = U.superAdmin) =>
  db.as(user, async (q: pg.Client) => (await q.query("select public.platform_set_free_offer($1, $2::date, 'Test kostenlos') as s", [on, endsOn])).rows[0].s, { commit: true });
const cond = async (tenant: string, m: string) =>
  (await db.admin.query("select unit_price_cents, condition from private.billing_condition($1, $2)", [tenant, m])).rows[0];
const features = (user: string, tenant: string) =>
  db.as(user, async (q) => (await q.query("select public.tenant_features($1) as f", [tenant])).rows[0].f);
const sub = (user: string, tenant: string) =>
  db.as(user, async (q) => (await q.query("select public.tenant_subscription($1) as s", [tenant])).rows[0].s);

describe("free offer (0029)", () => {
  it("off by default: prices and editions apply", async () => {
    expect(await cond(A, month(today))).not.toMatchObject({ condition: "platform_free" });
    expect((await cond(A, month(today))).unit_price_cents).toBeGreaterThan(0);
    expect(await features(U.emp1A, A)).toMatchObject({ edition: "basic", pro: false });
    expect(await sub(U.ownerA, A)).toMatchObject({ freeOffer: null, proFeatures: false });
  });

  it("only the super admin switches it on; then every tenant pays 0 € and has Pro", async () => {
    expect((await pgError(setFree(true, null, U.support))).code).toBe("42501");
    expect((await pgError(setFree(true, null, U.ownerA))).code).toBe("42501");
    const st = await setFree(true, null);
    expect(st).toMatchObject({ freeOffer: { since: firstOf(today), endsOn: null }, defaultPriceCents: 499, monthlyPriceCents: 699 });
    expect(await cond(A, month(today))).toEqual({ unit_price_cents: 0, condition: "platform_free" });
    expect(await cond(B, month(today))).toEqual({ unit_price_cents: 0, condition: "platform_free" });
    expect(await cond(A, "2030-05")).toEqual({ unit_price_cents: 0, condition: "platform_free" });
    expect(await features(U.emp1A, A)).toMatchObject({ edition: "basic", pro: true });
    expect(await sub(U.ownerA, A)).toMatchObject({ freeOffer: { since: firstOf(today), endsOn: null }, proFeatures: true });
    const billing = await db.as(U.ownerA, async (q) => (await q.query("select public.tenant_billing($1, $2) as b", [A, month(today)])).rows[0].b);
    expect(billing).toMatchObject({ condition: "platform_free", unitPriceCents: 0, amountCents: 0 });
    expect(await pgError(setFree(true, null))).toMatchObject({ code: "55000", message: "Die Nutzung ist bereits kostenlos." });
    const audit = (await db.admin.query("select actor_id, before, after, reason from public.audit_log where action = 'billing_settings.free_offer'")).rows;
    expect(audit).toEqual([{ actor_id: U.superAdmin, before: { freeOffer: null }, after: { freeOffer: { since: firstOf(today), endsOn: null } }, reason: "Test kostenlos" }]);
  });

  it("blocked tenants keep their condition; closed months keep their snapshot", async () => {
    const p = (await db.admin.query("select condition from public.billing_periods where tenant_id = $1 and status <> 'open' order by month limit 1", [B])).rows[0];
    if (p) expect(p.condition).not.toBe("platform_free");
  });

  it("switching off needs one month notice and the last day of a month; on again withdraws the end", async () => {
    const min = earliestFreeEnd(today);
    expect(await pgError(setFree(false, addDays(min, -1 - Number(min.slice(8)) + 1)))).toMatchObject({ code: "22023" });
    expect(await pgError(setFree(false, addDays(min, -3)))).toMatchObject({ code: "22023", message: "Das Ende muss der letzte Tag eines Monats sein." });
    const prevEnd = addDays(firstOf(min), -1);
    expect((await pgError(setFree(false, prevEnd))).message).toMatch(/frühestens zum/);
    expect(await setFree(false, min)).toMatchObject({ freeOffer: { since: firstOf(today), endsOn: min } });
    expect(await cond(A, month(min))).toEqual({ unit_price_cents: 0, condition: "platform_free" });
    expect((await cond(A, month(addDays(min, 1)))).condition).not.toBe("platform_free");
    expect(await pgError(setFree(false, min))).toMatchObject({ code: "55000", message: "Die Nutzung ist nicht unbefristet kostenlos." });
    expect(await setFree(true, null)).toMatchObject({ freeOffer: { since: firstOf(today), endsOn: null } });
    expect((await db.admin.query("select count(*)::int as n from public.platform_free_periods")).rows[0].n).toBe(1);
  });

  it("no reminder mail for a date whose following month is free", async () => {
    // tenant B: a running 12-month term whose end is the last day of the current month
    const start = (await db.admin.query("select private.add_months(date_trunc('month', $1::date)::date, -11)::text as d", [today])).rows[0].d;
    await db.admin.query("update public.tenants set is_demo = false, status = 'active' where id = $1", [B]);
    await db.admin.query("delete from public.subscription_terms where tenant_id = $1", [B]);
    await db.admin.query("update public.tenant_subscriptions set trial_ends_on = null where tenant_id = $1", [B]);
    await db.admin.query("insert into public.subscription_terms (tenant_id, billing_interval, starts_on) values ($1, 'annual', $2)", [B, start]);
    const claim = async () => (await db.admin.query("select tenant_id, kind from auth.claim_subscription_reminders($1)", [today])).rows;
    expect(await claim()).toEqual([]);
    expect((await db.admin.query("select count(*)::int as n from public.subscription_reminders where tenant_id = $1", [B])).rows[0].n).toBe(0);
    await db.admin.query("delete from public.platform_free_periods");
    expect(await claim()).toEqual([expect.objectContaining({ tenant_id: B, kind: "annual_renewal" })]);
  });
});

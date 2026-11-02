/**
 * Editions Basic and Pro (migration 0027): change rules (same as platform/src/core/edition.ts),
 * prices, Pro features refused in Basic, contract conclusion with edition, settings and overviews.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, firstPaidMonthFor, trialEndsOnFor, type TermRow } from "../../platform/src/core/subscription";
import { editionChangeStart } from "../../platform/src/core/edition";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
const A = IDS.tenantA;
const B = IDS.tenantB;
const U = IDS.users;
const E = IDS.employees;
const C = "44444444-4444-4444-8444-444444444444";
const OWNER_C_USER = "d0000000-0000-4000-8000-000000000021";
let today = "";

beforeAll(async () => {
  db = await setupTestDb();
  today = (await db.admin.query("select private.berlin_today()::text as d")).rows[0].d;
  // Demo tenant A is a free pilot in the seed; for the price checks it pays like a normal customer.
  await db.admin.query("update public.licenses set plan = 'standard', free_of_charge = false where tenant_id = $1", [A]);
});
afterAll(async () => {
  await db?.close();
});

const PRO_ONLY = "Diese Funktion gibt es nur in der Pro-Version. Der Inhaber kann im Chef-Portal unter „Abrechnung“ zu Pro wechseln.";
const month = (d: string) => d.slice(0, 7);
const firstOf = (d: string) => `${month(d)}-01`;
const nextFirst = (d: string) => addDays(firstOf(d), 32).slice(0, 8) + "01";
const sa = <T>(fn: (q: pg.Client) => Promise<T>) => db.as(U.superAdmin, fn as never, { commit: true }) as Promise<T>;
const sub = (user: string, tenant: string) =>
  db.as(user, async (q) => (await q.query("select public.tenant_subscription($1) as s", [tenant])).rows[0].s);
const features = (user: string, tenant: string) =>
  db.as(user, async (q) => (await q.query("select public.tenant_features($1) as f", [tenant])).rows[0].f);
const choose = (user: string, tenant: string, edition: string) =>
  db.as(user, async (q) => (await q.query("select public.tenant_choose_edition($1, $2) as s", [tenant, edition])).rows[0].s, { commit: true });
const cond = async (tenant: string, m: string) =>
  (await db.admin.query("select unit_price_cents, condition from private.billing_condition($1, $2)", [tenant, m])).rows[0];
const settings = (patch: Record<string, unknown>, user: string = U.superAdmin) =>
  db.as(user, async (q) => (await q.query("select public.platform_update_billing_settings($1::jsonb, 'Test Basic-Preise') as s", [JSON.stringify(patch)])).rows[0].s, { commit: true });
const terms = async (tenant: string): Promise<TermRow[]> =>
  (await db.admin.query(
    `select id, billing_interval as interval, starts_on::text as "startsOn", ends_on::text as "endsOn",
            cancelled_at as "cancelledAt", cancel_reason as "cancelReason", then_monthly as "thenMonthly"
       from public.subscription_terms where tenant_id = $1 order by starts_on`, [tenant])).rows;
const editions = async (tenant: string) =>
  (await db.admin.query("select starts_on::text as \"startsOn\", edition from public.tenant_editions where tenant_id = $1 order by starts_on", [tenant])).rows;

describe("defaults", () => {
  it("every tenant is Pro without a change; Basic prices 1,99 € in both plans", async () => {
    expect(await features(U.emp1A, A)).toEqual({ edition: "pro", pro: true, nextEdition: null });
    expect(await sub(U.ownerA, A)).toMatchObject({ edition: "pro", firstPaidEdition: "pro", nextEdition: null, proFeatures: true,
      basicAnnualPriceCents: 199, basicMonthlyPriceCents: 199, annualPriceCents: 499, monthlyPriceCents: 699 });
    const st = await sa(async (q) => (await q.query("select public.platform_billing_settings() as s")).rows[0].s);
    expect(st).toMatchObject({ basicPriceCents: 199, basicMonthlyPriceCents: 199 });
  });

  it("features: members and platform staff only", async () => {
    expect((await pgError(features(U.ownerB, A))).code).toBe("42501");
    expect((await pgError(features(U.empB, A))).code).toBe("42501");
    expect(await features(U.support, A)).toMatchObject({ edition: "pro" });
  });
});

describe("choosing the edition (monthly plan)", () => {
  it("Basic from the next month; same again = already planned; Pro withdraws; Pro again = already chosen", async () => {
    expect((await pgError(choose(U.managerA, A, "basic"))).code).toBe("42501");
    expect((await pgError(choose(U.emp1A, A, "basic"))).code).toBe("42501");
    expect((await pgError(choose(U.ownerA, A, "gold"))).code).toBe("22023");
    const expected = editionChangeStart("basic", await terms(A), today, (await sub(U.ownerA, A)).firstPaidMonth);
    expect(expected).toBe(nextFirst(today));
    const s = await choose(U.ownerA, A, "basic");
    expect(s).toMatchObject({ edition: "pro", nextEdition: { edition: "basic", startsOn: expected }, proFeatures: true });
    expect(await features(U.emp1A, A)).toEqual({ edition: "pro", pro: true, nextEdition: { edition: "basic", startsOn: expected } });
    // next month (monthly term from then): Basic monthly price
    expect(await cond(A, month(expected))).toEqual({ unit_price_cents: 199, condition: "monthly" });
    expect(await pgError(choose(U.ownerA, A, "basic"))).toMatchObject({ code: "55000", message: "Der Wechsel zu dieser Version ist bereits geplant." });
    expect(await choose(U.ownerA, A, "pro")).toMatchObject({ edition: "pro", nextEdition: null });
    expect(await editions(A)).toEqual([]);
    expect(await pgError(choose(U.ownerA, A, "pro"))).toMatchObject({ code: "55000", message: "Diese Version ist bereits gewählt." });
    expect(await cond(A, month(expected))).toEqual({ unit_price_cents: 699, condition: "monthly" });
    const audit = (await db.admin.query("select action, actor_id from public.audit_log where tenant_id = $1 and action = 'subscription.edition'", [A])).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actor_id: U.ownerA });
  });
});

describe("Basic in the current month", () => {
  beforeAll(async () => {
    await db.admin.query("update public.tenants set settings = jsonb_set(settings, '{workAccount,enabled}', 'false') where id = $1", [A]);
    await db.admin.query("insert into public.tenant_editions (tenant_id, starts_on, edition) values ($1, $2, 'basic')", [A, firstOf(today)]);
  });

  it("Pro features are refused for members; data stays readable", async () => {
    expect(await features(U.emp1A, A)).toEqual({ edition: "basic", pro: false, nextEdition: null });
    const corr = await pgError(db.as(U.emp1A, (q) => q.query("select * from public.create_correction_request($1, 'change', 'demo-a03-20260901', $2, 'Ende war 15 Uhr')",
      [E.emp1A, JSON.stringify({ end: "15:00" })])));
    expect(corr).toMatchObject({ code: "55000", message: PRO_ONLY });
    const contract = await pgError(db.as(U.managerA, (q) => q.query("select * from public.set_employment_contract($1, '2026-10', 'minijob', 1400, 2580, 0)", [E.emp1A])));
    expect(contract).toMatchObject({ code: "55000", message: PRO_ONLY });
    const wa = await pgError(db.as(U.ownerA, (q) => q.query(
      "update public.tenants set settings = jsonb_set(settings, '{workAccount,enabled}', 'true') where id = $1", [A])));
    expect(wa).toMatchObject({ code: "55000", message: PRO_ONLY });
    // switching it off and other settings stay possible
    await db.as(U.ownerA, (q) => q.query("update public.tenants set settings = jsonb_set(settings, '{workAccount,enabled}', 'false') where id = $1", [A]));
    // reads still work
    await db.as(U.emp1A, (q) => q.query("select count(*) from public.correction_requests"));
    // another tenant is not affected
    expect(await features(U.empB, B)).toMatchObject({ pro: true });
  });

  it("billing month, invoice line and overviews show the edition", async () => {
    const t = await db.as(U.ownerA, async (q) => (await q.query("select public.tenant_billing($1, $2) as b", [A, month(today)])).rows[0].b);
    expect(t).toMatchObject({ edition: "basic" });
    const draft = await sa(async (q) => (await q.query("select public.platform_invoice_draft($1, $2) as d", [A, month(today)])).rows[0].d);
    expect(draft.lines[0].description).toMatch(/^Zeiterfassung Basic – abrechenbare Mitarbeitende/);
    expect(draft.edition).toBe("basic");
    const rows = await sa(async (q) => (await q.query("select tenant_id, edition from public.platform_billing_overview($1)", [month(today)])).rows);
    expect(rows).toEqual(expect.arrayContaining([{ tenant_id: A, edition: "basic" }, { tenant_id: B, edition: "pro" }]));
    expect((await pgError(db.as(U.ownerA, (q) => q.query("select * from public.platform_billing_overview($1)", [month(today)])))).code).toBe("42501");
  });

  it("Pro applies at once (the Basic change of this month disappears)", async () => {
    expect(await choose(U.ownerA, A, "pro")).toMatchObject({ edition: "pro", proFeatures: true, nextEdition: null });
    expect(await editions(A)).toEqual([]);
    expect(await features(U.emp1A, A)).toMatchObject({ pro: true });
  });
});

describe("12-month subscription", () => {
  it("Basic only after the current term (12 months, then by 6 months)", async () => {
    const before = await terms(A);
    await db.admin.query("update public.subscription_terms set billing_interval = 'annual', starts_on = $2 where tenant_id = $1", [A, firstOf(today)]);
    try {
      const t = await terms(A);
      const expected = editionChangeStart("basic", t, today, (await sub(U.ownerA, A)).firstPaidMonth);
      // 12 months from the 1st of this month
      expect(expected).toBe(`${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`);
      const s = await choose(U.ownerA, A, "basic");
      expect(s.nextEdition).toEqual({ edition: "basic", startsOn: expected });
      expect(await cond(A, month(expected))).toEqual({ unit_price_cents: 199, condition: "standard" });
      await choose(U.ownerA, A, "pro");
    } finally {
      await db.admin.query("update public.subscription_terms set billing_interval = 'monthly', starts_on = $2 where tenant_id = $1", [A, before[0]!.startsOn]);
    }
  });
});

describe("contract conclusion with edition and Basic prices", () => {
  beforeAll(async () => {
    await settings({ trialWindowFrom: addDays(today, -10), trialWindowUntil: addDays(today, 10), trialMonths: 3 });
    await db.admin.query("insert into auth.users (id, email) values ($1, 'inhaber@basic-test.example')", [OWNER_C_USER]);
    await db.admin.query(
      `insert into public.tenants (id, slug, name, status, contact) values ($1, 'basic-test', 'Basic Test GmbH', 'active',
         '{"legalName": "Basic Test GmbH (Testdaten)", "street": "Teststr. 1", "postalCode": "52062", "city": "Aachen"}')`, [C]);
    await db.admin.query("insert into public.licenses (tenant_id, plan, billing, valid_from) values ($1, 'standard', 'manual', $2)", [C, today]);
    await db.admin.query(
      `insert into public.employees (tenant_id, user_id, personnel_number, display_name, email, role, status) values
         ($1, $2, 'C-1', 'Inhaberin Basic', 'inhaber@basic-test.example', 'owner', 'active')`, [C, OWNER_C_USER]);
  });

  it("Basic chosen at conclusion applies from the first paid month; the trial keeps every function", async () => {
    const accept = (edition: string) => db.as(OWNER_C_USER, async (q) =>
      (await q.query("select public.tenant_accept_contract($1, true, true, 'monthly', 'AGB Test', 'AVV Test', $2) as s", [C, edition])).rows[0].s, { commit: true });
    expect((await pgError(accept("gold"))).code).toBe("22023");
    const trial = trialEndsOnFor(today, { trialWindowFrom: addDays(today, -10), trialWindowUntil: addDays(today, 10), trialMonths: 3 })!;
    const paid = firstPaidMonthFor(today, trial);
    const s = await accept("basic");
    expect(s).toMatchObject({ edition: "pro", firstPaidEdition: "basic", nextEdition: { edition: "basic", startsOn: `${paid}-01` },
      proFeatures: true, inTrial: true, contract: { edition: "basic", interval: "monthly" } });
    expect(await cond(C, paid)).toEqual({ unit_price_cents: 199, condition: "monthly" });
    // already planned; Pro withdraws it
    expect((await pgError(choose(OWNER_C_USER, C, "basic"))).code).toBe("55000");
    expect(await choose(OWNER_C_USER, C, "pro")).toMatchObject({ firstPaidEdition: "pro", nextEdition: null });
    expect(await cond(C, paid)).toEqual({ unit_price_cents: 699, condition: "monthly" });
    // during the trial Basic is planned from the first paid month again
    expect((await choose(OWNER_C_USER, C, "basic")).nextEdition).toEqual({ edition: "basic", startsOn: `${paid}-01` });
  });

  it("super admin changes the Basic prices (audited); others cannot", async () => {
    expect((await pgError(settings({ basicPriceCents: 249 }, U.support))).code).toBe("42501");
    expect((await pgError(settings({ basicPriceCents: -1 }))).code).toBe("22023");
    expect((await pgError(settings({ basicPriceCents: 1.5 }))).code).toBe("22023");
    const st = await settings({ basicPriceCents: 249, basicMonthlyPriceCents: 299, cancelNoticeDays: 0 });
    expect(st).toMatchObject({ basicPriceCents: 249, basicMonthlyPriceCents: 299 });
    const paid = (await sub(OWNER_C_USER, C)).firstPaidMonth;
    expect(await cond(C, paid)).toEqual({ unit_price_cents: 299, condition: "monthly" });
    // one entry for the 0023 settings, one for the Basic prices (before → after)
    const audit = (await db.admin.query(
      `select before, after from public.audit_log where action = 'billing_settings.update'
          and (before ->> 'basicPriceCents') = '199' and (after ->> 'basicPriceCents') = '249'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ basicMonthlyPriceCents: 299 });
    await settings({ basicPriceCents: 199, basicMonthlyPriceCents: 199 });
  });
});

/**
 * Subscription model (migration 0023): trial window, 12-month subscription and monthly plan,
 * renewal, cancellation, withdrawal, contract conclusion, settings, welcome code, reminders and
 * automatic monthly invoices. The SQL rules are compared with platform/src/core/subscription.ts
 * (same inputs, same "today" = Berlin day of the database).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDays, annualTermEnd, cancellationEnd, currentAnnualEnd, firstPaidMonthFor, planChoice, trialEndsOnFor, type TermRow,
} from "../../platform/src/core/subscription";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
const A = IDS.tenantA;
const B = IDS.tenantB;
const U = IDS.users;
const C = "33333333-3333-4333-8333-333333333333";
const OWNER_C_USER = "d0000000-0000-4000-8000-000000000011";
const MANAGER_C_USER = "d0000000-0000-4000-8000-000000000012";
let today = "";

beforeAll(async () => {
  db = await setupTestDb();
  today = (await db.admin.query("select private.berlin_today()::text as d")).rows[0].d;
});
afterAll(async () => {
  await db?.close();
});

const sa = <T>(fn: (q: pg.Client) => Promise<T>, commit = true) => db.as(U.superAdmin, fn as never, { commit }) as Promise<T>;
const sub = (user: string, tenant: string) =>
  db.as(user, async (q) => (await q.query("select public.tenant_subscription($1) as s", [tenant])).rows[0].s);
const cond = async (tenant: string, month: string) =>
  (await db.admin.query("select unit_price_cents, condition from private.billing_condition($1, $2)", [tenant, month])).rows[0];
const terms = async (tenant: string): Promise<TermRow[]> =>
  (await db.admin.query(
    `select id, billing_interval as interval, starts_on::text as "startsOn", ends_on::text as "endsOn",
            cancelled_at as "cancelledAt", cancel_reason as "cancelReason", then_monthly as "thenMonthly"
       from public.subscription_terms where tenant_id = $1 order by starts_on, ends_on nulls last, id`, [tenant])).rows;
const call = (user: string, sql: string, params: unknown[]) =>
  db.as(user, async (q) => (await q.query(sql, params)).rows[0].s, { commit: true });
const settings = (patch: Record<string, unknown>, reason = "Test Einstellungen") =>
  sa(async (q) => (await q.query("select public.platform_update_billing_settings($1::jsonb, $2) as s", [JSON.stringify(patch), reason])).rows[0].s);
const month = (d: string) => d.slice(0, 7);
const nextFirst = (d: string) => addDays(`${month(d)}-01`, 40).slice(0, 7) + "-01";

describe("rules in SQL = core rules", () => {
  it("trial end (end of the month in which the trial months end), first paid month, term ends, cancellation end", async () => {
    await settings({ trialWindowFrom: "2026-01-01", trialWindowUntil: "2027-12-31", trialMonths: 3 });
    for (const created of ["2026-11-15", "2026-11-01", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28", "2028-01-10"]) {
      const sql = (await db.admin.query("select private.trial_ends_for($1)::text as t", [created])).rows[0].t;
      const core = trialEndsOnFor(created, { trialWindowFrom: "2026-01-01", trialWindowUntil: "2027-12-31", trialMonths: 3 });
      expect(sql, created).toBe(core);
      const paid = (await db.admin.query("select to_char(private.first_paid_day($1, $2), 'YYYY-MM') as m", [created, sql])).rows[0].m;
      expect(paid).toBe(firstPaidMonthFor(created, core));
    }
    expect((await db.admin.query("select private.trial_ends_for('2026-11-15')::text as t")).rows[0].t).toBe("2027-02-28");
    await settings({ trialWindowFrom: null, trialWindowUntil: null });
    expect((await db.admin.query("select private.trial_ends_for('2026-11-15') as t")).rows[0].t).toBeNull();

    for (const start of ["2026-01-01", "2026-08-01", "2027-02-01"]) {
      for (const k of [0, 1, 3]) {
        expect((await db.admin.query("select private.annual_term_end($1, $2)::text as e", [start, k])).rows[0].e).toBe(annualTermEnd(start, k));
      }
      for (const day of ["2026-10-30", "2027-07-31", "2027-08-01", "2029-03-15"]) {
        if (day < start) continue;
        expect((await db.admin.query("select private.current_annual_end($1, $2)::text as e", [start, day])).rows[0].e).toBe(currentAnnualEnd(start, day));
        for (const notice of [0, 30]) {
          for (const interval of ["annual", "monthly"] as const) {
            const e = (await db.admin.query("select private.cancellation_end($1, $2, $3, $4)::text as e", [interval, start, day, notice])).rows[0].e;
            expect(e, `${interval} ${start} ${day} ${notice}`).toBe(cancellationEnd({ interval, startsOn: start }, day, notice));
          }
        }
      }
      // not started yet: never runs
      expect((await db.admin.query("select private.cancellation_end('annual', $1, '2025-12-15', 0)::text as e", [start])).rows[0].e).toBe(addDays(start, -1));
    }
  });
});

describe("existing and seed tenants", () => {
  it("legacy: subscription model from the next month (terms_from); earlier months keep the default price, no retroactive 6,50 €", async () => {
    const termsFrom = nextFirst(today);
    expect((await db.admin.query("select terms_from::text as t from public.tenant_subscriptions where tenant_id = $1", [B])).rows[0].t).toBe(termsFrom);
    const s = await sub(U.ownerB, B);
    expect(s).toMatchObject({
      tenantId: B, trialEndsOn: null, inTrial: false, firstPaidMonth: "2026-10", ended: false, next: null, contractEndsOn: null, withdrawable: null,
      annualPriceCents: 500, monthlyPriceCents: 650, termMonths: 12, renewalMonths: 6, cancelNoticeDays: 0,
      current: { interval: "monthly", startsOn: termsFrom, endsOn: null, currentTermEndsOn: null, cancelledAt: null, thenMonthly: false },
      contract: { termsVersion: "bestand", dpaVersion: "bestand", interval: "monthly", acceptedByName: null },
    });
    expect(await cond(B, "2026-10")).toEqual({ unit_price_cents: 500, condition: "standard" });
    expect(await cond(B, month(today))).toEqual({ unit_price_cents: 500, condition: "standard" });
    expect(await cond(B, month(termsFrom))).toEqual({ unit_price_cents: 650, condition: "monthly" });
    expect(await cond(A, "2026-10")).toEqual({ unit_price_cents: 0, condition: "pilot_free" });
    // a later correction of the start date keeps the legacy start of the terms
    await db.admin.query("update public.tenants set created_at = created_at - interval '1 day' where id = $1", [B]);
    expect((await terms(B)).map((t) => t.startsOn)).toEqual([termsFrom]);
  });

  it("leadership and platform staff read; employees and other tenants do not; tables are not readable", async () => {
    expect((await sub(U.managerA, A)).tenantId).toBe(A);
    expect((await sub(U.support, B)).tenantId).toBe(B);
    for (const [user, tenant] of [[U.emp1A, A], [U.ownerA, B], [U.empB, B]]) {
      expect((await pgError(sub(user!, tenant!))).code).toBe("42501");
    }
    for (const table of ["subscription_terms", "tenant_subscriptions", "tenant_contracts", "subscription_reminders"]) {
      expect((await pgError(db.as(U.superAdmin, (q) => q.query(`select * from public.${table}`)))).code, table).toBe("42501");
    }
  });
});

describe("plan choice, cancellation, withdrawal (tenant B, monthly since 10/2026)", () => {
  beforeAll(async () => {
    // B here like a customer that started after 0023 (no legacy months): monthly plan since 10/2026.
    await db.admin.query("update public.tenant_subscriptions set terms_from = null where tenant_id = $1", [B]);
    await db.admin.query("update public.subscription_terms set starts_on = '2026-10-01' where tenant_id = $1", [B]);
  });

  it("only the owner changes; monthly → annual from the next month (as core planChoice)", async () => {
    expect((await pgError(call(U.empB, "select public.tenant_choose_subscription($1, 'annual') as s", [B]))).code).toBe("42501");
    expect((await pgError(call(U.support, "select public.tenant_choose_subscription($1, 'annual') as s", [B]))).code).toBe("42501");
    expect(await pgError(call(U.ownerB, "select public.tenant_choose_subscription($1, 'monthly') as s", [B])))
      .toMatchObject({ code: "55000", message: "Der Monatstarif läuft bereits." });
    expect((await pgError(call(U.ownerB, "select public.tenant_choose_subscription($1, 'weekly') as s", [B]))).code).toBe("22023");
    const before = await terms(B);
    const plan = planChoice(before, "annual", today, "2026-10");
    const s = await call(U.ownerB, "select public.tenant_choose_subscription($1, 'annual') as s", [B]);
    const after = await terms(B);
    expect(after.map((t) => [t.interval, t.startsOn, t.endsOn])).toEqual([
      ["monthly", "2026-10-01", addDays(plan.add!.startsOn, -1)],
      ["annual", plan.add!.startsOn, null],
    ]);
    expect(plan.add!.startsOn).toBe(nextFirst(today));
    expect(s).toMatchObject({ current: { interval: "monthly" }, next: { interval: "annual", startsOn: plan.add!.startsOn, currentTermEndsOn: annualTermEnd(plan.add!.startsOn, 0) } });
    // current month stays monthly, the next month is billed at the 12-month price
    expect(await cond(B, month(today))).toEqual({ unit_price_cents: 650, condition: "monthly" });
    expect(await cond(B, month(plan.add!.startsOn))).toEqual({ unit_price_cents: 500, condition: "standard" });
    expect(await pgError(call(U.ownerB, "select public.tenant_choose_subscription($1, 'annual') as s", [B])))
      .toMatchObject({ code: "55000", message: "Das 12-Monats-Abo läuft bereits." });
    expect((await pgError(call(U.ownerB, "select public.tenant_choose_subscription($1, 'monthly') as s", [B]))).message)
      .toContain("Zum Monatstarif können Sie nur zum Ende der Laufzeit wechseln");
    const audit = (await db.admin.query("select action, actor_id, before, after from public.audit_log where entity = 'subscription' and tenant_id = $1", [B])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "subscription.choose", actor_id: U.ownerB });
    expect(audit[0].before.next).toBeNull();
    expect(audit[0].after.next.interval).toBe("annual");
    // platform staff see subscription audit entries
    const seen = await db.as(U.support, async (q) => (await q.query("select action from public.audit_log where entity = 'subscription'")).rows);
    expect(seen.map((r) => r.action)).toContain("subscription.choose");
  });

  it("cancel the annual term with 'then monthly' (not started yet: never runs, monthly from its start); withdraw deletes the follow-up", async () => {
    const annual = (await terms(B)).find((t) => t.interval === "annual")!;
    const s = await call(U.ownerB, "select public.tenant_cancel_subscription($1, true, 'Zu teuer') as s", [B]);
    const end = cancellationEnd(annual, today, 0);
    expect(end).toBe(addDays(annual.startsOn, -1));
    const after = await terms(B);
    expect(after.map((t) => [t.interval, t.startsOn, t.endsOn, t.thenMonthly])).toEqual([
      ["monthly", "2026-10-01", end, false],
      ["annual", annual.startsOn, end, true],
      ["monthly", annual.startsOn, null, false],
    ]);
    expect(s.next).toMatchObject({ interval: "monthly", startsOn: annual.startsOn });
    expect(s.withdrawable).toMatchObject({ interval: "annual", startsOn: annual.startsOn, endsOn: end, thenMonthly: true });
    expect(await cond(B, month(annual.startsOn))).toEqual({ unit_price_cents: 650, condition: "monthly" });
    const w = await call(U.ownerB, "select public.tenant_withdraw_cancellation($1) as s", [B]);
    expect((await terms(B)).map((t) => [t.interval, t.startsOn, t.endsOn])).toEqual([
      ["monthly", "2026-10-01", end],
      ["annual", annual.startsOn, null],
    ]);
    expect(w.next).toMatchObject({ interval: "annual", endsOn: null, cancelledAt: null });
    expect(w.withdrawable).toBeNull();
    expect(await pgError(call(U.ownerB, "select public.tenant_withdraw_cancellation($1) as s", [B])))
      .toMatchObject({ code: "55000", message: "Es gibt keine Kündigung, die noch zurückgenommen werden kann." });
  });

  it("cancelling a planned switch that has not started undoes it: the replaced monthly term runs on (core planCancel)", async () => {
    const before = await terms(B);
    const s = await call(U.ownerB, "select public.tenant_cancel_subscription($1, false, null) as s", [B]);
    expect((await terms(B)).map((t) => [t.interval, t.startsOn, t.endsOn, t.cancelledAt])).toEqual([["monthly", "2026-10-01", null, null]]);
    expect(s).toMatchObject({ current: { interval: "monthly", endsOn: null }, next: null, contractEndsOn: null, withdrawable: null });
    const audit = (await db.admin.query("select after, reason from public.audit_log where tenant_id = $1 and action = 'subscription.cancel' order by created_at desc, id desc limit 1", [B])).rows[0];
    expect(audit.after).toMatchObject({ undoneSwitch: true, cancelledInterval: "annual", continuesInterval: "monthly" });
    expect(audit.reason).toBe("Geplanter Tarifwechsel zurückgenommen");
    // restore the switch for the next case
    await db.admin.query("delete from public.subscription_terms where tenant_id = $1", [B]);
    for (const t of before) {
      await db.admin.query("insert into public.subscription_terms (id, tenant_id, billing_interval, starts_on, ends_on) values ($1, $2, $3, $4, $5)",
        [t.id, B, t.interval, t.startsOn, t.endsOn]);
    }
  });

  it("a running annual term ends at its term end (+6 months per renewal); afterwards nothing is billed; a new plan follows", async () => {
    // Let the annual term have started 13 months ago (one renewal): the current term end is start + 18 months − 1.
    const start = addDays(`${month(today)}-01`, -400).slice(0, 7) + "-01";
    await db.admin.query("delete from public.subscription_terms where tenant_id = $1 and billing_interval = 'monthly'", [B]);
    await db.admin.query("update public.subscription_terms set starts_on = $2 where tenant_id = $1", [B, start]);
    const s = await sub(U.ownerB, B);
    expect(s.current).toMatchObject({ interval: "annual", startsOn: start, currentTermEndsOn: currentAnnualEnd(start, today) });
    expect(() => planChoice([], "annual", today, "2026-10")).not.toThrow();
    expect((await pgError(call(U.ownerB, "select public.tenant_cancel_subscription($1, false, null) as s", [A]))).code).toBe("42501");
    const c = await call(U.ownerB, "select public.tenant_cancel_subscription($1, false, null) as s", [B]);
    const end = currentAnnualEnd(start, today);
    expect(c).toMatchObject({ current: { endsOn: end, thenMonthly: false }, next: null, contractEndsOn: end, ended: false });
    const after = addDays(end, 1);
    expect(await cond(B, month(after))).toEqual({ unit_price_cents: 0, condition: "ended" });
    expect(await pgError(call(U.ownerB, "select public.tenant_cancel_subscription($1, false, null) as s", [B])))
      .toMatchObject({ code: "55000", message: "Es gibt keinen laufenden Vertrag, der gekündigt werden kann." });
    // choosing while the cancelled term still runs: the new term starts right after it
    const plan = planChoice(await terms(B), "monthly", today, "2026-10");
    const n = await call(U.ownerB, "select public.tenant_choose_subscription($1, 'monthly') as s", [B]);
    expect(plan.add).toEqual({ interval: "monthly", startsOn: after });
    expect(n.next).toMatchObject({ interval: "monthly", startsOn: after });
    expect(n.contractEndsOn).toBeNull();
    const audit = (await db.admin.query("select action from public.audit_log where entity = 'subscription' and tenant_id = $1 order by created_at, id", [B])).rows;
    expect(audit.map((r) => r.action)).toEqual(["subscription.choose", "subscription.cancel", "subscription.withdraw", "subscription.cancel", "subscription.cancel", "subscription.choose"]);
  });

  it("'then monthly' only for the 12-month subscription; terms never overlap", async () => {
    // B: annual (cancelled) + monthly afterwards → the open term is monthly
    expect(await pgError(call(U.ownerB, "select public.tenant_cancel_subscription($1, true, null) as s", [B])))
      .toMatchObject({ code: "22023", message: "„Danach monatlich weiter“ gibt es nur beim 12-Monats-Abo." });
    const t = await terms(B);
    const e = await pgError(db.admin.query("insert into public.subscription_terms (tenant_id, billing_interval, starts_on) values ($1, 'monthly', $2)", [B, t[0]!.startsOn]));
    expect(e.code).toBe("23P01");
  });
});

describe("frozen months and issued invoices stay unchanged", () => {
  it("a frozen month keeps condition and price when prices or plans change", async () => {
    // A here like a customer that started after 0023 (no legacy months)
    await db.admin.query("update public.tenant_subscriptions set terms_from = null where tenant_id = $1", [A]);
    await db.admin.query("update public.tenants set created_at = '2026-06-01 00:00 Europe/Berlin' where id = $1", [A]);
    await db.admin.query("update public.licenses set plan = 'standard', free_of_charge = false, price_cents = 0, billing = 'manual' where tenant_id = $1", [A]);
    await db.admin.query("update public.employee_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [A]);
    await db.admin.query("update public.tenant_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [A]);
    // A's automatic term follows the new creation day (trigger)
    expect((await terms(A)).map((x) => [x.interval, x.startsOn])).toEqual([["monthly", "2026-06-01"]]);
    await sa((q) => q.query("select public.platform_set_billing_status($1, '2026-07', 'invoiced', 'Test')", [A]));
    const frozen = (await db.admin.query("select condition, unit_price_cents, amount_cents from public.billing_periods where tenant_id = $1 and month = '2026-07'", [A])).rows[0];
    expect(frozen).toMatchObject({ condition: "monthly", unit_price_cents: 650 });
    await settings({ monthlyPriceCents: 700 });
    try {
      const jul = await db.as(U.ownerA, async (q) => (await q.query("select public.tenant_billing($1, '2026-07') as b", [A])).rows[0].b);
      expect(jul).toMatchObject({ final: true, condition: "monthly", unitPriceCents: 650, amountCents: frozen.amount_cents, interval: "monthly" });
      const aug = await db.as(U.ownerA, async (q) => (await q.query("select public.tenant_billing($1, '2026-08') as b", [A])).rows[0].b);
      expect(aug).toMatchObject({ final: false, condition: "monthly", unitPriceCents: 700 });
    } finally {
      await settings({ monthlyPriceCents: 650 });
    }
  });

  it("invoice line names the plan: Monatstarif / 12-Monats-Abo / with promo code", async () => {
    const d = await sa(async (q) => (await q.query("select public.platform_invoice_draft($1, '2026-08') as d", [A])).rows[0].d);
    expect(d.lines[0].description).toBe("Zeiterfassung – abrechenbare Mitarbeitende 08/2026 (Monatstarif)");
    const frozen = await sa(async (q) => (await q.query("select public.platform_invoice_draft($1, '2026-07') as d", [A])).rows[0].d);
    expect(frozen.lines[0].description).toBe("Zeiterfassung – abrechenbare Mitarbeitende 07/2026 (Monatstarif)");
    await db.admin.query("update public.subscription_terms set billing_interval = 'annual' where tenant_id = $1", [A]);
    const annual = await sa(async (q) => (await q.query("select public.platform_invoice_draft($1, '2026-08') as d", [A])).rows[0].d);
    expect(annual.lines[0].description).toBe("Zeiterfassung – abrechenbare Mitarbeitende 08/2026 (12-Monats-Abo)");
    expect(annual.condition).toBe("standard");
    // the frozen July keeps its snapshot (monthly, 6,50 €)
    expect((await sa(async (q) => (await q.query("select public.platform_invoice_draft($1, '2026-07') as d", [A])).rows[0].d)).lines[0].unitPriceCents).toBe(650);
    await sa((q) => q.query("select public.platform_create_promo_code('HALB-TEST', 50)"));
    await db.as(U.ownerA, (q) => q.query("select public.tenant_redeem_promo_code($1, 'HALB-TEST')", [A]), { commit: true });
    await db.admin.query("update public.promo_redemptions set redeemed_at = '2026-08-01 00:00 Europe/Berlin' where tenant_id = $1", [A]);
    const promo = await sa(async (q) => (await q.query("select public.platform_invoice_draft($1, '2026-08') as d", [A])).rows[0].d);
    expect(promo.lines[0]).toMatchObject({ unitPriceCents: 250, description: "Zeiterfassung – abrechenbare Mitarbeitende 08/2026 (12-Monats-Abo, Aktionscode HALB-TEST, −50 %)" });
    await db.admin.query("delete from public.promo_redemptions where tenant_id = $1", [A]);
    await db.admin.query("update public.subscription_terms set billing_interval = 'monthly' where tenant_id = $1", [A]);
  });
});

describe("settings (super admin)", () => {
  it("patch: only given fields, validated, audited with before/after; support reads only", async () => {
    for (const user of [U.support, U.ownerA]) {
      expect((await pgError(db.as(user, (q) => q.query("select public.platform_update_billing_settings('{\"trialMonths\": 2}', 'Test')")))).code).toBe("42501");
    }
    expect((await pgError(db.as(U.ownerA, (q) => q.query("select public.platform_billing_settings()")))).code).toBe("42501");
    const bad: Array<Record<string, unknown>> = [
      { monthlyPriceCents: -1 }, { monthlyPriceCents: 6.5 }, { trialMonths: 0 }, { trialMonths: 25 }, { cancelNoticeDays: 400 },
      { trialWindowFrom: "2026-11-01" }, { trialWindowFrom: "2026-12-01", trialWindowUntil: "2026-11-01" }, { trialWindowFrom: "kein-datum", trialWindowUntil: "2026-11-01" },
      { welcomePromoCodeId: "00000000-0000-4000-8000-000000000000" }, { unbekannt: 1 },
    ];
    for (const patch of bad) expect((await pgError(settings(patch))).code, JSON.stringify(patch)).toBe("22023");
    expect((await pgError(settings({ trialMonths: 2 }, ""))).code).toBe("22023");
    const s = await settings({ trialWindowFrom: "2026-11-01", trialWindowUntil: "2026-12-31", trialMonths: 2, cancelNoticeDays: 14 }, "Einführungsangebot");
    expect(s).toMatchObject({ defaultPriceCents: 500, monthlyPriceCents: 650, trialWindowFrom: "2026-11-01", trialWindowUntil: "2026-12-31", trialMonths: 2, cancelNoticeDays: 14 });
    const audit = (await db.admin.query("select action, before, after, reason, actor_id from public.audit_log where action = 'billing_settings.update' order by created_at desc limit 1")).rows[0];
    expect(audit).toMatchObject({ reason: "Einführungsangebot", actor_id: U.superAdmin, after: { trialMonths: 2, cancelNoticeDays: 14 } });
    expect(audit.before).toMatchObject({ cancelNoticeDays: 0 });
    expect((await db.as(U.support, async (q) => (await q.query("select public.platform_billing_settings() as s")).rows[0].s)).trialMonths).toBe(2);
    await settings({ trialWindowFrom: null, trialWindowUntil: null, trialMonths: 3, cancelNoticeDays: 0 });
  });

  it("welcome code: only while not ended and redeemable", async () => {
    const code = await sa(async (q) => (await q.query("select public.platform_create_promo_code('WILLKOMMEN-20', 20, null, 2) as c")).rows[0].c);
    const s = await settings({ welcomePromoCodeId: code.id });
    expect(s).toMatchObject({ welcomePromoCodeId: code.id, welcomePromoCode: "WILLKOMMEN-20" });
    const w = async (user: string) => (await db.as(user, (q) => q.query("select * from public.platform_welcome_promo_code()"))).rows;
    expect(await w(U.superAdmin)).toEqual([{ code: "WILLKOMMEN-20", discount_percent: 20 }]);
    expect((await pgError(w(U.ownerA))).code).toBe("42501");
    await db.admin.query("update public.promo_codes set max_redemptions = 1 where id = $1", [code.id]);
    await db.as(U.ownerB, (q) => q.query("select public.tenant_redeem_promo_code($1, 'WILLKOMMEN-20')", [B]), { commit: true });
    expect(await w(U.superAdmin)).toEqual([]); // used up
    await db.admin.query("update public.promo_codes set max_redemptions = null where id = $1", [code.id]);
    expect(await w(U.support)).toHaveLength(1);
    await sa((q) => q.query("select public.platform_end_promo_code($1, 'Aktion vorbei')", [code.id]));
    expect(await w(U.superAdmin)).toEqual([]); // ended
    // the unchanged stored code may have ended – saving other fields with it still works
    expect(await settings({ welcomePromoCodeId: code.id, trialMonths: 3 })).toMatchObject({ welcomePromoCodeId: code.id });
    expect((await settings({ welcomePromoCodeId: null })).welcomePromoCode).toBeNull();
    // newly setting an ended code is refused
    expect((await pgError(settings({ welcomePromoCodeId: code.id }))).code).toBe("22023");
    await db.admin.query("delete from public.promo_redemptions where tenant_id = $1", [B]);
  });
});

describe("new tenant: trial, contract conclusion, reminders", () => {
  beforeAll(async () => {
    await settings({ trialWindowFrom: addDays(today, -10), trialWindowUntil: addDays(today, 10), trialMonths: 3 });
    await db.admin.query("insert into auth.users (id, email) values ($1, 'inhaber@abo-test.example'), ($2, 'leitung@abo-test.example')", [OWNER_C_USER, MANAGER_C_USER]);
    await db.admin.query(
      `insert into public.tenants (id, slug, name, status, contact) values ($1, 'abo-test', 'Abo Test GmbH', 'active',
         '{"legalName": "Abo Test GmbH (Testdaten)", "street": "Teststr. 1", "postalCode": "52062", "city": "Aachen"}')`, [C]);
    await db.admin.query("insert into public.licenses (tenant_id, plan, billing, valid_from) values ($1, 'standard', 'manual', $2)", [C, today]);
    await db.admin.query(
      `insert into public.employees (tenant_id, user_id, personnel_number, display_name, email, role, status) values
         ($1, $2, 'C-1', 'Inhaberin Abo', 'inhaber@abo-test.example', 'owner', 'active'),
         ($1, $3, 'C-2', 'Leitung Abo', 'leitung@abo-test.example', 'manager', 'active')`, [C, OWNER_C_USER, MANAGER_C_USER]);
  });

  it("created inside the window: trial until the end of the month in which 3 months end; first paid month after it", async () => {
    const trial = trialEndsOnFor(today, { trialWindowFrom: addDays(today, -10), trialWindowUntil: addDays(today, 10), trialMonths: 3 })!;
    const s = await sub(OWNER_C_USER, C);
    expect(s).toMatchObject({ trialEndsOn: trial, inTrial: true, firstPaidMonth: firstPaidMonthFor(today, trial), contract: null,
      current: { interval: "monthly", startsOn: `${firstPaidMonthFor(today, trial)}-01`, endsOn: null } });
    expect(await cond(C, month(today))).toEqual({ unit_price_cents: 0, condition: "trial" });
    expect(await cond(C, month(trial))).toEqual({ unit_price_cents: 0, condition: "trial" });
    expect(await cond(C, firstPaidMonthFor(today, trial))).toEqual({ unit_price_cents: 650, condition: "monthly" });
    const t = await db.as(OWNER_C_USER, async (q) => (await q.query("select public.tenant_billing($1, $2) as b", [C, month(today)])).rows[0].b);
    expect(t).toMatchObject({ condition: "trial", amountCents: 0, trialEndsOn: trial, interval: null });
  });

  it("before the contract is concluded the tenant's people cannot write (time entries, employees, plan changes)", async () => {
    const message = "Die Firma ist noch nicht freigeschaltet: Der Inhaber muss zuerst den Nutzungsbedingungen zustimmen.";
    expect(await pgError(call(OWNER_C_USER, "select public.tenant_choose_subscription($1, 'annual') as s", [C]))).toMatchObject({ code: "55000", message });
    expect(await pgError(call(OWNER_C_USER, "select public.tenant_cancel_subscription($1, false, null) as s", [C]))).toMatchObject({ code: "55000", message });
    const emp = await pgError(db.as(MANAGER_C_USER, (q) => q.query(
      "insert into public.employees (tenant_id, personnel_number, display_name, role, status) values ($1, 'C-9', 'Neu', 'employee', 'invited')", [C])));
    expect(emp).toMatchObject({ code: "55000", message });
    const entry = await pgError(db.as(OWNER_C_USER, (q) => q.query(
      `insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time, pause_minutes)
       select 'abo-1', $1, id, $2, '08:00', '12:00', 0 from public.employees where user_id = $3`, [C, today, OWNER_C_USER])));
    expect(entry).toMatchObject({ code: "55000", message });
    // platform staff / maintenance (no member of the tenant) are not affected
    await db.admin.query("insert into public.employees (tenant_id, personnel_number, display_name, role, status) values ($1, 'C-8', 'Wartung', 'employee', 'invited')", [C]);
  });

  it("only the owner concludes, once; both confirmations required; 'annual' applies the plan choice; audited", async () => {
    const accept = (user: string, entrepreneur: boolean, terms: boolean, interval: string) =>
      call(user, "select public.tenant_accept_contract($1, $2, $3, $4, 'AGB 0.9.3, Anlage A 0.9.3, Anlage B 0.9.1', 'AVV 0.9.2, Anlage 1 (TOM) 0.9.1') as s",
        [C, entrepreneur, terms, interval]);
    expect((await pgError(accept(MANAGER_C_USER, true, true, "annual"))).code).toBe("42501");
    expect((await pgError(accept(U.superAdmin, true, true, "annual"))).code).toBe("42501");
    expect((await pgError(accept(OWNER_C_USER, false, true, "annual"))).code).toBe("22023");
    expect((await pgError(accept(OWNER_C_USER, true, false, "annual"))).code).toBe("22023");
    expect((await pgError(accept(OWNER_C_USER, true, true, "weekly"))).code).toBe("22023");
    const before = await terms(C);
    const paid = (await sub(OWNER_C_USER, C)).firstPaidMonth;
    const plan = planChoice(before, "annual", today, paid);
    const s = await accept(OWNER_C_USER, true, true, "annual");
    expect(s.contract).toMatchObject({ termsVersion: "AGB 0.9.3, Anlage A 0.9.3, Anlage B 0.9.1", dpaVersion: "AVV 0.9.2, Anlage 1 (TOM) 0.9.1",
      interval: "annual", acceptedByName: "Inhaberin Abo" });
    expect(plan.remove).toEqual([before[0]!.id]); // monthly never ran (trial)
    expect((await terms(C)).map((t) => [t.interval, t.startsOn, t.endsOn])).toEqual([["annual", plan.add!.startsOn, null]]);
    expect(s.current).toMatchObject({ interval: "annual", startsOn: `${paid}-01` });
    expect(await pgError(accept(OWNER_C_USER, true, true, "monthly"))).toMatchObject({ code: "55000", message: "Der Vertrag wurde bereits abgeschlossen." });
    const audit = (await db.admin.query("select action, actor_id, after from public.audit_log where tenant_id = $1 and entity = 'subscription'", [C])).rows;
    expect(audit).toEqual([expect.objectContaining({ action: "subscription.contract", actor_id: OWNER_C_USER })]);
    // writes are possible now
    await db.as(MANAGER_C_USER, (q) => q.query(
      "insert into public.employees (tenant_id, personnel_number, display_name, role, status) values ($1, 'C-9', 'Neu', 'employee', 'invited')", [C]));
  });

  it("planned annual term cancelled 'then monthly' never runs; withdrawing deletes the monthly follow-up", async () => {
    const annual = (await terms(C))[0]!;
    await call(OWNER_C_USER, "select public.tenant_cancel_subscription($1, true, null) as s", [C]);
    expect((await terms(C)).map((t) => [t.interval, t.startsOn, t.endsOn])).toEqual([
      ["annual", annual.startsOn, addDays(annual.startsOn, -1)],
      ["monthly", annual.startsOn, null],
    ]);
    await call(OWNER_C_USER, "select public.tenant_withdraw_cancellation($1) as s", [C]);
    expect((await terms(C)).map((t) => [t.interval, t.startsOn, t.endsOn])).toEqual([["annual", annual.startsOn, null]]);
  });

  it("reminders: 14 days before the trial end and one month before the end of a running annual term – each once", async () => {
    // a different day only from maintenance (owner connection here); the server job (app_auth) always uses today
    const claim = async (day: string) => (await db.admin.query(
      `select tenant_id, tenant_name, kind, ref_date::text, cancel_by::text, next_interval, annual_price_cents, monthly_price_cents, emails
         from auth.claim_subscription_reminders($1)`, [day])).rows;
    expect((await pgError(db.as(null, (q) => q.query("select * from auth.claim_subscription_reminders($1)", [today]), { role: "app_auth" }))).code).toBe("42501");
    expect(await db.as(null, async (q) => (await q.query("select * from auth.claim_subscription_reminders()")).rows, { role: "app_auth" })).toEqual([]);
    const trial = (await sub(OWNER_C_USER, C)).trialEndsOn as string;
    expect(await claim(addDays(trial, -15))).toEqual([]);
    // no reminder when no term follows the trial (planned annual cancelled) or without a contract
    await call(OWNER_C_USER, "select public.tenant_cancel_subscription($1, false, null) as s", [C]);
    expect(await claim(addDays(trial, -14))).toEqual([]);
    await call(OWNER_C_USER, "select public.tenant_withdraw_cancellation($1) as s", [C]);
    const contract = (await db.admin.query("delete from public.tenant_contracts where tenant_id = $1 returning *", [C])).rows[0];
    expect(await claim(addDays(trial, -14))).toEqual([]);
    await db.admin.query("insert into public.tenant_contracts select * from json_populate_record(null::public.tenant_contracts, $1)", [JSON.stringify(contract)]);
    await db.admin.query("delete from public.subscription_reminders where tenant_id = $1", [C]);
    const r = await claim(addDays(trial, -14));
    expect(r).toEqual([expect.objectContaining({
      tenant_id: C, tenant_name: "Abo Test GmbH", kind: "trial_end", ref_date: trial, next_interval: "annual",
      annual_price_cents: 500, monthly_price_cents: 650, emails: ["inhaber@abo-test.example"],
    })]);
    expect(await claim(addDays(trial, -3))).toEqual([]); // only once
    // request roles cannot claim
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select * from auth.claim_subscription_reminders()")))).code).toBe("42501");

    // annual term of C starts after the trial; reminder one month before its first term end
    const annual = (await terms(C))[0]!;
    const end = annualTermEnd(annual.startsOn, 0);
    const oneMonthBefore = (await db.admin.query("select private.add_months($1, -1)::text as d", [end])).rows[0].d;
    expect(await claim(addDays(oneMonthBefore, -1))).toEqual([]);
    const a = await claim(oneMonthBefore);
    expect(a).toEqual([expect.objectContaining({ kind: "annual_renewal", ref_date: end, cancel_by: end, emails: ["inhaber@abo-test.example"] })]);
    expect(await claim(addDays(end, -1))).toEqual([]);
    // the next term end (after the renewal by 6 months) is reminded again
    const end2 = annualTermEnd(annual.startsOn, 1);
    const b = await claim(addDays(end2, -10));
    expect(b.map((x) => [x.kind, x.ref_date])).toEqual([["annual_renewal", end2]]);
    // with notice days the window ends at end − notice and starts one month before that
    await settings({ cancelNoticeDays: 14 });
    try {
      const end3 = annualTermEnd(annual.startsOn, 2);
      const deadline = addDays(end3, -14);
      const from = (await db.admin.query("select private.add_months($1, -1)::text as d", [deadline])).rows[0].d;
      expect(await claim(addDays(from, -1))).toEqual([]);
      expect(await claim(addDays(deadline, 1))).toEqual([]);
      expect(await claim(deadline)).toEqual([expect.objectContaining({ kind: "annual_renewal", ref_date: end3, cancel_by: deadline })]);
    } finally {
      await settings({ cancelNoticeDays: 0 });
    }
    // demo tenants get no reminders
    await db.admin.query("update public.tenants set is_demo = true where id = $1", [C]);
    expect(await claim(addDays(annualTermEnd(annual.startsOn, 3), -10))).toEqual([]);
    await db.admin.query("update public.tenants set is_demo = false where id = $1", [C]);
  });
});

describe("automatic monthly invoices", () => {
  const COMPLETE = {
    issuerName: "Schichtklar24 Beispiel GmbH (Testdaten)", issuerStreet: "Musterstraße 1", issuerPostalCode: "52062",
    issuerCity: "Aachen", taxNumber: "201/123/45678",
  };
  // a different day only from maintenance (owner connection here)
  const run = async (day: string) => (await db.admin.query("select * from auth.issue_monthly_invoices($1)", [day])).rows;
  const second = () => `${month(today)}-02`;
  const prev = () => addDays(`${month(today)}-01`, -1).slice(0, 7);

  it("from the 2nd: invoices of the previous month for tenants with an amount; 0 € and demo tenants are skipped", async () => {
    // B: real customer since June (monthly plan), A: real customer since June (monthly plan, see above), C: in the trial (0 €)
    await db.admin.query("update public.tenants set created_at = '2026-06-01 00:00 Europe/Berlin', is_demo = false where id = $1", [B]);
    await db.admin.query("update public.employee_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [B]);
    await db.admin.query("update public.tenant_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [B]);
    await db.admin.query("delete from public.subscription_terms where tenant_id = $1", [B]);
    await db.admin.query("insert into public.subscription_terms (tenant_id, billing_interval, starts_on) values ($1, 'monthly', '2026-06-01')", [B]);
    await db.admin.query("update public.tenants set is_demo = false where id = $1", [A]);
    await db.admin.query(`update public.tenants set contact = contact || '{"street": ""}'::jsonb where id = $1`, [A]); // A lacks the address
    expect(await run(`${month(today)}-01`)).toEqual([]); // not before the 2nd
    // issuer data missing: nothing is issued, the problem is reported
    const missing = await run(second());
    expect(missing.every((r) => r.invoice_id === null && r.problem?.includes("Pflichtangaben fehlen"))).toBe(true);
    expect((await db.admin.query("select count(*)::int as n from public.invoices")).rows[0].n).toBe(0);
    await sa((q) => q.query("select public.platform_set_invoice_settings($1::jsonb, 'Absender')", [JSON.stringify(COMPLETE)]));

    const rows = await run(second());
    const forB = rows.find((r) => r.tenant_id === B);
    expect(forB).toMatchObject({ month: prev(), gross_cents: 650, problem: null, emails: ["inhaberin@muster-pflegedienst.example"] });
    expect(forB.number).toMatch(/^SW-\d{4}-000001$/);
    const forA = rows.find((r) => r.tenant_id === A);
    expect(forA).toMatchObject({ invoice_id: null, emails: [] });
    expect(forA.problem).toContain("Anschrift des Kunden");
    expect(rows.find((r) => r.tenant_id === C)).toBeUndefined(); // trial: 0 €
    const period = (await db.admin.query("select status, amount_cents from public.billing_periods where tenant_id = $1 and month = $2", [B, prev()])).rows[0];
    expect(period).toEqual({ status: "invoiced", amount_cents: 650 });
    const audit = (await db.admin.query("select actor_id, after, reason from public.audit_log where action = 'invoice.issue' and tenant_id = $1", [B])).rows;
    expect(audit).toEqual([{ actor_id: null, after: expect.objectContaining({ issuedBy: "system", grossCents: 650 }), reason: "Automatische Monatsrechnung (System)" }]);
  });

  it("idempotent; a cancelled month is not issued again automatically; the super admin can still reissue", async () => {
    const again = await run(second());
    expect(again.filter((r) => r.invoice_id !== null)).toEqual([]);
    expect(again.find((r) => r.tenant_id === B)).toBeUndefined();
    const inv = (await db.admin.query("select id from public.invoices where tenant_id = $1 and kind = 'invoice'", [B])).rows[0];
    await sa((q) => q.query("select public.platform_cancel_invoice($1, 'Testkorrektur')", [inv.id]));
    expect((await run(second())).find((r) => r.tenant_id === B)).toBeUndefined();
    const manual = await sa(async (q) => (await q.query("select * from public.platform_issue_invoice($1, $2)", [B, prev()])).rows[0]);
    expect(manual).toMatchObject({ kind: "invoice", month: prev(), gross_cents: 650 });
    const numbers = (await db.admin.query("select seq from public.invoices order by seq")).rows.map((r) => r.seq);
    expect(numbers).toEqual([1, 2, 3]); // gapless: invoice, cancellation, reissue
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select * from auth.issue_monthly_invoices()")))).code).toBe("42501");
    expect((await pgError(db.as(null, (q) => q.query("select * from auth.issue_monthly_invoices($1)", [second()]), { role: "app_auth" }))).code).toBe("42501");
  });
});

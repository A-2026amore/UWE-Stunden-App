/**
 * Promo codes and gross prices (migration 0022): the super admin creates codes
 * (1–100 % discount), the owner redeems one, the discount runs until the super
 * admin ends it – the month of ending stays discounted, the next month is regular.
 * Tenant B (no plan chosen → monthly plan 6,50 €, migration 0023) is moved back to June 2026.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
const A = IDS.tenantA;
const B = IDS.tenantB;
const U = IDS.users;

beforeAll(async () => {
  db = await setupTestDb();
  await db.admin.query("update public.tenants set created_at = '2026-06-01 00:00 Europe/Berlin' where id = $1", [B]);
  await db.admin.query("update public.employee_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [B]);
  await db.admin.query("update public.tenant_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [B]);
});
afterAll(async () => {
  await db?.close();
});

const cond = async (month: string) =>
  (await db.admin.query("select unit_price_cents, condition from private.billing_condition($1, $2)", [B, month])).rows[0];
const create = (user: string, code: string, pct: number, max: number | null = null) =>
  db.as(user, async (q) => (await q.query("select public.platform_create_promo_code($1, $2, 'Test', $3) as c", [code, pct, max])).rows[0].c, { commit: true });
const redeem = (user: string, tenant: string, code: string) =>
  db.as(user, async (q) => (await q.query("select public.tenant_redeem_promo_code($1, $2) as r", [tenant, code])).rows[0].r, { commit: true });

describe("gross prices", () => {
  it("the default price is 5,00 € gross; the invoice draft contains the VAT", async () => {
    expect((await db.admin.query("select default_price_cents from public.billing_settings")).rows[0].default_price_cents).toBe(500);
    // 0023: without a plan choice the monthly plan (6,50 €) applies; 5,00 € is the 12-month subscription.
    expect((await db.admin.query("select monthly_price_cents from public.billing_settings")).rows[0].monthly_price_cents).toBe(650);
    expect(await cond("2026-07")).toEqual({ unit_price_cents: 650, condition: "monthly" });
  });
});

describe("promo codes", () => {
  it("only the super admin creates codes; format, discount and duplicates are checked", async () => {
    for (const user of [U.support, U.ownerB, U.emp1A]) {
      expect((await pgError(create(user, "START-100", 100))).code).toBe("42501");
    }
    expect((await pgError(create(U.superAdmin, "abc", 100))).code).toBe("22023");
    expect((await pgError(create(U.superAdmin, "GUTSCHEIN 1", 50))).code).toBe("22023");
    expect((await pgError(create(U.superAdmin, "GUTSCHEIN1", 0))).code).toBe("22023");
    expect((await pgError(create(U.superAdmin, "GUTSCHEIN1", 101))).code).toBe("22023");
    const c = await create(U.superAdmin, " start-100 ", 100, 1);
    expect(c).toMatchObject({ code: "START-100", discountPercent: 100, maxRedemptions: 1, redemptionCount: 0, activeCount: 0, endedAt: null });
    expect((await pgError(create(U.superAdmin, "START-100", 50))).code).toBe("55000");
    const audit = (await db.admin.query("select action, actor_id from public.audit_log where entity = 'promo_code'")).rows;
    expect(audit).toEqual([{ action: "promo_code.create", actor_id: U.superAdmin }]);
    const list = await db.as(U.support, async (q) => (await q.query("select public.platform_promo_codes() as l")).rows[0].l);
    expect(list.map((x: { code: string }) => x.code)).toEqual(["START-100"]);
    expect((await pgError(db.as(U.ownerB, (q) => q.query("select public.platform_promo_codes()")))).code).toBe("42501");
    // tables are not readable directly
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select * from public.promo_codes")))).code).toBe("42501");
  });

  it("only the owner redeems; unknown codes give one neutral message; the limit is enforced", async () => {
    expect((await pgError(redeem(U.empB, B, "START-100"))).code).toBe("42501");
    expect((await pgError(redeem(U.ownerA, B, "START-100"))).code).toBe("42501");
    const unknown = await pgError(redeem(U.ownerB, B, "GIBT-ES-NICHT"));
    expect(unknown).toMatchObject({ code: "22023", message: "Der Aktionscode ist ungültig oder nicht mehr einlösbar." });
    const r = await redeem(U.ownerB, B, "start-100");
    expect(r).toMatchObject({ code: "START-100", discountPercent: 100, tenantId: B, endedAt: null });
    // used up (max 1)
    const usedUp = await pgError(redeem(U.ownerA, A, "START-100"));
    expect(usedUp.message).toBe("Der Aktionscode ist ungültig oder nicht mehr einlösbar.");
    // one running discount per tenant
    await create(U.superAdmin, "HALB-50", 50);
    expect(await pgError(redeem(U.ownerB, B, "HALB-50"))).toMatchObject({ code: "55000", message: "Für Ihre Firma läuft bereits ein Aktionsrabatt." });
    const own = await db.as(U.managerA, async (q) => (await q.query("select public.tenant_promo($1) as p", [A])).rows[0].p);
    expect(own).toEqual([]);
    expect((await pgError(db.as(U.ownerA, (q) => q.query("select public.tenant_promo($1)", [B])))).code).toBe("42501");
    const audit = (await db.admin.query("select tenant_id, action from public.audit_log where entity = 'promo_redemption'")).rows;
    expect(audit).toEqual([{ tenant_id: B, action: "promo.redeem" }]);
  });

  it("100 %: the price is 0 € in every month of the redemption until the super admin ends it", async () => {
    await db.admin.query("update public.promo_redemptions set redeemed_at = '2026-07-15 10:00 Europe/Berlin' where tenant_id = $1", [B]);
    expect(await cond("2026-06")).toEqual({ unit_price_cents: 650, condition: "monthly" });
    expect(await cond("2026-07")).toEqual({ unit_price_cents: 0, condition: "promo" });
    expect(await cond("2026-09")).toEqual({ unit_price_cents: 0, condition: "promo" });
    const b = await db.as(U.ownerB, async (q) => (await q.query("select public.tenant_billing($1, '2026-08') as b", [B])).rows[0].b);
    expect(b).toMatchObject({ condition: "promo", unitPriceCents: 0, amountCents: 0, promo: { code: "START-100", discountPercent: 100 } });
    const row = await db.as(U.support, async (q) => (await q.query("select * from public.platform_billing_overview('2026-08') where tenant_id = $1", [B])).rows[0]);
    expect(row).toMatchObject({ condition: "promo", amount_cents: 0, promo_code: "START-100", promo_discount_percent: 100 });
    // nothing to invoice for a free month
    await db.as(U.superAdmin, (q) => q.query(
      "select public.platform_set_invoice_settings($1::jsonb, 'Test')",
      [JSON.stringify({ issuerName: "Betreiber", issuerStreet: "Weg 1", issuerPostalCode: "52062", issuerCity: "Aachen", taxNumber: "201/123/45678" })]), { commit: true });
    await db.admin.query(`update public.tenants set contact = contact || '{"street":"Teststr. 1","postalCode":"52062","city":"Aachen"}'::jsonb where id = $1`, [B]);
    const e = await pgError(db.as(U.superAdmin, (q) => q.query("select public.platform_issue_invoice($1, '2026-08')", [B])));
    expect(e.message).toContain("0,00 €");
  });

  it("ending: support and owners cannot; the month of ending stays discounted, then the regular price", async () => {
    for (const user of [U.support, U.ownerB]) {
      expect((await pgError(db.as(user, (q) => q.query("select public.platform_end_promo_redemption($1, 'Ende')", [B])))).code).toBe("42501");
    }
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.platform_end_promo_redemption($1, '')", [B])))).code).toBe("22023");
    const r = await db.as(U.superAdmin, async (q) => (await q.query("select public.platform_end_promo_redemption($1, 'Aktion vorbei') as r", [B])).rows[0].r, { commit: true });
    expect(r).toMatchObject({ code: "START-100", endReason: "Aktion vorbei" });
    await db.admin.query("update public.promo_redemptions set ended_at = '2026-09-20 12:00 Europe/Berlin' where tenant_id = $1", [B]);
    expect(await cond("2026-09")).toEqual({ unit_price_cents: 0, condition: "promo" });
    expect(await cond("2026-10")).toEqual({ unit_price_cents: 650, condition: "monthly" });
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.platform_end_promo_redemption($1, 'nochmal')", [B])))).code).toBe("55000");
    // the same code cannot be redeemed twice by one tenant
    await db.admin.query("update public.promo_codes set max_redemptions = null where code = 'START-100'");
    expect(await pgError(redeem(U.ownerB, B, "START-100"))).toMatchObject({ code: "55000", message: "Diesen Aktionscode hat Ihre Firma bereits eingelöst." });
  });

  it("50 % on a special price; ending the code ends all running discounts and blocks new redemptions", async () => {
    await db.admin.query("update public.licenses set employee_price_cents = 399 where tenant_id = $1", [B]);
    await redeem(U.ownerB, B, "HALB-50");
    const month = (await db.admin.query("select private.berlin_month() as m")).rows[0].m;
    expect(await cond(month)).toEqual({ unit_price_cents: 200, condition: "promo" }); // 399 × 50 % = 199,5 → 200
    const code = (await db.admin.query("select id from public.promo_codes where code = 'HALB-50'")).rows[0].id;
    const ended = await db.as(U.superAdmin, async (q) => (await q.query("select public.platform_end_promo_code($1, 'Aktion beendet') as c", [code])).rows[0].c, { commit: true });
    expect(ended).toMatchObject({ code: "HALB-50", activeCount: 0, redemptionCount: 1, endReason: "Aktion beendet" });
    expect(ended.redemptions[0]).toMatchObject({ tenantId: B, endReason: "Aktion beendet" });
    expect(await cond(month)).toEqual({ unit_price_cents: 200, condition: "promo" }); // still this month
    expect(await pgError(redeem(U.ownerA, A, "HALB-50"))).toMatchObject({ code: "22023" });
    const audit = (await db.admin.query("select action from public.audit_log where action like 'promo%' order by created_at, id")).rows.map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(["promo_code.end", "promo.end"]));
    // platform staff see the promo audit
    const seen = await db.as(U.support, async (q) => (await q.query("select action from public.audit_log where entity like 'promo%'")).rows);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    await db.admin.query("update public.licenses set employee_price_cents = null where tenant_id = $1", [B]);
  });

  it("blocked tenants and pilot_free stay at 0 € without a promo condition", async () => {
    await create(U.superAdmin, "PILOT-TEST", 30);
    await redeem(U.ownerA, A, "PILOT-TEST");
    const month = (await db.admin.query("select private.berlin_month() as m")).rows[0].m;
    const c = (await db.admin.query("select unit_price_cents, condition from private.billing_condition($1, $2)", [A, month])).rows[0];
    expect(c).toEqual({ unit_price_cents: 0, condition: "pilot_free" });
  });
});

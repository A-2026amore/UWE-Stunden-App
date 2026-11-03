/**
 * Promo codes through the HTTP API (migration 0022): the super admin creates and ends
 * codes, the owner redeems, the billing shows the discount, redeeming is rate limited.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["ownerA", "managerA", "ownerB", "superAdmin", "support"] as const) cookies[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
});

const B = IDS.tenantB;
const month = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}`;
};

describe("promo codes", () => {
  let codeId = "";

  it("super admin creates a code; support only reads; input is validated", async () => {
    expect((await t.call("POST", "/api/platform/promo-codes", { cookie: cookies.support, body: { code: "START-100", discountPercent: 100 } })).status).toBe(403);
    expect((await t.call("POST", "/api/platform/promo-codes", { cookie: cookies.superAdmin, body: { code: "kurz", discountPercent: 100 } })).status).toBe(400);
    expect((await t.call("POST", "/api/platform/promo-codes", { cookie: cookies.superAdmin, body: { code: "START-100", discountPercent: 120 } })).status).toBe(400);
    const r = await t.call("POST", "/api/platform/promo-codes", {
      cookie: cookies.superAdmin, body: { code: "start-100", discountPercent: 100, note: "Messeaktion", maxRedemptions: 5, redeemableUntil: null },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: "START-100", discountPercent: 100, note: "Messeaktion", maxRedemptions: 5, redemptionCount: 0 });
    codeId = r.body.id;
    const dup = await t.call("POST", "/api/platform/promo-codes", { cookie: cookies.superAdmin, body: { code: "START-100", discountPercent: 50 } });
    expect(dup).toMatchObject({ status: 409, body: { error: { message: "Diesen Aktionscode gibt es bereits." } } });
    const list = await t.call("GET", "/api/platform/promo-codes", { cookie: cookies.support });
    expect(list.body.map((c: { code: string }) => c.code)).toEqual(["START-100"]);
  });

  it("only the owner redeems; the billing shows 0 € with the code", async () => {
    expect((await t.call("POST", `/api/tenants/${IDS.tenantA}/promo`, { cookie: cookies.managerA, body: { code: "START-100" } })).status).toBe(403);
    const wrong = await t.call("POST", `/api/tenants/${B}/promo`, { cookie: cookies.ownerB, body: { code: "FALSCH-1" } });
    expect(wrong).toMatchObject({ status: 400, body: { error: { message: "Der Aktionscode ist ungültig oder nicht mehr einlösbar." } } });
    const ok = await t.call("POST", `/api/tenants/${B}/promo`, { cookie: cookies.ownerB, body: { code: "start-100" } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ code: "START-100", discountPercent: 100, endedAt: null });
    const b = await t.call("GET", `/api/tenants/${B}/billing?month=${month()}`, { cookie: cookies.ownerB });
    expect(b.body).toMatchObject({ condition: "promo", unitPriceCents: 0, amountCents: 0, promo: { code: "START-100", discountPercent: 100 } });
    const rev = await t.call("GET", `/api/platform/billing?month=${month()}`, { cookie: cookies.support });
    expect(rev.body.rows.find((x: { tenantId: string }) => x.tenantId === B)).toMatchObject({ condition: "promo", promoCode: "START-100", promoDiscountPercent: 100 });
    const own = await t.call("GET", `/api/tenants/${B}/promo`, { cookie: cookies.ownerB });
    expect(own.body).toHaveLength(1);
    expect((await t.call("GET", `/api/tenants/${B}/promo`, { cookie: cookies.ownerA })).status).toBe(403);
    const again = await t.call("POST", `/api/tenants/${B}/promo`, { cookie: cookies.ownerB, body: { code: "START-100" } });
    expect(again).toMatchObject({ status: 409, body: { error: { message: "Für Ihre Firma läuft bereits ein Aktionsrabatt." } } });
  });

  it("super admin ends the discount of one tenant and the whole code (reason required)", async () => {
    expect((await t.call("POST", `/api/platform/tenants/${B}/promo/end`, { cookie: cookies.support, body: { reason: "Ende" } })).status).toBe(403);
    expect((await t.call("POST", `/api/platform/tenants/${B}/promo/end`, { cookie: cookies.superAdmin, body: {} })).status).toBe(400);
    const r = await t.call("POST", `/api/platform/tenants/${B}/promo/end`, { cookie: cookies.superAdmin, body: { reason: "Aktion vorbei" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ code: "START-100", endReason: "Aktion vorbei" });
    // the month of ending stays discounted
    const b = await t.call("GET", `/api/tenants/${B}/billing?month=${month()}`, { cookie: cookies.ownerB });
    expect(b.body.condition).toBe("promo");
    const end = await t.call("POST", `/api/platform/promo-codes/${codeId}/end`, { cookie: cookies.superAdmin, body: { reason: "Messe vorbei" } });
    expect(end.body).toMatchObject({ endReason: "Messe vorbei", activeCount: 0 });
    const audit = await t.call("GET", "/api/platform/audit?limit=50", { cookie: cookies.support });
    expect(audit.body.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["promo_code.create", "promo.redeem", "promo.end", "promo_code.end"]));
  });

  it("redeeming is rate limited", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await t.call("POST", `/api/tenants/${IDS.tenantA}/promo`, { cookie: cookies.ownerA, body: { code: `RATE-${i}00` } })).status;
    expect(last).toBe(429);
  });
});

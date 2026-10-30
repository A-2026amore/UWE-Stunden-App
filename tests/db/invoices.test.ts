/**
 * Invoices (migration 0019): issuer settings (§ 14 UStG), draft without number,
 * unique and gapless numbers per year (also with parallel calls), immutability,
 * cancellation with its own number, RLS (owner sees own, platform staff all).
 * Tenant B (standard price) is moved back to June 2026 so that past months are billable.
 */
import pg from "pg";
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

const sa = <T>(fn: (q: pg.Client) => Promise<T>, commit = true) => db.as(U.superAdmin, fn as never, { commit }) as Promise<T>;

const COMPLETE = {
  issuerName: "Schichtklar24 Beispiel GmbH (Testdaten)", issuerStreet: "Musterstraße 1", issuerPostalCode: "52062",
  issuerCity: "Aachen", taxNumber: "201/123/45678", vatId: "DE123456789", paymentDetails: "Überweisung (Testdaten)",
};

describe("invoice settings", () => {
  it("defaults: 19 % VAT (not confirmed), 14 days, prefix SW, issuer data missing", async () => {
    const s = await sa(async (q) => (await q.query("select public.platform_invoice_settings() as s")).rows[0].s);
    expect(s).toMatchObject({ vatRatePercent: 19, vatRateConfirmed: false, paymentTermsDays: 14, numberPrefix: "SW" });
    expect(s.missing).toEqual(["Name des Rechnungsstellers", "Anschrift des Rechnungsstellers", "Steuernummer oder USt-IdNr."]);
  });

  it("only super-admins change them (reason, audit); support and customers cannot read or write", async () => {
    for (const user of [U.support, U.ownerA, U.managerA, U.emp1A]) {
      const e = await pgError(db.as(user, (q) => q.query("select public.platform_set_invoice_settings($1, 'Test')", [{ issuerName: "X" }])));
      expect(e.code).toBe("42501");
    }
    for (const user of [U.ownerA, U.emp1A]) {
      const e = await pgError(db.as(user, (q) => q.query("select public.platform_invoice_settings()")));
      expect(e.code).toBe("42501");
      const e2 = await pgError(db.as(user, (q) => q.query("select * from public.invoice_settings")));
      expect(e2.code).toBe("42501");
    }
    const e = await pgError(sa((q) => q.query("select public.platform_set_invoice_settings($1, '')", [{ issuerName: "X" }]), false));
    expect(e.code).toBe("22023");
    const e2 = await pgError(sa((q) => q.query("select public.platform_set_invoice_settings($1, 'Test')", [{ iban: "DE00" }]), false));
    expect(e2.code).toBe("22023");
  });
});

describe("issuing invoices", () => {
  it("without mandatory data only a draft (no number) is possible", async () => {
    const d = await sa(async (q) => (await q.query("select public.platform_invoice_draft($1, '2026-06') as d", [B])).rows[0].d);
    expect(d).toMatchObject({ draft: true, number: null, netCents: 420, vatCents: 80, grossCents: 500, servicePeriodStart: "2026-06-01", servicePeriodEnd: "2026-06-30" });
    expect(d.missing.length).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toContain("Charlie");
    const e = await pgError(sa((q) => q.query("select public.platform_issue_invoice($1, '2026-06')", [B]), false));
    expect(e.code).toBe("55000");
    expect(e.message).toContain("Pflichtangaben fehlen");
    const n = await db.admin.query("select count(*)::int as n from public.invoice_number_counters");
    expect(n.rows[0].n).toBe(0);
  });

  it("complete data: invoice with number SW-<year>-000001, frozen billing month, recipient from the company profile", async () => {
    await sa((q) => q.query("select public.platform_set_invoice_settings($1, 'Absenderangaben erfasst')", [COMPLETE]));
    const inv = await sa(async (q) => (await q.query("select * from public.platform_issue_invoice($1, '2026-06')", [B])).rows[0]);
    const year = new Date().getFullYear();
    expect(inv).toMatchObject({ kind: "invoice", number: `SW-${year}-000001`, seq: 1, month: "2026-06", net_cents: 420, vat_cents: 80, gross_cents: 500, vat_rate_confirmed: false });
    expect(inv.recipient).toMatchObject({ name: "Muster Pflegedienst GmbH (Testdaten)", street: "Musterallee 99", postalCode: "54321" });
    expect(inv.issuer).toMatchObject({ issuerName: COMPLETE.issuerName, taxNumber: COMPLETE.taxNumber, vatId: COMPLETE.vatId });
    expect(inv.lines).toEqual([{ description: "Zeiterfassung – abrechenbare Mitarbeitende 06/2026", quantity: 1, unitPriceCents: 500, amountCents: 500 }]);
    const p = (await db.admin.query("select status, billable_count, amount_cents, note from public.billing_periods where tenant_id = $1 and month = '2026-06'", [B])).rows[0];
    expect(p).toEqual({ status: "invoiced", billable_count: 1, amount_cents: 500, note: `Rechnung SW-${year}-000001` });
    const audit = (await db.admin.query("select action, tenant_id from public.audit_log where entity = 'invoice'")).rows;
    expect(audit).toEqual([{ action: "invoice.issue", tenant_id: B }]);
  });

  it("one valid invoice per month; free/pilot months (0 €), waived and current months are refused", async () => {
    const e = await pgError(sa((q) => q.query("select public.platform_issue_invoice($1, '2026-06')", [B]), false));
    expect(e.code).toBe("55000");
    const pilot = await pgError(sa((q) => q.query("select public.platform_issue_invoice($1, '2026-09')", [A]), false));
    expect(pilot.code).toBe("55000");
    const current = await pgError(sa((q) => q.query("select public.platform_issue_invoice($1, to_char(now() at time zone 'Europe/Berlin', 'YYYY-MM'))", [B]), false));
    expect(current.code).toBe("55000");
    await sa((q) => q.query("select public.platform_set_billing_status($1, '2026-09', 'waived', 'Kulanz Testmonat')", [B]));
    const waived = await pgError(sa((q) => q.query("select public.platform_issue_invoice($1, '2026-09')", [B]), false));
    expect(waived.code).toBe("55000");
  });

  it("numbers stay unique and gapless with parallel calls", async () => {
    const clients = await Promise.all([0, 1, 2, 3].map(async () => {
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      return c;
    }));
    const months = ["2026-07", "2026-08", "2026-07", "2026-08"]; // two calls each for the same month
    const results = await Promise.allSettled(clients.map(async (c, i) => {
      await c.query("begin");
      try {
        await c.query("set local role app_user");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.superAdmin, role: "app_user" })]);
        const r = (await c.query("select number from public.platform_issue_invoice($1, $2)", [B, months[i]])).rows[0];
        await c.query("commit");
        return r.number as string;
      } catch (e) {
        await c.query("rollback");
        throw e;
      }
    }));
    await Promise.all(clients.map((c) => c.end()));
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<string>).value);
    expect(ok).toHaveLength(2);
    const rows = (await db.admin.query("select seq, number from public.invoices order by seq")).rows;
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(new Set(rows.map((r) => r.number)).size).toBe(3);
    const counter = (await db.admin.query("select last_number from public.invoice_number_counters")).rows[0];
    expect(counter.last_number).toBe(3);
  });

  it("invoices are immutable for every role; numbers are never reset", async () => {
    const id = (await db.admin.query("select id from public.invoices where seq = 1")).rows[0].id;
    const e1 = await pgError(db.admin.query("update public.invoices set net_cents = 1 where id = $1", [id]));
    expect(e1.code).toBe("42501");
    const e2 = await pgError(db.admin.query("delete from public.invoices where id = $1", [id]));
    expect(e2.code).toBe("42501");
    const e3 = await pgError(db.admin.query("update public.invoice_number_counters set last_number = 1"));
    expect(e3.code).toBe("42501");
    const e4 = await pgError(db.admin.query("delete from public.invoice_number_counters"));
    expect(e4.code).toBe("42501");
    const e5 = await pgError(db.as(U.superAdmin, (q) => q.query("update public.invoices set net_cents = 1 where id = $1", [id])));
    expect(e5.code).toBe("42501");
  });

  it("cancellation: own number, negative amounts, reference; original marked; a new invoice for the month is possible", async () => {
    const orig = (await db.admin.query("select id, number from public.invoices where seq = 1")).rows[0];
    for (const user of [U.support, U.ownerB]) {
      const e = await pgError(db.as(user, (q) => q.query("select public.platform_cancel_invoice($1, 'Falsche Anschrift')", [orig.id])));
      expect(e.code).toBe("42501");
    }
    const short = await pgError(sa((q) => q.query("select public.platform_cancel_invoice($1, 'x')", [orig.id]), false));
    expect(short.code).toBe("22023");
    const c = await sa(async (q) => (await q.query("select * from public.platform_cancel_invoice($1, 'Falsche Anschrift')", [orig.id])).rows[0]);
    expect(c).toMatchObject({ kind: "cancellation", seq: 4, net_cents: -420, vat_cents: -80, gross_cents: -500, cancels_invoice_id: orig.id, cancel_reason: "Falsche Anschrift" });
    expect(c.lines[0]).toMatchObject({ quantity: 1, unitPriceCents: -500, amountCents: -500 });
    const o = (await db.admin.query("select cancelled_at, cancelled_by_invoice_id from public.invoices where id = $1", [orig.id])).rows[0];
    expect(o.cancelled_by_invoice_id).toBe(c.id);
    const again = await pgError(sa((q) => q.query("select public.platform_cancel_invoice($1, 'Falsche Anschrift')", [orig.id]), false));
    expect(again.code).toBe("55000");
    const cancelCancel = await pgError(sa((q) => q.query("select public.platform_cancel_invoice($1, 'Falsche Anschrift')", [c.id]), false));
    expect(cancelCancel.code).toBe("55000");
    const neu = await sa(async (q) => (await q.query("select * from public.platform_issue_invoice($1, '2026-06')", [B])).rows[0]);
    expect(neu.seq).toBe(5);
    const all = (await db.admin.query("select seq from public.invoices order by seq")).rows.map((r) => r.seq);
    expect(all).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("visibility (RLS)", () => {
  it("the owner sees the own invoices; managers, employees and other tenants see none", async () => {
    const own = await db.as(U.ownerB, async (q) => (await q.query("select number from public.invoices")).rows);
    expect(own).toHaveLength(5);
    for (const user of [U.ownerA, U.managerA, U.emp1A, U.empB]) {
      const rows = await db.as(user, async (q) => (await q.query("select * from public.invoices")).rows);
      expect(rows).toEqual([]);
    }
    for (const user of [U.ownerB, U.superAdmin]) {
      const e = await pgError(db.as(user, (q) => q.query("select * from public.invoice_number_counters")));
      expect(e.code).toBe("42501");
    }
  });

  it("platform staff see all invoices (numbers only) and the invoice audit", async () => {
    for (const user of [U.superAdmin, U.support]) {
      const rows = await db.as(user, async (q) => (await q.query("select number, lines from public.invoices order by seq")).rows);
      expect(rows).toHaveLength(5);
      expect(JSON.stringify(rows)).not.toMatch(/Charlie|Kim|Dana/);
      const audit = await db.as(user, async (q) => (await q.query("select action from public.audit_log where entity = 'invoice'")).rows);
      expect(audit.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("support can preview drafts but not issue", async () => {
    const d = await db.as(U.support, async (q) => (await q.query("select public.platform_invoice_draft($1, '2026-08') as d", [B])).rows[0].d);
    expect(d.missing).toEqual([]);
    const e = await pgError(db.as(U.support, (q) => q.query("select public.platform_issue_invoice($1, '2026-05')", [B])));
    expect(e.code).toBe("42501");
  });
});

describe("invoiced month guard (0021)", () => {
  it("a month with a valid invoice cannot be re-opened or waived; after cancellation it can", async () => {
    const inv = (await db.admin.query("select id, number from public.invoices where tenant_id = $1 and month = '2026-06' and kind = 'invoice' and cancelled_at is null", [B])).rows[0];
    for (const status of ["open", "waived"]) {
      const e = await pgError(sa((q) => q.query("select public.platform_set_billing_status($1, '2026-06', $2, 'Korrektur Testmonat')", [B, status]), false));
      expect(e.code).toBe("55000");
      expect(e.message).toContain(inv.number);
    }
    const frozen = (await db.admin.query("select status, amount_cents from public.billing_periods where tenant_id = $1 and month = '2026-06'", [B])).rows[0];
    expect(frozen).toEqual({ status: "invoiced", amount_cents: 500 });
    await sa((q) => q.query("select public.platform_set_billing_status($1, '2026-06', 'paid', 'Zahlung eingegangen')", [B]));
    await sa((q) => q.query("select public.platform_cancel_invoice($1, 'Monat wird neu berechnet')", [inv.id]));
    await sa((q) => q.query("select public.platform_set_billing_status($1, '2026-06', 'open', 'Monat wird neu berechnet')", [B]));
    const p = (await db.admin.query("select status, amount_cents from public.billing_periods where tenant_id = $1 and month = '2026-06'", [B])).rows[0];
    expect(p).toEqual({ status: "open", amount_cents: null });
  });
});

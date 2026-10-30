/**
 * Invoices and blocked customers through the HTTP API (migrations 0018/0019).
 * Tenant B (monthly plan 6,50 € gross, no plan chosen – 0023) is moved back to June 2026 so that past months are billable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const c: Record<string, string> = {};
const B = IDS.tenantB;
const A = IDS.tenantA;

beforeAll(async () => {
  t = await startTestServer();
  await t.db.admin.query("update public.tenants set created_at = '2026-06-01 00:00 Europe/Berlin' where id = $1", [B]);
  await t.db.admin.query("update public.employee_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [B]);
  await t.db.admin.query("update public.tenant_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [B]);
  for (const who of ["ownerA", "managerA", "ownerB", "empB", "superAdmin", "support"] as const) c[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
});

const call = (who: string, method: string, path: string, body?: unknown) => t.call(method, path, { cookie: c[who], body });

describe("invoice settings", () => {
  it("platform staff read; only super-admins write (reason, validation)", async () => {
    const r = await call("support", "GET", "/api/platform/invoice-settings");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ vatRatePercent: 19, vatRateConfirmed: false, paymentTermsDays: 14, numberPrefix: "SW" });
    expect(r.body.missing.length).toBe(3);
    expect((await call("ownerB", "GET", "/api/platform/invoice-settings")).status).toBe(403);
    expect((await call("support", "PUT", "/api/platform/invoice-settings", { issuerName: "X", reason: "Test" })).status).toBe(403);
    expect((await call("superAdmin", "PUT", "/api/platform/invoice-settings", { issuerName: "X" })).status).toBe(400);
    expect((await call("superAdmin", "PUT", "/api/platform/invoice-settings", { vatRatePercent: 120, reason: "Test" })).status).toBe(400);
    expect((await call("superAdmin", "PUT", "/api/platform/invoice-settings", { iban: "DE00", reason: "Test" })).status).toBe(400);
  });
});

describe("invoices", () => {
  let invoiceId = "";

  it("draft without number lists the missing data; issuing is refused until complete", async () => {
    const d = await call("superAdmin", "GET", `/api/platform/tenants/${B}/invoices/2026-07/draft`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ draft: true, number: null, netCents: 546, vatCents: 104, grossCents: 650, vatRatePercent: 19 });
    expect(d.body.missing).toContain("Steuernummer oder USt-IdNr.");
    const e = await call("superAdmin", "POST", `/api/platform/tenants/${B}/invoices/2026-07`, {});
    expect(e.status).toBe(409);
    expect(e.body.error.message).toContain("Pflichtangaben fehlen");
  });

  it("super-admin issues an invoice; the owner sees it, nobody else", async () => {
    const s = await call("superAdmin", "PUT", "/api/platform/invoice-settings", {
      issuerName: "Beispiel Software GmbH (Testdaten)", issuerStreet: "Musterstraße 1", issuerPostalCode: "52062", issuerCity: "Aachen",
      vatId: "DE123456789", paymentTermsDays: 30, reason: "Absender erfasst",
    });
    expect(s.status).toBe(200);
    expect(s.body.missing).toEqual([]);
    expect((await call("support", "POST", `/api/platform/tenants/${B}/invoices/2026-07`, {})).status).toBe(403);
    const r = await call("superAdmin", "POST", `/api/platform/tenants/${B}/invoices/2026-07`, {});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: "invoice", number: `SW-${new Date().getFullYear()}-000001`, month: "2026-07", netCents: 546, vatCents: 104,
      grossCents: 650, paymentTermsDays: 30, servicePeriodStart: "2026-07-01", servicePeriodEnd: "2026-07-31", tenantName: "Muster Pflegedienst GmbH" });
    expect(r.body.recipient).toMatchObject({ street: "Musterallee 99" });
    expect(r.body.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    invoiceId = r.body.id;

    const own = await call("ownerB", "GET", `/api/tenants/${B}/invoices`);
    expect(own.status).toBe(200);
    expect(own.body.map((i: { number: string }) => i.number)).toEqual([r.body.number]);
    expect((await call("empB", "GET", `/api/tenants/${B}/invoices`)).status).toBe(403);
    expect((await call("ownerA", "GET", `/api/tenants/${B}/invoices`)).status).toBe(403);
    expect((await call("managerA", "GET", `/api/tenants/${A}/invoices`)).status).toBe(403);
    expect((await call("ownerB", "GET", "/api/platform/invoices")).status).toBe(403);
    const all = await call("support", "GET", `/api/platform/invoices?tenantId=${B}`);
    expect(all.body).toHaveLength(1);
    expect(JSON.stringify(all.body)).not.toMatch(/Charlie|Dana/);

    const rev = await call("superAdmin", "GET", "/api/platform/billing?month=2026-07");
    expect(rev.body.rows.find((x: { tenantId: string }) => x.tenantId === B)).toMatchObject({ status: "invoiced", final: true });
  });

  it("cancellation gets its own number; the original stays", async () => {
    expect((await call("superAdmin", "POST", `/api/platform/invoices/${invoiceId}/cancel`, { reason: "x" })).status).toBe(400);
    const r = await call("superAdmin", "POST", `/api/platform/invoices/${invoiceId}/cancel`, { reason: "Falsche Anschrift" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: "cancellation", netCents: -546, grossCents: -650, cancelsInvoiceId: invoiceId, cancelReason: "Falsche Anschrift" });
    expect(r.body.cancelsInvoiceNumber).toMatch(/000001$/);
    expect(r.body.number).toMatch(/000002$/);
    const list = await call("superAdmin", "GET", `/api/platform/invoices?month=2026-07`);
    expect(list.body).toHaveLength(2);
    expect(list.body.find((i: { id: string }) => i.id === invoiceId).cancelledAt).toBeTruthy();
    expect((await call("superAdmin", "POST", `/api/platform/invoices/${invoiceId}/cancel`, { reason: "Nochmal storniert" })).status).toBe(409);
  });
});

describe("blocked customers", () => {
  it("revenue shows the block with reason; the customer page shows the block without reason", async () => {
    await t.db.admin.query("delete from public.tenant_status_history where tenant_id = $1", [B]);
    await t.db.admin.query(
      `insert into public.tenant_status_history (tenant_id, status, valid_from, valid_to, reason) values
        ($1, 'active', '2026-06-01 00:00 Europe/Berlin', '2026-08-10 09:00 Europe/Berlin', null),
        ($1, 'suspended', '2026-08-10 09:00 Europe/Berlin', '2026-10-02 08:00 Europe/Berlin', 'Offene Rechnung'),
        ($1, 'active', '2026-10-02 08:00 Europe/Berlin', null, null)`, [B]);
    const rev = await call("superAdmin", "GET", "/api/platform/billing?month=2026-09");
    const row = rev.body.rows.find((x: { tenantId: string }) => x.tenantId === B);
    expect(row).toMatchObject({ condition: "tenant_suspended", amountCents: 0, blockReason: "Offene Rechnung" });
    expect(row.blockSince).toBeTruthy();
    expect(rev.body.rows.find((x: { tenantId: string }) => x.tenantId === A).blockSince).toBeNull();
    const aug = await call("superAdmin", "GET", "/api/platform/billing?month=2026-08");
    expect(aug.body.rows.find((x: { tenantId: string }) => x.tenantId === B).condition).toBe("monthly");
    const own = await call("ownerB", "GET", `/api/tenants/${B}/billing?month=2026-09`);
    expect(own.body).toMatchObject({ condition: "tenant_suspended", amountCents: 0, tenantBlock: { status: "suspended" } });
    expect(JSON.stringify(own.body)).not.toContain("Offene Rechnung");
    const e = await call("superAdmin", "POST", `/api/platform/tenants/${B}/invoices/2026-09`, {});
    expect(e.status).toBe(409);
  });
});

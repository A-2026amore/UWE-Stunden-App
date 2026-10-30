/**
 * Invoices and blocked customers in the demo repository (same rules as
 * migrations 0018/0019 and the API).
 */
import { describe, expect, it } from "vitest";
import { AccessDeniedError } from "./repository";
import { DEMO_PASSWORD, DEMO_TENANT_IDS, createDemoRepository, demoMonths, memoryStorage } from "./demo";

const NOW = new Date("2026-10-26T10:00:00");
const PFLEGE = DEMO_TENANT_IDS.pflege;
const { previous } = demoMonths(NOW);

async function world() {
  const storage = memoryStorage();
  const login = async (email: string) => {
    const repo = createDemoRepository(storage, { now: NOW, sessionKey: `s_${email}` });
    await repo.signIn(email, DEMO_PASSWORD);
    return repo;
  };
  return { admin: await login("admin@plattform.example"), support: await login("support@plattform.example"),
    petra: await login("leitung@muster-pflege.example"), chef: await login("chef@demo-kt.example") };
}

describe("invoices (demo)", () => {
  it("draft, issue with gapless numbers, one per month, cancellation with own number", async () => {
    const w = await world();
    const settings = await w.admin.getInvoiceSettings();
    expect(settings).toMatchObject({ vatRatePercent: 19, vatRateConfirmed: false, paymentTermsDays: 14, numberPrefix: "SW", missing: [] });
    const draft = await w.admin.getInvoiceDraft(PFLEGE, previous);
    expect(draft.number).toBeNull();
    expect(draft.netCents).toBeGreaterThan(0);
    expect(draft.grossCents).toBe(draft.netCents + draft.vatCents);

    await expect(w.support.issueInvoice(PFLEGE, previous)).rejects.toBeInstanceOf(AccessDeniedError);
    const inv = await w.admin.issueInvoice(PFLEGE, previous);
    expect(inv.number).toBe("SW-2026-000001");
    expect(inv.lines[0]).toMatchObject({ quantity: draft.lines[0]!.quantity, unitPriceCents: 650 }); // monthly plan (0023)
    expect((await w.admin.getPlatformRevenue(previous)).rows.find((r) => r.tenantId === PFLEGE)!.status).toBe("invoiced");
    await expect(w.admin.issueInvoice(PFLEGE, previous)).rejects.toThrow("bereits die Rechnung");
    // like 0021: no re-opening or waiving while a valid invoice exists
    await expect(w.admin.setBillingStatus(PFLEGE, previous, "open", "Neu berechnen")).rejects.toThrow("Bitte zuerst stornieren");
    await expect(w.admin.setBillingStatus(PFLEGE, previous, "waived", "Kulanz")).rejects.toThrow("Bitte zuerst stornieren");

    await expect(w.admin.cancelInvoice(inv.id, "kurz")).rejects.toThrow("mind. 5 Zeichen");
    const c = await w.admin.cancelInvoice(inv.id, "Falsche Anschrift");
    expect(c).toMatchObject({ kind: "cancellation", number: "SW-2026-000002", netCents: -inv.netCents, cancelsInvoiceNumber: inv.number });
    const again = await w.admin.issueInvoice(PFLEGE, previous);
    expect(again.number).toBe("SW-2026-000003");
    expect((await w.admin.listInvoices()).map((i) => i.number)).toEqual(["SW-2026-000003", "SW-2026-000002", "SW-2026-000001"]);
  });

  it("missing mandatory data: only a draft; the owner sees own invoices only", async () => {
    const w = await world();
    await expect(w.support.updateInvoiceSettings({ taxNumber: null }, "Test")).rejects.toBeInstanceOf(AccessDeniedError);
    const s = await w.admin.updateInvoiceSettings({ taxNumber: null, vatId: null }, "Steuernummer fehlt noch");
    expect(s.missing).toEqual(["Steuernummer oder USt-IdNr."]);
    expect((await w.admin.getInvoiceDraft(PFLEGE, previous)).missing).toEqual(["Steuernummer oder USt-IdNr."]);
    await expect(w.admin.issueInvoice(PFLEGE, previous)).rejects.toThrow("Pflichtangaben fehlen");
    await w.admin.updateInvoiceSettings({ vatId: "DE000000000" }, "USt-IdNr. ergänzt");
    await w.admin.issueInvoice(PFLEGE, previous);
    const own = await w.petra.listTenantInvoices(PFLEGE);
    expect(own).toHaveLength(1);
    await expect(w.chef.listTenantInvoices(PFLEGE)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(w.petra.listInvoices()).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("blocked customers (demo)", () => {
  it("a customer suspended now is billed for the current month; the condition shows the block for following months", async () => {
    const w = await world();
    await w.admin.setTenantStatus(PFLEGE, "suspended", "Offene Rechnung");
    const rev = await w.admin.getPlatformRevenue(previous);
    expect(rev.rows.find((r) => r.tenantId === PFLEGE)!.condition).not.toMatch(/^tenant_/);
  });
});

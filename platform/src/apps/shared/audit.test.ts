import { describe, expect, it } from "vitest";
import { auditLabel } from "./audit";

const ev = (action: string, entity: string, before: unknown, after: unknown) => ({ action, entity, before, after });

describe("auditLabel", () => {
  it("uses the semantic demo action names", () => {
    expect(auditLabel(ev("tenant.status_deactivated", "tenant", { status: "active" }, { status: "deactivated" }))).toBe("Mandant deaktiviert");
    expect(auditLabel(ev("license.updated", "license", null, null))).toBe("Lizenz geändert");
  });

  it("derives labels of generic API row events from before/after", () => {
    expect(auditLabel(ev("tenant.insert", "tenant", null, { status: "active" }))).toBe("Mandant angelegt");
    expect(auditLabel(ev("tenant.update", "tenant", { status: "active", name: "A" }, { status: "suspended", name: "A" }))).toBe("Mandant gesperrt");
    expect(auditLabel(ev("tenant.update", "tenant", { status: "suspended" }, { status: "deactivated" }))).toBe("Mandant deaktiviert");
    expect(auditLabel(ev("tenant.update", "tenant", { status: "pending" }, { status: "active" }))).toBe("Mandant aktiviert");
    expect(auditLabel(ev("tenant.update", "tenant", { status: "active", name: "A" }, { status: "active", name: "B" }))).toBe("Firmenname geändert");
    expect(auditLabel(ev("tenant.update", "tenant", { contact: { city: "A" } }, { contact: { city: "B" } }))).toBe("Kontaktdaten geändert");
    expect(auditLabel(ev("license.insert", "license", null, {}))).toBe("Lizenz angelegt");
    expect(auditLabel(ev("license.update", "license", {}, {}))).toBe("Lizenz geändert");
    expect(auditLabel(ev("employee.update", "employee", { status: "active" }, { status: "locked" }))).toBe("Zugang gesperrt");
    expect(auditLabel(ev("employee.update", "employee", { status: "locked" }, { status: "active" }))).toBe("Zugang entsperrt");
    expect(auditLabel(ev("employee.update", "employee", { status: "invited" }, { status: "active" }))).toBe("Erste Anmeldung");
    expect(auditLabel(ev("invitation.insert", "invitation", null, {}))).toBe("Einladung erstellt");
    expect(auditLabel(ev("invitation.update", "invitation", { revoked_at: null }, { revoked_at: "2026-11-20" }))).toBe("Einladung ungültig (ersetzt)");
    expect(auditLabel(ev("support_access_grant.insert", "support_access_grant", null, {}))).toBe("Supportzugriff freigegeben");
    expect(auditLabel(ev("billing_period.status", "billing_period", null, null))).toBe("Abrechnungsstatus geändert");
    expect(auditLabel(ev("something.else", "other", null, null))).toBe("something.else");
  });
});

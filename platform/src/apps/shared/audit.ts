import type { AuditEvent } from "../../core/types";

/** German labels for audit actions (Chef-Portal and Super-Admin). */
export const ACTION_LABEL: Record<string, string> = {
  "time_entry.corrected": "Arbeitszeit korrigiert",
  "time_entry.updated": "Arbeitszeit geändert (Mitarbeiter)",
  "time_entry.deleted": "Arbeitszeit gelöscht",
  "time_entry.created_by_manager": "Arbeitszeit nachgetragen",
  "time_entry.correction": "Arbeitszeit korrigiert",
  "correction_request.created": "Korrekturanfrage gestellt",
  "correction_request.create": "Korrekturanfrage gestellt",
  "correction_request.accepted": "Korrekturanfrage angenommen",
  "correction_request.accept": "Korrekturanfrage angenommen",
  "correction_request.rejected": "Korrekturanfrage abgelehnt",
  "correction_request.reject": "Korrekturanfrage abgelehnt",
  "correction_request.withdrawn": "Korrekturanfrage zurückgezogen",
  "correction_request.withdraw": "Korrekturanfrage zurückgezogen",
  "employee.invited": "Mitarbeiter eingeladen",
  "employee.updated": "Mitarbeiter geändert",
  "employee.activated": "Zugang aktiviert",
  "employee.deactivated": "Zugang deaktiviert",
  "employee.activated_by_login": "Erste Anmeldung",
  "employee.locked": "Zugang gesperrt",
  "employee.unlocked": "Zugang entsperrt",
  "allocation.set": "Kontoaufteilung gespeichert",
  "allocation.approved": "Kontoaufteilung bestätigt",
  "allocation.rejected": "Kontoaufteilung abgelehnt",
  "statement.submitted": "Monatsnachweis eingereicht",
  "statement.approved": "Monatsnachweis freigegeben",
  "statement.returned": "Monatsnachweis zurückgegeben",
  "tenant.branding_updated": "Logo/Farben geändert",
  "tenant.contact_updated": "Kontaktdaten geändert",
  "tenant.settings_updated": "Einstellungen geändert",
  "tenant.created": "Mandant angelegt",
  "tenant.status_active": "Mandant aktiviert",
  "tenant.status_suspended": "Mandant gesperrt",
  "tenant.status_deactivated": "Mandant deaktiviert",
  "tenant.status_pending": "Mandant in Vorbereitung gesetzt",
  "tenant.renamed": "Firmenname geändert",
  "tenant.two_factor_policy_updated": "Zwei-Faktor-Pflicht geändert",
  "invitation.created": "Einladung erstellt",
  "statement.submit": "Monatsnachweis eingereicht",
  "statement.approve": "Monatsnachweis freigegeben",
  "statement.return": "Monatsnachweis zurückgegeben",
  "statement.reopen": "Monatsnachweis wieder geöffnet",
  "invoice.issue": "Rechnung erzeugt",
  "invoice.cancel": "Rechnung storniert",
  "invoice_settings.update": "Rechnungsangaben geändert",
  "promo_code.create": "Aktionscode angelegt",
  "promo_code.end": "Aktionscode beendet",
  "promo.redeem": "Aktionscode eingelöst",
  "promo.end": "Aktionsrabatt beendet",
  "license.created": "Lizenz angelegt",
  "license.updated": "Lizenz geändert",
  "support_grant.granted": "Supportzugriff freigegeben",
  "support_grant.revoked": "Supportzugriff beendet",
  "billing_period.status": "Abrechnungsstatus geändert",
  "billing_settings.default_price": "Standardpreis geändert",
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const changed = (b: Obj, a: Obj, key: string) => JSON.stringify(b[key] ?? null) !== JSON.stringify(a[key] ?? null);

const TENANT_STATUS_ACTION: Record<string, string> = {
  active: "Mandant aktiviert", suspended: "Mandant gesperrt", deactivated: "Mandant deaktiviert", pending: "Mandant in Vorbereitung gesetzt",
};
const EMPLOYEE_STATUS_ACTION: Record<string, string> = {
  locked: "Zugang gesperrt", deactivated: "Zugang deaktiviert",
};

/**
 * German label of an audit event. Demo events carry semantic action names
 * (ACTION_LABEL); the API writes generic row events ("tenant.update",
 * "license.insert", …) – their meaning is derived from before/after.
 */
export function auditLabel(e: Pick<AuditEvent, "action" | "entity" | "before" | "after">): string {
  const known = ACTION_LABEL[e.action];
  if (known) return known;
  const b = obj(e.before);
  const a = obj(e.after);
  const op = e.action.slice(e.action.lastIndexOf(".") + 1);
  switch (e.entity) {
    case "tenant":
      if (op === "insert") return "Mandant angelegt";
      if (changed(b, a, "status")) return TENANT_STATUS_ACTION[String(a.status)] ?? "Mandantenstatus geändert";
      if (changed(b, a, "name")) return "Firmenname geändert";
      if (changed(b, a, "branding")) return "Logo/Farben geändert";
      if (changed(b, a, "contact")) return "Kontaktdaten geändert";
      if (changed(b, a, "settings")) return "Einstellungen geändert";
      return "Mandant geändert";
    case "license":
      return op === "insert" ? "Lizenz angelegt" : "Lizenz geändert";
    case "employee":
      if (op === "insert") return "Mitarbeiter eingeladen";
      if (changed(b, a, "status")) {
        if (a.status === "active") return b.status === "invited" ? "Erste Anmeldung" : b.status === "locked" ? "Zugang entsperrt" : "Zugang aktiviert";
        return EMPLOYEE_STATUS_ACTION[String(a.status)] ?? "Status geändert";
      }
      return "Mitarbeiter geändert";
    case "invitation":
      if (op === "insert") return "Einladung erstellt";
      if (a.accepted_at && !b.accepted_at) return "Einladung angenommen";
      if (a.revoked_at && !b.revoked_at) return "Einladung ungültig (ersetzt)";
      return "Einladung geändert";
    case "support_access_grant":
      return a.revoked_at && !b.revoked_at ? "Supportzugriff beendet" : "Supportzugriff freigegeben";
    case "work_account_allocation":
      if (a.status === "approved" && b.status !== "approved") return "Kontoaufteilung bestätigt";
      if (a.status === "rejected" && b.status !== "rejected") return "Kontoaufteilung abgelehnt";
      return "Kontoaufteilung gespeichert";
    default:
      return e.action;
  }
}

import { useState } from "preact/hooks";
import type { AuditEvent } from "../../../core/types";
import { Alert, Badge, Card, SelectField, Table } from "../../../design";
import { useAsync } from "../../shared/hooks";
import { PLAN_LABEL, dateTimeDE, formatDateDE, hoursLabel, monthLabelDE } from "../../shared/format";

const STATUS_DE: Record<string, string> = { active: "aktiv", deactivated: "deaktiviert", invited: "eingeladen", suspended: "gesperrt", proposed: "zur Prüfung", approved: "bestätigt", rejected: "abgelehnt" };
const de = (v: unknown) => STATUS_DE[String(v)] ?? String(v ?? "—");
import { useChef } from "../context";
import { auditLabel } from "../../shared/audit";
import { CORRECTION_KIND_LABEL, CORRECTION_STATUS_LABEL, valuesLabel } from "../../shared/corrections";
import type { CorrectionKind, CorrectionStatus, EntryValues } from "../../../core/types";


type Shift = { date?: string; start?: string; end?: string; pauseMinutes?: number; note?: string };

function describe(e: AuditEvent): string {
  const b = (e.before ?? {}) as Shift & Record<string, unknown>;
  const a = (e.after ?? {}) as Shift & Record<string, unknown>;
  if (e.entity === "time_entry") {
    const fmt = (s: Shift) => (s.date ? `${formatDateDE(s.date)} ${s.start}–${s.end}, Pause ${s.pauseMinutes} Min.` : "");
    if (e.action === "time_entry.deleted") return `Gelöscht: ${fmt(b)}`;
    if (!e.before) return `Neu: ${fmt(a)}`;
    return `Vorher: ${fmt(b)} → Nachher: ${fmt(a)}`;
  }
  if (e.entity === "correction_request") {
    const kind = CORRECTION_KIND_LABEL[a.kind as CorrectionKind] ?? "";
    const status = CORRECTION_STATUS_LABEL[a.status as CorrectionStatus] ?? "";
    const target = (a.proposed ?? a.before) as EntryValues | null | undefined;
    return `${kind}${target ? `: ${valuesLabel(target)}` : ""} (${status})`;
  }
  if (e.entity === "employee" && "status" in a) return `Status: ${de(b.status)} → ${de(a.status)}`;
  if (e.entity === "allocation") return `${monthLabelDE(String(a.month ?? ""))}: ${hoursLabel(Number(a.minutes ?? 0))} (${de(a.status)})`;
  if (e.entity === "statement") return `${monthLabelDE(String(a.month ?? ""))}: ${hoursLabel(Number(a.workedMinutes ?? 0))}`;
  if (e.entity === "license") return `Lizenz: ${PLAN_LABEL[String(a.plan)] ?? String(a.plan ?? "")}`;
  return "";
}

export function AuditPage() {
  const { repo, tenant, version } = useChef();
  const [filter, setFilter] = useState("all");
  const q = useAsync(async () => {
    const [events, employees] = await Promise.all([repo.listAudit(tenant.id, 500), repo.listEmployees(tenant.id)]);
    return { events, names: new Map(employees.map((e) => [e.id, e.displayName])) };
  }, [version]);

  const events = (q.data?.events ?? []).filter((e) => filter === "all" || e.entity === filter);
  const name = (id: string | null) => (id ? q.data?.names.get(id) ?? (id.startsWith("u-admin") ? "Plattform-Admin" : "System") : "System");
  const subject = (e: AuditEvent) => {
    if (e.entity === "employee") return name(e.entityId);
    const a = (e.after ?? e.before ?? {}) as { employeeId?: string; employee_id?: string };
    if (a.employeeId ?? a.employee_id) return name((a.employeeId ?? a.employee_id)!);
    if (e.entity === "allocation" && e.entityId) return name(e.entityId.split(":")[0] ?? null);
    return "—";
  };

  return (
    <div class="stack">
      <h1 class="page-title">Änderungsprotokoll</h1>
      <Alert tone="info"><p>Alle Korrekturen, Löschungen und Verwaltungsänderungen werden mit Zeitpunkt, handelnder Person, Begründung sowie Vorher-/Nachher-Werten gespeichert. Ursprüngliche Arbeitszeiten werden nie stillschweigend überschrieben.</p></Alert>
      <Card>
        <div class="toolbar">
          <SelectField label="Bereich" value={filter} onValue={setFilter} options={[
            { value: "all", label: "Alle Ereignisse" }, { value: "time_entry", label: "Arbeitszeiten" }, { value: "employee", label: "Mitarbeiter" },
            { value: "statement", label: "Monatsnachweise" }, { value: "allocation", label: "Arbeitszeitkonto" }, { value: "correction_request", label: "Korrekturanfragen" }, { value: "tenant", label: "Firma & Einstellungen" },
            { value: "license", label: "Lizenz" }, { value: "support_grant", label: "Supportzugriff" },
          ]} />
          <p class="muted small mb-0">{events.length} Einträge</p>
        </div>
        {q.error && <Alert tone="danger" live>{q.error}</Alert>}
        <Table<AuditEvent>
          caption="Änderungsprotokoll"
          rows={events}
          rowKey={(e) => e.id}
          empty={<p class="muted">Keine Einträge.</p>}
          columns={[
            { key: "t", header: "Zeitpunkt", render: (e) => <span class="small nowrap">{dateTimeDE(e.createdAt)}</span> },
            { key: "a", header: "Aktion", render: (e) => <Badge tone={e.action.includes("deleted") || e.action.includes("deactivated") || e.action.includes("rejected") || e.action.includes("returned") ? "danger" : e.action.includes("corrected") ? "warning" : "neutral"}>{auditLabel(e)}</Badge> },
            { key: "w", header: "Durch", render: (e) => name(e.actorId) },
            { key: "s", header: "Betrifft", render: (e) => subject(e) },
            { key: "d", header: "Details", render: (e) => <span class="small">{describe(e)}</span> },
            { key: "r", header: "Begründung", render: (e) => <span class="small">{e.reason ?? "—"}</span> },
          ]}
        />
      </Card>
    </div>
  );
}

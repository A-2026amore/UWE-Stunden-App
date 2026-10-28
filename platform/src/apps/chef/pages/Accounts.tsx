import { useState } from "preact/hooks";
import type { Employee, MonthAllocation } from "../../../core/types";
import { Alert, Button, Card, EmptyState, LinkButton, StatTile, StatusPill, Table, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { currentMonth, formatDateDE, hoursLabel, monthLabelDE, signedHours } from "../../shared/format";
import { MonthPicker } from "../../shared/MonthPicker";
import { loadTenantMonth, useChef } from "../context";

export function AccountsPage() {
  const { repo, tenant, version, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const policy = tenant.settings.workAccount;
  const [month, setMonth] = useState(currentMonth());
  const q = useAsync(() => loadTenantMonth(repo, tenant, month), [month, version]);

  if (!policy.enabled) {
    return (
      <div class="stack">
        <h1 class="page-title">Arbeitszeitkonten</h1>
        <Card><EmptyState icon="wallet" title="Arbeitszeitkonto nicht aktiviert" action={<LinkButton href="#/einstellungen" variant="primary">Zu den Einstellungen</LinkButton>}>
          Aktivieren Sie das Arbeitszeitkonto in den Einstellungen, damit Mitarbeitende Monatsstunden übertragen können.
        </EmptyState></Card>
      </div>
    );
  }

  const d = q.data;
  const staff = (d?.employees ?? []).filter((e) => e.role === "employee" && e.status !== "invited");
  const pending: Array<{ emp: Employee; a: MonthAllocation }> = [];
  for (const e of d?.employees ?? []) for (const a of d!.allocations.get(e.id) ?? []) if (a.status === "proposed") pending.push({ emp: e, a });
  const cycle = staff.length ? d?.summaries.get(staff[0]!.id)?.cycle : null;
  const total = staff.reduce((s, e) => s + (d?.summaries.get(e.id)?.overallBalanceMinutes ?? 0), 0);

  const review = async (emp: Employee, a: MonthAllocation, decision: "approved" | "rejected") => {
    let reason: string | null = "";
    if (decision === "rejected") {
      reason = await dialogs.askReason({ title: "Aufteilung ablehnen", message: `${emp.displayName}: ${hoursLabel(a.minutes)} aus ${monthLabelDE(a.month)}. Die Stunden werden dann vollständig abgerechnet.`, confirmLabel: "Ablehnen", danger: true });
      if (!reason) return;
    } else {
      const ok = await dialogs.confirm({ title: "Aufteilung bestätigen?", message: `${emp.displayName}: ${hoursLabel(a.minutes)} aus ${monthLabelDE(a.month)} werden dem Arbeitszeitkonto gutgeschrieben.`, confirmLabel: "Bestätigen" });
      if (!ok) return;
    }
    try {
      await repo.reviewAllocation(emp.id, a.month, decision, reason ?? "");
      toast(decision === "approved" ? "Aufteilung bestätigt." : "Aufteilung abgelehnt.");
      changed();
    } catch (e) { toast(errorText(e), "error"); }
  };

  return (
    <div class="stack">
      <h1 class="page-title">Arbeitszeitkonten</h1>
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      <div class="grid-3">
        <StatTile label="Modell" value={policy.model === "school-year" ? "Schuljahr" : "Kalenderjahr"} hint={cycle ? `${cycle.label}: ${formatDateDE(cycle.start)} – ${formatDateDE(cycle.end)}` : undefined} />
        <StatTile label="Startsaldo je Zeitraum" value={signedHours(policy.openingMinutes)} />
        <StatTile label="Summe aller Konten" value={signedHours(total)} tone="brand" hint={`${staff.length} Mitarbeitende`} />
      </div>

      <Card title="Offene Freigaben" accent>
        <Table
          caption="Offene Freigaben"
          rows={pending}
          rowKey={(p) => p.emp.id + p.a.month}
          empty={<p class="muted">Keine offenen Aufteilungen.</p>}
          columns={[
            { key: "n", header: "Mitarbeiter", render: (p) => p.emp.displayName },
            { key: "m", header: "Monat", render: (p) => monthLabelDE(p.a.month) },
            { key: "h", header: "Vorschlag", align: "right", render: (p) => <span class="num">{hoursLabel(p.a.minutes)}</span> },
            { key: "a", header: "Aktionen", actions: true, render: (p) => (
              <div class="btn-row" style={{ justifyContent: "flex-end" }}>
                <Button size="sm" icon="check" onClick={() => review(p.emp, p.a, "approved")} aria-label={`Aufteilung von ${p.emp.displayName} bestätigen`}>Bestätigen</Button>
                <Button size="sm" variant="secondary" icon="x" onClick={() => review(p.emp, p.a, "rejected")} aria-label={`Aufteilung von ${p.emp.displayName} ablehnen`}>Ablehnen</Button>
              </div>
            ) },
          ]}
        />
      </Card>

      <Card title="Kontostände" actions={<MonthPicker month={month} onChange={setMonth} />}>
        <Table<Employee>
          caption={`Kontostände ${monthLabelDE(month)}`}
          rows={staff}
          rowKey={(e) => e.id}
          empty={<p class="muted">Keine Mitarbeitenden.</p>}
          columns={[
            { key: "n", header: "Mitarbeiter", render: (e) => <strong>{e.displayName}</strong> },
            { key: "w", header: `Geleistet ${monthLabelDE(month)}`, label: "Geleistet", align: "right", render: (e) => <span class="num">{hoursLabel(d?.summaries.get(e.id)?.workedMinutes ?? 0)}</span> },
            { key: "a", header: "Ins Konto (Monat)", align: "right", render: (e) => {
              const s = d?.summaries.get(e.id);
              return <span class="num">{hoursLabel(s?.allocatedMinutes ?? 0)}{s?.allocation && s.allocation.status !== "approved" && <> <StatusPill status={s.allocation.status} /></>}</span>;
            } },
            { key: "b", header: "Kontostand", align: "right", render: (e) => { const v = d?.summaries.get(e.id)?.overallBalanceMinutes; return <span class="num"><strong>{v == null ? "—" : signedHours(v)}</strong></span>; } },
            ...(policy.openingMinutes < 0 ? [{ key: "r", header: "Noch bis Null", align: "right" as const, render: (e: Employee) => <span class="num">{hoursLabel(d?.summaries.get(e.id)?.remainingToZeroMinutes ?? 0)}</span> }] : []),
          ]}
        />
        <p class="muted small" style={{ marginTop: "var(--space-3)" }}>Das Arbeitszeitkonto ist eine betriebliche Planungshilfe. Kontostände sind keine automatische Grundlage für Auszahlung oder Verrechnung.</p>
      </Card>
    </div>
  );
}

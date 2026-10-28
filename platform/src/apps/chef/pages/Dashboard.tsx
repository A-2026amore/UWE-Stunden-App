import { activeShifts } from "../../../core/time";
import { Alert, Card, LinkButton, StatTile, StatusPill, Table } from "../../../design";
import { useAsync } from "../../shared/hooks";
import { currentMonth, hoursLabel, monthLabelDE, signedHours } from "../../shared/format";
import { shiftMonth } from "../../../data/demo";
import { workedMinutesInMonth } from "../../../core/workAccount";
import { loadTenantMonth, useChef } from "../context";
import { DemoBanner } from "../../shared/ui";
import { IS_DEMO } from "../../shared/repo";

export function DashboardPage() {
  const { repo, tenant, version } = useChef();
  const month = currentMonth();
  const prev = shiftMonth(month, -1);
  const policy = tenant.settings.workAccount;

  const q = useAsync(async () => {
    const [data, stCur, stPrev] = await Promise.all([
      loadTenantMonth(repo, tenant, month), repo.listStatements(tenant.id, month), repo.listStatements(tenant.id, prev),
    ]);
    return { data, statements: [...stPrev, ...stCur] };
  }, [version, tenant.id]);

  if (q.error) return <Alert tone="danger" live>{q.error}</Alert>;
  const d = q.data?.data;
  const staff = d?.employees.filter((e) => e.status !== "deactivated") ?? [];
  const active = staff.filter((e) => e.status === "active");
  const worked = d ? workedMinutesInMonth(activeShifts(d.entries), month) : 0;
  let billing = 0;
  let accountTotal = 0;
  let allocatedTotal = 0;
  const pendingAllocations: Array<{ name: string; month: string; minutes: number }> = [];
  for (const e of d?.employees ?? []) {
    const s = d!.summaries.get(e.id);
    billing += s?.billingMinutes ?? 0;
    allocatedTotal += s?.allocatedMinutes ?? 0;
    if (policy.enabled && s?.overallBalanceMinutes != null && e.role === "employee" && e.status !== "deactivated") accountTotal += s.overallBalanceMinutes;
    for (const a of d!.allocations.get(e.id) ?? []) if (a.status === "proposed") pendingAllocations.push({ name: e.displayName, month: a.month, minutes: a.minutes });
  }
  const openStatements = (q.data?.statements ?? []).filter((s) => s.status === "submitted");
  const nameOf = (id: string) => d?.employees.find((e) => e.id === id)?.displayName ?? "—";

  return (
    <div class="stack">
      <div class="row-between">
        <div>
          <h1 class="page-title">Dashboard</h1>
          <p class="muted page-sub">{tenant.name} · {monthLabelDE(month)}</p>
        </div>
        <LinkButton href="#/mitarbeiter" icon="plus" variant="primary">Mitarbeiter einladen</LinkButton>
      </div>
      {IS_DEMO && tenant.isDemo && <DemoBanner />}
      <div class="grid-4">
        <StatTile label="Mitarbeitende" value={staff.length} hint={`${active.length} aktiv, ${staff.length - active.length} eingeladen`} />
        <StatTile label={`Geleistete Stunden ${monthLabelDE(month)}`} value={hoursLabel(worked)} tone="brand" />
        <StatTile label="Für Abrechnung vorgesehen" value={hoursLabel(billing)} hint={policy.enabled ? `${hoursLabel(allocatedTotal)} ins Arbeitszeitkonto` : undefined} />
        <StatTile label="Offene Monatsnachweise" value={openStatements.length} tone={openStatements.length ? "warning" : "default"} hint="eingereicht, warten auf Prüfung" />
        {policy.enabled && <StatTile label="Summe Arbeitszeitkonten" value={signedHours(accountTotal)} hint="aktueller Zeitraum, alle Mitarbeitenden" />}
        {policy.enabled && <StatTile label="Offene Freigaben Arbeitszeitkonto" value={pendingAllocations.length} tone={pendingAllocations.length ? "warning" : "default"} />}
      </div>

      <div class="grid-2">
        <Card title="Monatsnachweise zur Prüfung" actions={<LinkButton href="#/nachweise" size="sm">Alle Nachweise</LinkButton>}>
          <Table
            caption="Offene Monatsnachweise"
            rows={openStatements}
            rowKey={(s) => s.id}
            empty={<p class="muted">Keine offenen Monatsnachweise.</p>}
            columns={[
              { key: "n", header: "Mitarbeiter", render: (s) => nameOf(s.employeeId) },
              { key: "m", header: "Monat", render: (s) => monthLabelDE(s.month) },
              { key: "h", header: "Stunden", align: "right", render: (s) => <span class="num">{hoursLabel(s.workedMinutes)}</span> },
              { key: "s", header: "Status", render: (s) => <StatusPill status={s.status} /> },
            ]}
          />
        </Card>
        <Card title="Arbeitszeitkonto: offene Freigaben" actions={policy.enabled ? <LinkButton href="#/konten" size="sm">Zu den Konten</LinkButton> : undefined}>
          {!policy.enabled ? <p class="muted">Das Arbeitszeitkonto ist nicht aktiviert.</p> : (
            <Table
              caption="Offene Freigaben"
              rows={pendingAllocations}
              rowKey={(a) => a.name + a.month}
              empty={<p class="muted">Keine offenen Freigaben.</p>}
              columns={[
                { key: "n", header: "Mitarbeiter", render: (a) => a.name },
                { key: "m", header: "Monat", render: (a) => monthLabelDE(a.month) },
                { key: "h", header: "Vorschlag", align: "right", render: (a) => <span class="num">{hoursLabel(a.minutes)}</span> },
              ]}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

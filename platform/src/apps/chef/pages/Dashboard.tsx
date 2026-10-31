import { useState } from "preact/hooks";
import { activeShifts } from "../../../core/time";
import { BILLING_CONDITION_LABEL, formatEuro } from "../../../core/billing";
import { Alert, Avatar, Badge, BarChart, Card, LinkButton, Segmented, Skeleton, StatTile, StatusPill, Table } from "../../../design";
import { useAsync } from "../../shared/hooks";
import { currentMonth, formatDateDE, hoursLabel, monthLabelDE, signedHours, todayISO } from "../../shared/format";
import { dailyBars, hoursAxis, weeklyBars } from "../../shared/charts";
import { shiftMonth } from "../../../data/demo";
import { workedMinutesInMonth } from "../../../core/workAccount";
import { loadTenantMonth, useChef } from "../context";
import { DemoBanner } from "../../shared/ui";
import { CORRECTION_KIND_LABEL, requestDate } from "../../shared/corrections";
import { IS_DEMO } from "../../shared/repo";
import { targetState, type EmploymentMonth } from "../../../core/employment";
import { contractText, loadEmploymentOverview, type EmploymentRow } from "../employment";

/** Over / under target of one month as a badge (with the value at the hourly wage). */
function TargetBadge({ m }: { m: EmploymentMonth }) {
  const diff = m.differenceMinutes ?? 0;
  const money = m.contract.hourlyWageCents !== null && diff !== 0 ? ` (${diff > 0 ? "+" : "−"}${formatEuro(Math.round((Math.abs(diff) * m.contract.hourlyWageCents) / 60))})` : "";
  switch (targetState(m)) {
    case "open": return <Badge tone="neutral">ohne Limit</Badge>;
    case "over": return <Badge tone="warning">{signedHours(diff)} zu viel{money}</Badge>;
    case "met": return <Badge tone="success">Soll erreicht</Badge>;
    case "running": return <Badge tone="info">noch {hoursLabel(-diff)} bis Soll</Badge>;
    default: return <Badge tone="danger">{signedHours(diff)} unter Soll{money}</Badge>;
  }
}

/** Soll / Ist of the current month, previous month and the hours account per person (migration 0025). */
function EmploymentCard({ rows, month }: { rows: EmploymentRow[]; month: string }) {
  const prev = shiftMonth(month, -1);
  const withAccount = rows.filter((r) => r.account.hasAccount);
  const total = withAccount.reduce((sum, r) => sum + r.account.balanceMinutes, 0);
  const over = rows.filter((r) => r.account.current && targetState(r.account.current) === "over").length;
  const overLimit = rows.filter((r) => r.account.current?.overMinijobLimit).length;
  return (
    <Card title={`Soll / Ist laut Arbeitsvertrag · ${monthLabelDE(month)}`} actions={<LinkButton href="#/mitarbeiter" size="sm">Verträge bearbeiten</LinkButton>}>
      <div data-testid="employment-overview">
        {withAccount.length > 0 && (
          <p class="mb-0" data-testid="employment-summary">
            Summe Arbeitszeitkonten: <strong class="num">{signedHours(total)}</strong>
            {" · "}{over} über Soll{overLimit > 0 && <> · <Badge tone="danger">{overLimit} über Minijob-Grenze</Badge></>}
          </p>
        )}
        <Table<EmploymentRow>
          caption={`Soll und Ist laut Arbeitsvertrag im ${monthLabelDE(month)}`}
          rows={rows}
          rowKey={(r) => r.employee.id}
          empty={<p class="muted">Noch keine Vertragsdaten hinterlegt. Unter „Mitarbeiter“ → „Bearbeiten“ können Sie Stundenlohn, Vertragsart und Soll-Stunden eintragen.</p>}
          columns={[
            { key: "n", header: "Mitarbeiter", render: (r) => (
              <div style={{ minWidth: "12rem" }}>
                <strong>{r.employee.displayName}</strong>
                <div class="small muted">{contractText(r.account.current?.contract ?? r.versions.at(-1) ?? null)}</div>
              </div>
            ) },
            { key: "i", header: "Ist / Soll", align: "right", render: (r) => r.account.current
              ? <span class="num">{hoursLabel(r.account.current.payableMinutes)} / {r.account.current.targetMinutes === null ? "offen" : hoursLabel(r.account.current.targetMinutes)}</span>
              : <span class="muted small">ab {monthLabelDE(r.versions[0]?.validFrom ?? month)}</span> },
            { key: "d", header: "Differenz", render: (r) => r.account.current ? <TargetBadge m={r.account.current} /> : "—" },
            { key: "p", header: monthLabelDE(prev), align: "right", render: (r) => {
              const p = r.account.months.find((m) => m.month === prev);
              return p && p.differenceMinutes !== null ? <span class="num small">{signedHours(p.differenceMinutes)}</span> : <span class="muted small">—</span>;
            } },
            { key: "k", header: "Arbeitszeitkonto", align: "right", render: (r) => r.account.hasAccount
              ? <strong class="num" data-testid={`employment-balance-${r.employee.id}`}>{signedHours(r.account.balanceMinutes)}</strong>
              : <span class="muted small">—</span> },
            { key: "h", header: "Hinweis", render: (r) => {
              const c = r.account.current;
              if (!c) return null;
              return (
                <div class="stack-sm">
                  {c.earningsCents !== null && <span class="small muted">Lohn Ist: {formatEuro(c.earningsCents)}</span>}
                  {c.overMinijobLimit && <span title={`Minijob-Grenze ${formatEuro(c.minijobLimitCents!)} im Monat`}><Badge tone="danger">über Minijob-Grenze</Badge></span>}
                  {c.belowMinimumWage && <Badge tone="warning">unter Mindestlohn</Badge>}
                </div>
              );
            } },
          ]}
        />
        <p class="muted small mb-0">Mehrstunden kommen sofort ins Arbeitszeitkonto, Minderstunden erst am Monatsende. Ist = abrechenbare Stunden.
          Hinweise zu Mindestlohn und Minijob-Grenze ersetzen keine Lohnabrechnung.</p>
      </div>
    </Card>
  );
}

export function DashboardPage() {
  const { repo, tenant, version } = useChef();
  const month = currentMonth();
  const prev = shiftMonth(month, -1);
  const policy = tenant.settings.workAccount;

  const [chartMode, setChartMode] = useState<"days" | "weeks">("days");
  const q = useAsync(async () => {
    const [data, stCur, stPrev, corrections, billing] = await Promise.all([
      loadTenantMonth(repo, tenant, month), repo.listStatements(tenant.id, month), repo.listStatements(tenant.id, prev),
      repo.listCorrectionRequests(tenant.id, { status: "open" }),
      // Costs are informative only: a failure must not hide the dashboard.
      repo.getTenantBilling(tenant.id, month).catch(() => null),
    ]);
    // Contract data are additional information as well.
    const employment = await loadEmploymentOverview(repo, tenant, month, data.employees).catch(() => null);
    return { data, statements: [...stPrev, ...stCur], corrections, billing, employment };
  }, [version, tenant.id]);

  if (q.error) return <Alert tone="danger" live>{q.error}</Alert>;
  if (!q.data) {
    return (
      <div class="stack">
        <h1 class="page-title">Dashboard</h1>
        <Skeleton cards={4} lines={4} title={false} />
      </div>
    );
  }
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
  const openCorrections = q.data?.corrections ?? [];
  const correctedAfterApproval = (q.data?.statements ?? []).filter((s) => s.correctedAfterApproval);
  const nameOf = (id: string) => d?.employees.find((e) => e.id === id)?.displayName ?? "—";
  const billingInfo = q.data?.billing ?? null;
  const today = todayISO();
  const shifts = d ? d.entries.filter((e) => !e.deletedAt) : [];
  const bars = chartMode === "days" ? dailyBars(shifts, month, today) : weeklyBars(shifts, month, today);
  // Hours per person this month (top list).
  const perPerson = staff
    .map((e) => ({ id: e.id, name: e.displayName, minutes: workedMinutesInMonth(activeShifts(shifts.filter((x) => x.employeeId === e.id)), month) }))
    .filter((p) => p.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
  const maxPerson = Math.max(1, ...perPerson.map((p) => p.minutes));
  const employment = q.data?.employment ?? null;

  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <p class="page-eyebrow">Übersicht</p>
          <h1 class="page-title">Dashboard</h1>
          <p class="muted page-sub">{tenant.name} · {monthLabelDE(month)}</p>
        </div>
        <div class="btn-row">
          <LinkButton href="#/stunden" icon="calendar">Stundenübersicht</LinkButton>
          <LinkButton href="#/mitarbeiter" icon="plus" variant="primary">Mitarbeiter einladen</LinkButton>
        </div>
      </div>
      {IS_DEMO && tenant.isDemo && <DemoBanner />}
      <div class="kpi-grid" data-testid="dashboard-kpis">
        <StatTile icon="clock" href="#/stunden" label={`Geleistete Stunden ${monthLabelDE(month)}`} value={hoursLabel(worked)} tone="brand"
          hint={`Für Abrechnung vorgesehen: ${hoursLabel(billing)}`} />
        <StatTile icon="fileCheck" href={openStatements.length ? `#/nachweise?m=${openStatements[0]!.month}` : "#/nachweise"} label="Offene Monatsnachweise" value={openStatements.length} tone={openStatements.length ? "warning" : "default"} hint="eingereicht, warten auf Prüfung" />
        <StatTile icon="message" href="#/korrekturen" label="Offene Korrekturanfragen" value={openCorrections.length} tone={openCorrections.length ? "warning" : "default"} hint="warten auf Entscheidung" />
        <StatTile icon="users" href="#/mitarbeiter" label="Mitarbeitende" value={staff.length} hint={`${active.length} aktiv, ${staff.length - active.length} eingeladen`} />
        <StatTile icon="creditCard" href="#/abrechnung" label={`Kosten ${monthLabelDE(month)}`} value={billingInfo ? formatEuro(billingInfo.amountCents) : "—"}
          hint={billingInfo ? `inkl. USt. · ${billingInfo.billableCount} abrechenbar · ${BILLING_CONDITION_LABEL[billingInfo.condition]}` : "nicht verfügbar"} />
      </div>

      <div class="dash-grid">
        <Card title={`Stunden je ${chartMode === "days" ? "Tag" : "Woche"} · ${monthLabelDE(month)}`}
          actions={<Segmented label="Zeitraum des Diagramms" value={chartMode} onChange={setChartMode} options={[{ key: "days", label: "Tage" }, { key: "weeks", label: "Wochen" }]} />}>
          <BarChart data={bars} formatValue={hoursAxis} label={`Geleistete Stunden je ${chartMode === "days" ? "Tag" : "Kalenderwoche"} im ${monthLabelDE(month)}, alle Mitarbeitenden`}
            legend={chartMode === "days"
              ? <><span>Werktag</span><span class="legend-muted">Wochenende</span><span class="legend-today">Heute</span></>
              : <><span>Kalenderwoche</span><span class="legend-today">Aktuelle Woche</span></>} />
        </Card>
        <Card title="Stunden je Person" actions={<LinkButton href="#/stunden" size="sm">Details</LinkButton>}>
          {perPerson.length === 0 ? <p class="muted mb-0">In diesem Monat wurden noch keine Zeiten erfasst.</p> : (
            <ul class="list-plain person-bars">
              {perPerson.slice(0, 6).map((p) => (
                <li key={p.id}>
                  <Avatar name={p.name} small />
                  <div class="person-bar-main">
                    <div class="row-between"><span class="person-name">{p.name}</span><span class="num small">{hoursLabel(p.minutes)}</span></div>
                    <div class="person-bar" aria-hidden="true"><span style={{ width: `${Math.max(3, (p.minutes / maxPerson) * 100)}%` }} /></div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>


      {employment && <EmploymentCard rows={employment} month={month} />}

      {correctedAfterApproval.length > 0 && (
        <Alert tone="warning" title="Nach Freigabe korrigiert">
          <p>{correctedAfterApproval.map((s) => `${nameOf(s.employeeId)} (${monthLabelDE(s.month)})`).join(", ")}: Einträge wurden nach der Freigabe korrigiert.
            Die freigegebenen Zahlen werden nicht automatisch angepasst. <a href="#/nachweise">Zu den Monatsnachweisen</a></p>
        </Alert>
      )}

      <div class="dash-cards">
        <Card title="Offene Korrekturanfragen" actions={<LinkButton href="#/korrekturen" size="sm">Alle Anfragen</LinkButton>}>
          <Table
            caption="Offene Korrekturanfragen"
            rows={openCorrections.slice(0, 8)}
            rowKey={(r) => r.id}
            empty={<p class="muted">Keine offenen Korrekturanfragen.</p>}
            columns={[
              { key: "n", header: "Mitarbeiter", render: (r) => nameOf(r.employeeId) },
              { key: "k", header: "Art", render: (r) => CORRECTION_KIND_LABEL[r.kind] },
              { key: "d", header: "Einsatz", render: (r) => formatDateDE(requestDate(r)) },
            ]}
          />
        </Card>
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
          {!policy.enabled ? <p class="muted">Das Arbeitszeitkonto ist nicht aktiviert.</p> : (<div class="stack">
            <div class="grid-2 dash-mini">
              <StatTile label="Summe Arbeitszeitkonten" value={signedHours(accountTotal)} hint="aktueller Zeitraum, alle Mitarbeitenden" />
              <StatTile label="Offene Freigaben Arbeitszeitkonto" value={pendingAllocations.length} tone={pendingAllocations.length ? "warning" : "default"}
                hint={`${hoursLabel(allocatedTotal)} übertragen`} />
            </div>
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
          </div>)}
        </Card>
      </div>
    </div>
  );
}

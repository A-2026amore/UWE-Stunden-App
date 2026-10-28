/**
 * Stundenübersicht: hours per employee and month.
 *  - "Alle Mitarbeitenden": one row per person with days, worked hours,
 *    work account, billing hours and the status of the monthly statement;
 *  - one employee: every day with shifts, pause and hours, the sums and the
 *    statement (approve / return directly here).
 * Exports: PDF timesheet (multi-page, core/pdf) and CSV (sums or shifts).
 */
import { useEffect, useState } from "preact/hooks";
import { errorsForMonth } from "../../../core/breaks";
import { activeShifts, isValidMonth } from "../../../core/time";
import type { Employee } from "../../../core/types";
import { Alert, Badge, Button, Card, EmptyState, SelectField, StatTile, StatusPill, Table } from "../../../design";
import { useToast } from "../../../design";
import { dayRows, employeeMonthRows, monthSummaryCsv, timeEntriesCsv, STATEMENT_STATUS_LABEL, type DayRow, type EmployeeMonthRow } from "../../shared/exports";
import { currentMonth, dateTimeDE, downloadBlob, formatDateDE, hoursLabel, monthLabelDE, signedHours, weekdayShort } from "../../shared/format";
import { errorText, useAsync } from "../../shared/hooks";
import { MonthPicker } from "../../shared/MonthPicker";
import { buildStatementWithLogo } from "../../shared/statement";
import { loadTenantMonth, useChef } from "../context";
import { useStatementActions } from "../statementActions";

export function HoursPage({ initialMonth, initialEmployee }: { initialMonth: string | null; initialEmployee: string | null }) {
  const { repo, tenant, version } = useChef();
  const toast = useToast();
  const { approve, giveBack } = useStatementActions();
  const withAccount = tenant.settings.workAccount.enabled;
  const [month, setMonth] = useState(initialMonth && isValidMonth(initialMonth) ? initialMonth : currentMonth());
  const [employeeId, setEmployeeId] = useState(initialEmployee ?? "all");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (initialMonth && isValidMonth(initialMonth)) setMonth(initialMonth); }, [initialMonth]);
  useEffect(() => { if (initialEmployee) setEmployeeId(initialEmployee); }, [initialEmployee]);

  const q = useAsync(async () => {
    const [data, statements] = await Promise.all([loadTenantMonth(repo, tenant, month), repo.listStatements(tenant.id, month)]);
    return { ...data, statements, rows: employeeMonthRows({ ...data, statements }) };
  }, [month, version, tenant.id]);

  const d = q.data;
  const rows = d?.rows ?? [];
  const byId = new Map<string, Employee>((d?.employees ?? []).map((e) => [e.id, e]));
  const selected = employeeId === "all" ? null : rows.find((r) => r.employee.id === employeeId) ?? null;
  const selectedEmployee = employeeId === "all" ? null : byId.get(employeeId) ?? null;
  const choices = [...rows.map((r) => r.employee), ...(selectedEmployee && !selected ? [selectedEmployee] : [])];

  const fileBase = `${tenant.slug}_${month}`;
  const csvSums = () => {
    downloadBlob(new Blob([monthSummaryCsv(month, rows, withAccount)], { type: "text/csv;charset=utf-8" }), `Stundenuebersicht_${fileBase}_alle.csv`);
    toast("CSV-Datei wurde erstellt.");
  };
  const csvEntries = (who: Employee | null) => {
    const entries = (d?.entries ?? []).filter((e) => !who || e.employeeId === who.id);
    downloadBlob(new Blob([timeEntriesCsv(entries, byId)], { type: "text/csv;charset=utf-8" }), `Arbeitszeiten_${fileBase}_${who ? who.personnelNumber : "alle"}.csv`);
    toast("CSV-Datei wurde erstellt.");
  };
  const pdf = async (r: EmployeeMonthRow) => {
    setBusy(true);
    try {
      const entries = (d?.entries ?? []).filter((e) => e.employeeId === r.employee.id);
      const { blob, fileName } = await buildStatementWithLogo({
        tenant, employee: r.employee, month, entries, allocations: d?.allocations.get(r.employee.id) ?? [], statement: r.statement,
      });
      downloadBlob(blob, fileName);
      toast(`PDF erstellt: ${fileName}`);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const total = rows.reduce((s, r) => ({ worked: s.worked + r.workedMinutes, allocated: s.allocated + r.allocatedMinutes, billing: s.billing + r.billingMinutes }),
    { worked: 0, allocated: 0, billing: 0 });
  const approved = rows.filter((r) => r.statement?.status === "approved").length;
  const waiting = rows.filter((r) => r.statement?.status === "submitted").length;

  return (
    <div class="stack">
      <div class="row-between">
        <div>
          <h1 class="page-title">Stundenübersicht</h1>
          <p class="muted page-sub">Stunden je Mitarbeiter und Monat – mit Monatsnachweis, PDF und CSV.</p>
        </div>
      </div>
      <Card>
        <div class="toolbar">
          <div class="field">
            <span class="field-label">Monat</span>
            <MonthPicker month={month} onChange={setMonth} />
          </div>
          <SelectField label="Mitarbeiter" value={employeeId} onValue={setEmployeeId}
            options={[{ value: "all", label: "Alle Mitarbeitenden" }, ...choices.map((e) => ({ value: e.id, label: `${e.displayName} (${e.personnelNumber})` }))]} />
        </div>
      </Card>
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}

      {employeeId === "all" ? (
        <>
          <div class="grid-4">
            <StatTile label={`Geleistet ${monthLabelDE(month)}`} value={hoursLabel(total.worked)} tone="brand" hint={`${rows.length} Mitarbeitende`} />
            {withAccount && <StatTile label="Ins Arbeitszeitkonto" value={hoursLabel(total.allocated)} />}
            <StatTile label="Zur Abrechnung" value={hoursLabel(total.billing)} />
            <StatTile label="Monatsnachweise" value={`${approved} / ${rows.length}`} hint={waiting ? `freigegeben · ${waiting} warten auf Prüfung` : "freigegeben"} tone={waiting ? "warning" : "default"} />
          </div>
          <Card title={`Alle Mitarbeitenden · ${monthLabelDE(month)}`} actions={
            <div class="btn-row">
              <Button size="sm" variant="secondary" icon="download" onClick={csvSums} disabled={!rows.length}>CSV Monatssummen</Button>
              <Button size="sm" variant="secondary" icon="download" onClick={() => csvEntries(null)} disabled={!d?.entries.some((e) => !e.deletedAt)}>CSV alle Einsätze</Button>
            </div>
          }>
            <Table<EmployeeMonthRow>
              caption={`Stundenübersicht ${monthLabelDE(month)}`}
              rows={rows}
              rowKey={(r) => r.employee.id}
              empty={<EmptyState icon="users" title="Keine Mitarbeitenden in diesem Monat" />}
              columns={[
                { key: "n", header: "Mitarbeiter", render: (r) => <><strong>{r.employee.displayName}</strong><div class="xsmall muted">Nr. {r.employee.personnelNumber}</div></> },
                { key: "d", header: "Tage", align: "right", render: (r) => <span class="num">{r.days}</span> },
                { key: "w", header: "Geleistet", align: "right", render: (r) => <span class="num">{hoursLabel(r.workedMinutes)}</span> },
                ...(withAccount ? [
                  { key: "k", header: "Ins Konto", align: "right" as const, render: (r: EmployeeMonthRow) => <span class="num">{hoursLabel(r.allocatedMinutes)}</span> },
                ] : []),
                { key: "b", header: "Abrechnung", align: "right", render: (r) => <span class="num"><strong>{hoursLabel(r.billingMinutes)}</strong></span> },
                ...(withAccount ? [
                  { key: "s", header: "Kontostand", align: "right" as const, render: (r: EmployeeMonthRow) => <span class="num">{r.balanceMinutes == null ? "—" : signedHours(r.balanceMinutes)}</span> },
                ] : []),
                { key: "st", header: "Nachweis", render: (r) => <StatusPill status={r.statement?.status ?? "none"} label={r.statement ? undefined : STATEMENT_STATUS_LABEL.none} /> },
                { key: "a", header: "Aktionen", actions: true, render: (r) => (
                  <div class="btn-row" style={{ justifyContent: "flex-end" }}>
                    <Button size="sm" variant="secondary" icon="calendar" onClick={() => setEmployeeId(r.employee.id)} aria-label={`Tage von ${r.employee.displayName} anzeigen`}>Tage</Button>
                    <Button size="sm" variant="ghost" icon="download" onClick={() => pdf(r)} disabled={busy || !r.shifts} aria-label={`PDF-Stundenzettel für ${r.employee.displayName}`}>PDF</Button>
                  </div>
                ) },
              ]}
            />
          </Card>
        </>
      ) : (
        <EmployeeMonth row={selected} employee={selectedEmployee} month={month} days={dayRows((d?.entries ?? []).filter((e) => e.employeeId === employeeId))}
          issues={new Map(errorsForMonth(activeShifts((d?.entries ?? []).filter((e) => e.employeeId === employeeId)), month, tenant.settings.breakPolicy).map((i) => [i.date, i.message]))}
          withAccount={withAccount} busy={busy} loading={!d}
          onBack={() => setEmployeeId("all")} onPdf={pdf} onCsv={csvEntries}
          onApprove={(r) => r.statement && approve(r.employee, r.statement)} onReturn={(r) => r.statement && giveBack(r.employee, r.statement)} />
      )}
    </div>
  );
}

function EmployeeMonth({ row, employee, month, days, issues, withAccount, busy, loading, onBack, onPdf, onCsv, onApprove, onReturn }: {
  row: EmployeeMonthRow | null; employee: Employee | null; month: string; days: DayRow[]; issues: Map<string, string>; withAccount: boolean;
  busy: boolean; loading: boolean;
  onBack: () => void; onPdf: (r: EmployeeMonthRow) => void; onCsv: (e: Employee) => void;
  onApprove: (r: EmployeeMonthRow) => void; onReturn: (r: EmployeeMonthRow) => void;
}) {
  if (loading) return <p class="muted" role="status">Wird geladen …</p>;
  if (!employee) return <Alert tone="warning">Mitarbeiter nicht gefunden. <button type="button" class="link-button" onClick={onBack}>Zur Übersicht</button></Alert>;
  const r: EmployeeMonthRow = row ?? { employee, days: 0, shifts: 0, workedMinutes: 0, allocatedMinutes: 0, billingMinutes: 0, balanceMinutes: null, statement: null };
  const st = r.statement;
  const pauseTotal = days.reduce((s, x) => s + x.pauseMinutes, 0);

  return (
    <>
      <div class="row-between">
        <Button variant="ghost" size="sm" icon="chevronLeft" onClick={onBack}>Alle Mitarbeitenden</Button>
        <div class="btn-row">
          <Button icon="fileCheck" onClick={() => onPdf(r)} busy={busy} disabled={!r.shifts}>PDF-Stundenzettel</Button>
          <Button variant="secondary" icon="download" onClick={() => onCsv(employee)} disabled={!r.shifts}>CSV</Button>
        </div>
      </div>
      <div class="grid-4">
        <StatTile label="Geleistet" value={hoursLabel(r.workedMinutes)} tone="brand" hint={`${r.days} Tage, ${r.shifts} Einsätze`} />
        {withAccount && <StatTile label="Ins Arbeitszeitkonto" value={hoursLabel(r.allocatedMinutes)} hint={st?.status === "approved" || r.allocatedMinutes === 0 ? undefined : "Vorschlag, noch nicht bestätigt"} />}
        <StatTile label="Zur Abrechnung" value={hoursLabel(r.billingMinutes)} />
        {withAccount && <StatTile label="Kontostand nach dem Monat" value={r.balanceMinutes == null ? "—" : signedHours(r.balanceMinutes)} />}
      </div>
      <Card title={`${employee.displayName} · ${monthLabelDE(month)}`} actions={<span class="small muted">Personalnr. {employee.personnelNumber}</span>}>
        <div class="row-between" style={{ marginBottom: "var(--space-4)" }} data-testid="statement-status">
          <div class="row">
            <span class="small"><strong>Monatsnachweis:</strong></span>
            <StatusPill status={st?.status ?? "none"} label={st ? (st.status === "reopened" ? STATEMENT_STATUS_LABEL.reopened : undefined) : STATEMENT_STATUS_LABEL.none} />
            {st?.submittedAt && <span class="xsmall muted">eingereicht {dateTimeDE(st.submittedAt)}</span>}
            {st?.status === "returned" && st.reviewNote && <span class="xsmall">Grund: {st.reviewNote}</span>}
          </div>
          {st && (st.status === "submitted" || st.status === "approved" || st.status === "reopened") && (
            <div class="btn-row">
              {(st.status === "submitted" || st.status === "reopened") && <Button size="sm" icon="check" onClick={() => onApprove(r)}>{st.status === "reopened" ? "Erneut freigeben" : "Freigeben"}</Button>}
              <Button size="sm" variant="secondary" icon="undo" onClick={() => onReturn(r)}>{st.status === "approved" ? "Monat wieder öffnen" : "Zurückgeben"}</Button>
            </div>
          )}
        </div>
        {issues.size > 0 && <Alert tone="warning" title={`${issues.size} Tag${issues.size > 1 ? "e" : ""} mit Pausenproblem`}><p>Bitte vor der Freigabe prüfen. Die Tage sind in der Tabelle markiert.</p></Alert>}
        <Table<DayRow>
          caption={`Arbeitstage ${employee.displayName} ${monthLabelDE(month)}`}
          rows={days}
          rowKey={(x) => x.date}
          empty={<EmptyState icon="clock" title="Keine Einsätze in diesem Monat" />}
          columns={[
            { key: "d", header: "Datum", render: (x) => <span class="nowrap"><strong>{weekdayShort(x.date)}</strong>, {formatDateDE(x.date)}</span> },
            { key: "t", header: "Einsätze", render: (x) => (
              <span class="num">{x.entries.map((e, i) => <span key={e.id} class="nowrap">{i > 0 && ", "}{e.start}–{e.end}</span>)}</span>
            ) },
            { key: "p", header: "Pause", align: "right", render: (x) => <span class="num">{x.pauseMinutes} Min.</span> },
            { key: "h", header: "Stunden", align: "right", render: (x) => <span class="num"><strong>{hoursLabel(x.netMinutes)}</strong></span> },
            { key: "b", header: "Bemerkung", render: (x) => (
              <span class="small">
                {x.entries.map((e) => e.note).filter(Boolean).join(" · ") || "—"}
                {x.entries.some((e) => e.source === "correction") && <> <Badge tone="info">korrigiert</Badge></>}
                {issues.has(x.date) && <div><Badge tone="danger">{issues.get(x.date)}</Badge></div>}
              </span>
            ) },
          ]}
        />
        {days.length > 0 && (
          <div class="sum-bar" data-testid="hours-sum">
            <strong>Summe {monthLabelDE(month)} ({r.days} Tage, {r.shifts} Einsätze, Pausen {pauseTotal} Min.)</strong>
            <strong class="num">{hoursLabel(r.workedMinutes)}</strong>
          </div>
        )}
      </Card>
    </>
  );
}

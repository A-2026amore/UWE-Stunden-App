import { useState } from "preact/hooks";
import { errorsForMonth } from "../../../core/breaks";
import { activeShifts } from "../../../core/time";
import type { Employee, MonthlyStatement } from "../../../core/types";
import { shiftMonth } from "../../../data/demo";
import { Alert, Badge, Button, Card, LinkButton, StatusPill, Table, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { currentMonth, dateTimeDE, downloadBlob, hoursLabel, monthLabelDE } from "../../shared/format";
import { buildStatementWithLogo } from "../../shared/statement";
import { MonthPicker } from "../../shared/MonthPicker";
import { loadTenantMonth, useChef } from "../context";
import { useStatementActions } from "../statementActions";
import { StatementHistoryButton, useReopenStatement } from "../StatementHistory";

interface Row { employee: Employee; statement: MonthlyStatement | null; worked: number; allocated: number; billing: number; issues: number }

export function StatementsPage() {
  const { repo, tenant, version } = useChef();
  const toast = useToast();
  const [month, setMonth] = useState(shiftMonth(currentMonth(), -1));

  const q = useAsync(async () => {
    const [data, statements] = await Promise.all([loadTenantMonth(repo, tenant, month), repo.listStatements(tenant.id, month)]);
    const rows: Row[] = data.employees
      .filter((e) => e.role === "employee" || data.entries.some((x) => x.employeeId === e.id) || statements.some((s) => s.employeeId === e.id))
      .map((e) => {
        const st = statements.find((s) => s.employeeId === e.id) ?? null;
        const sum = data.summaries.get(e.id)!;
        const issues = errorsForMonth(activeShifts(data.entries.filter((x) => x.employeeId === e.id)), month, tenant.settings.breakPolicy).length;
        return { employee: e, statement: st, worked: sum.workedMinutes, allocated: sum.allocatedMinutes, billing: sum.billingMinutes, issues };
      });
    return rows;
  }, [month, version]);

  const { approve: approveStatement, giveBack: returnStatement } = useStatementActions();
  const approve = (r: Row) => (r.statement ? approveStatement(r.employee, r.statement) : undefined);
  const giveBack = (r: Row) => (r.statement ? returnStatement(r.employee, r.statement) : undefined);
  const reopenStatement = useReopenStatement();
  const reopen = (r: Row) => (r.statement ? reopenStatement(r.employee, r.statement) : undefined);

  const pdf = async (r: Row) => {
    try {
      const [entries, allocations] = await Promise.all([repo.listTimeEntries(r.employee.id, month), repo.listAllocations(r.employee.id)]);
      const { blob, fileName } = await buildStatementWithLogo({ tenant, employee: r.employee, month, entries, allocations, statement: r.statement });
      downloadBlob(blob, fileName);
    } catch (e) { toast(errorText(e), "error"); }
  };

  const rows = q.data ?? [];
  const open = rows.filter((r) => r.statement?.status === "submitted" || r.statement?.status === "reopened").length;
  const corrected = rows.filter((r) => r.statement?.correctedAfterApproval);

  return (
    <div class="stack">
      <h1 class="page-title">Monatsnachweise</h1>
      <Card>
        <div class="row-between" style={{ marginBottom: "var(--space-4)" }}>
          <MonthPicker month={month} onChange={setMonth} />
          <Badge tone={open ? "warning" : "success"}>{open} zur Prüfung</Badge>
        </div>
        {q.error && <Alert tone="danger" live>{q.error}</Alert>}
        {corrected.length > 0 && (
          <Alert tone="warning" title={`${corrected.length} freigegebene${corrected.length > 1 ? "" : "r"} Nachweis${corrected.length > 1 ? "e" : ""} nach Freigabe korrigiert`}>
            <p>Altfälle vor der Regel vom 28.10.2026: Die Spalten zeigen die Zahlen zum Zeitpunkt der Freigabe; die aktuellen Werte stehen unter „Hinweise“.
              Zum Anpassen den Monat wieder öffnen und erneut freigeben – die Zahlen werden dabei neu berechnet.</p>
          </Alert>
        )}
        <Table<Row>
          caption={`Monatsnachweise ${monthLabelDE(month)}`}
          rows={rows}
          rowKey={(r) => r.employee.id}
          empty={<p class="muted">Keine Mitarbeitenden.</p>}
          columns={[
            { key: "n", header: "Mitarbeiter", render: (r) => <><strong>{r.employee.displayName}</strong><div class="xsmall muted">Nr. {r.employee.personnelNumber}</div></> },
            { key: "s", header: "Status", render: (r) => <StatusPill status={r.statement?.status ?? "none"} label={r.statement ? (r.statement.status === "reopened" ? "Wieder geöffnet" : undefined) : "Nicht eingereicht"} /> },
            { key: "w", header: "Geleistet", align: "right", render: (r) => <span class="num">{hoursLabel(r.statement?.workedMinutes ?? r.worked)}</span> },
            ...(tenant.settings.workAccount.enabled ? [{ key: "k", header: "Ins Konto", align: "right" as const, render: (r: Row) => <span class="num">{hoursLabel(r.statement?.allocatedMinutes ?? r.allocated)}</span> }] : []),
            { key: "b", header: "Abrechnung", align: "right", render: (r) => <span class="num"><strong>{hoursLabel(r.statement?.billingMinutes ?? r.billing)}</strong></span> },
            { key: "i", header: "Hinweise", render: (r) => (
              <span class="small">
                {r.issues > 0 && <Badge tone="danger">{r.issues} Pausenproblem{r.issues > 1 ? "e" : ""}</Badge>}
                {r.statement?.correctedAfterApproval && (
                  <div>
                    <Badge tone="warning">nach Freigabe korrigiert</Badge>
                    <div class="xsmall">{r.statement.correctedAfterApproval.count} Korrektur{r.statement.correctedAfterApproval.count > 1 ? "en" : ""}, zuletzt {dateTimeDE(r.statement.correctedAfterApproval.lastAt)}</div>
                    {(r.worked !== r.statement.workedMinutes || r.billing !== r.statement.billingMinutes) && (
                      <div class="xsmall">aktuell {hoursLabel(r.worked)} geleistet / {hoursLabel(r.billing)} Abrechnung</div>
                    )}
                  </div>
                )}
                {r.statement?.submittedAt && <div class="xsmall muted">eingereicht {dateTimeDE(r.statement.submittedAt)}</div>}
                {r.statement?.status === "returned" && <div class="xsmall">Grund: {r.statement.reviewNote}</div>}
                {r.statement?.status === "reopened" && <div class="xsmall">Wieder geöffnet{r.statement.reopenedAt ? ` ${dateTimeDE(r.statement.reopenedAt)}` : ""}: {r.statement.reviewNote}</div>}
              </span>
            ) },
            {
              key: "a", header: "Aktionen", actions: true, render: (r) => (
                <div class="btn-row" style={{ justifyContent: "flex-end" }}>
                  <LinkButton size="sm" variant="ghost" icon="calendar" href={`#/stunden?m=${month}&ma=${r.employee.id}`} aria-label={`Tage von ${r.employee.displayName} anzeigen`}>Tage</LinkButton>
                  <Button size="sm" variant="ghost" icon="download" onClick={() => pdf(r)} aria-label={`PDF für ${r.employee.displayName}`}>PDF</Button>
                  {r.statement?.status === "submitted" && <>
                    <Button size="sm" icon="check" onClick={() => approve(r)} aria-label={`Nachweis von ${r.employee.displayName} freigeben`}>Freigeben</Button>
                    <Button size="sm" variant="secondary" icon="undo" onClick={() => giveBack(r)} aria-label={`Nachweis von ${r.employee.displayName} zurückgeben`}>Zurückgeben</Button>
                  </>}
                  {r.statement?.status === "reopened" && <>
                    <Button size="sm" icon="check" onClick={() => approve(r)} aria-label={`Nachweis von ${r.employee.displayName} erneut freigeben`}>Erneut freigeben</Button>
                    <Button size="sm" variant="secondary" icon="undo" onClick={() => giveBack(r)} aria-label={`Nachweis von ${r.employee.displayName} zurückgeben`}>Zurückgeben</Button>
                  </>}
                  {r.statement?.status === "approved" && <Button size="sm" variant="ghost" icon="undo" onClick={() => reopen(r)} aria-label={`Monat von ${r.employee.displayName} wieder öffnen`}>Monat wieder öffnen</Button>}
                  {r.statement && <StatementHistoryButton statement={r.statement} employeeName={r.employee.displayName} />}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

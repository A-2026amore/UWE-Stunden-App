/**
 * Chef-Portal: monthly hours overview per employee and CSV exports.
 * Pure functions (no DOM) – unit-tested in exports.test.ts.
 *
 * Sums come from core (summarizeMonth): worked hours stay documented, the
 * work-account transfer only reduces the billing hours.
 */
import { csvCell, csvRow } from "../../core/csv";
import { formatHours, netMinutes } from "../../core/time";
import type { Employee, MonthlyStatement, StatementStatus, TimeEntry } from "../../core/types";
import type { WorkAccountMonthSummary } from "../../core/workAccount";

export const STATEMENT_STATUS_LABEL: Record<StatementStatus | "none", string> = {
  none: "Nicht eingereicht",
  draft: "Entwurf",
  submitted: "Eingereicht",
  approved: "Freigegeben",
  returned: "Zurückgegeben",
};

const net = (e: TimeEntry) => netMinutes({ ...e, pause: e.pauseMinutes });
/**
 * 750 → "12,50", −6000 → "-100,00" (German decimal comma). Computed numbers, not user text: written
 * as they are – csvCell would mark a leading minus as formula and prefix an apostrophe.
 */
const csvHours = (minutes: number): { raw: string } => ({ raw: formatHours(minutes) });
type Cell = string | number | { raw: string };
const line = (cells: readonly Cell[]) => cells.map((c) => (typeof c === "object" ? c.raw : csvCell(c))).join(";");
const BOM = "﻿";

export interface DayRow {
  date: string;
  entries: TimeEntry[];
  pauseMinutes: number;
  netMinutes: number;
}

/** Active (not deleted) entries grouped by day, sorted by date and start. */
export function dayRows(entries: readonly TimeEntry[]): DayRow[] {
  const byDay = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    if (e.deletedAt) continue;
    byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const sorted = list.slice().sort((a, b) => a.start.localeCompare(b.start));
      return {
        date,
        entries: sorted,
        pauseMinutes: sorted.reduce((s, e) => s + e.pauseMinutes, 0),
        netMinutes: sorted.reduce((s, e) => s + net(e), 0),
      };
    });
}

export interface EmployeeMonthRow {
  employee: Employee;
  days: number;
  shifts: number;
  workedMinutes: number;
  allocatedMinutes: number;
  billingMinutes: number;
  /** Work-account balance after this month (null: no account / not in a cycle). */
  balanceMinutes: number | null;
  statement: MonthlyStatement | null;
}

/** One row per active/locked employee and per person with data in the month (leadership without hours, invited and deactivated people without data are left out). */
export function employeeMonthRows(args: {
  employees: readonly Employee[];
  entries: readonly TimeEntry[];
  summaries: ReadonlyMap<string, WorkAccountMonthSummary>;
  statements: readonly MonthlyStatement[];
}): EmployeeMonthRow[] {
  return args.employees
    .filter((e) => (e.role === "employee" && (e.status === "active" || e.status === "locked")) || args.entries.some((x) => x.employeeId === e.id && !x.deletedAt)
      || args.statements.some((s) => s.employeeId === e.id))
    .map((e) => {
      const own = args.entries.filter((x) => x.employeeId === e.id && !x.deletedAt);
      const sum = args.summaries.get(e.id);
      return {
        employee: e,
        days: new Set(own.map((x) => x.date)).size,
        shifts: own.length,
        workedMinutes: sum?.workedMinutes ?? own.reduce((s, x) => s + net(x), 0),
        allocatedMinutes: sum?.allocatedMinutes ?? 0,
        billingMinutes: sum?.billingMinutes ?? own.reduce((s, x) => s + net(x), 0),
        balanceMinutes: sum?.overallBalanceMinutes ?? null,
        statement: args.statements.find((s) => s.employeeId === e.id) ?? null,
      };
    });
}

/** CSV: one line per shift (all employees or one), formula-like texts neutralised (core/csv). */
export function timeEntriesCsv(entries: readonly TimeEntry[], employees: ReadonlyMap<string, Employee>): string {
  const head = ["Personalnummer", "Name", "Datum", "Beginn", "Ende", "Pause (Min.)", "Stunden", "Bemerkung", "Quelle"];
  const lines = entries.filter((e) => !e.deletedAt).map((e) => {
    const emp = employees.get(e.employeeId);
    return line([emp?.personnelNumber ?? "", emp?.displayName ?? "", formatDateDE(e.date), e.start, e.end, e.pauseMinutes, csvHours(net(e)), e.note,
      e.source === "correction" ? "Korrektur" : e.source === "migration" ? "Übernahme" : "App"]);
  });
  return BOM + [csvRow(head), ...lines].join("\r\n");
}

/** CSV: monthly sums per employee (Geleistet / Arbeitszeitkonto / Abrechnung / Status). */
export function monthSummaryCsv(month: string, rows: readonly EmployeeMonthRow[], withAccount: boolean): string {
  const head = ["Monat", "Personalnummer", "Name", "Einsatztage", "Einsätze", "Geleistet (Std.)",
    ...(withAccount ? ["Ins Arbeitszeitkonto (Std.)", "Kontostand (Std.)"] : []), "Abrechnung (Std.)", "Monatsnachweis"];
  const lines = rows.map((r) => line([
    month, r.employee.personnelNumber, r.employee.displayName, r.days, r.shifts, csvHours(r.workedMinutes),
    ...(withAccount ? [csvHours(r.allocatedMinutes), r.balanceMinutes == null ? "" : csvHours(r.balanceMinutes)] : []),
    csvHours(r.billingMinutes), STATEMENT_STATUS_LABEL[r.statement?.status ?? "none"],
  ]));
  return BOM + [csvRow(head), ...lines].join("\r\n");
}

function formatDateDE(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

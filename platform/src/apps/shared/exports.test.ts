import { describe, expect, it } from "vitest";
import type { Employee, MonthlyStatement, TimeEntry } from "../../core/types";
import type { WorkAccountMonthSummary } from "../../core/workAccount";
import { dayRows, employeeMonthRows, monthSummaryCsv, timeEntriesCsv } from "./exports";

const emp = (id: string, name: string, nr: string, extra: Partial<Employee> = {}): Employee => ({
  id, tenantId: "t1", personnelNumber: nr, displayName: name, email: null, role: "employee", status: "active", createdAt: "2026-01-01T00:00:00Z", ...extra,
});
let n = 0;
const entry = (employeeId: string, date: string, start: string, end: string, pauseMinutes: number, extra: Partial<TimeEntry> = {}): TimeEntry => ({
  id: `e${++n}`, tenantId: "t1", employeeId, date, start, end, pauseMinutes, note: "", version: 1, source: "app",
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", deletedAt: null, ...extra,
} as TimeEntry);

const anna = emp("a", "Anna Beispiel", "101");
const ben = emp("b", "Ben Muster", "102");
const chef = emp("c", "Chefin", "1", { role: "owner" });
const invited = emp("d", "Dora Neu", "103", { status: "invited" });

const entries = [
  entry("a", "2026-11-03", "13:00", "19:00", 0),
  entry("a", "2026-11-03", "06:00", "10:00", 0),
  entry("a", "2026-11-04", "06:00", "16:00", 45, { note: "=SUMME(A1)" }),
  entry("a", "2026-11-05", "06:00", "08:00", 0, { deletedAt: "2026-11-06T00:00:00Z" }),
  entry("b", "2026-11-04", "22:00", "06:00", 30, { source: "correction" }),
];

describe("dayRows", () => {
  it("groups active shifts by day (sorted), sums pause and net minutes", () => {
    const days = dayRows(entries.filter((e) => e.employeeId === "a"));
    expect(days.map((d) => d.date)).toEqual(["2026-11-03", "2026-11-04"]);
    expect(days[0]!.entries.map((e) => e.start)).toEqual(["06:00", "13:00"]);
    expect(days[0]!.netMinutes).toBe(600);
    expect(days[1]!.pauseMinutes).toBe(45);
    expect(days[1]!.netMinutes).toBe(555);
  });
});

describe("employeeMonthRows", () => {
  const summary = (worked: number, allocated: number, balance: number | null): WorkAccountMonthSummary =>
    ({ workedMinutes: worked, allocatedMinutes: allocated, billingMinutes: worked - allocated, overallBalanceMinutes: balance } as WorkAccountMonthSummary);
  const statement = { employeeId: "a", status: "submitted" } as MonthlyStatement;

  it("lists working employees with days, shifts, sums and statement; leaves out leadership without hours and invited people", () => {
    const rows = employeeMonthRows({
      employees: [anna, ben, chef, invited], entries,
      summaries: new Map([["a", summary(1155, 155, -5845)], ["b", summary(450, 0, null)]]),
      statements: [statement],
    });
    expect(rows.map((r) => r.employee.id)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ days: 2, shifts: 3, workedMinutes: 1155, allocatedMinutes: 155, billingMinutes: 1000, balanceMinutes: -5845, statement });
    expect(rows[1]).toMatchObject({ days: 1, shifts: 1, workedMinutes: 450, statement: null });
  });

  it("includes leadership that recorded own hours", () => {
    const rows = employeeMonthRows({ employees: [chef], entries: [entry("c", "2026-11-02", "08:00", "12:00", 0)], summaries: new Map(), statements: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workedMinutes).toBe(240);
  });
});

describe("CSV exports", () => {
  it("time entries: BOM, header, German decimal comma, formula neutralised, deleted entries left out", () => {
    const csv = timeEntriesCsv(entries, new Map([["a", anna], ["b", ben]]));
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Personalnummer;Name;Datum;Beginn;Ende;Pause (Min.);Stunden;Bemerkung;Quelle");
    expect(lines).toHaveLength(5);
    expect(lines).toContain("101;Anna Beispiel;04.11.2026;06:00;16:00;45;9,25;'=SUMME(A1);App");
    expect(lines).toContain("102;Ben Muster;04.11.2026;22:00;06:00;30;7,50;;Korrektur");
  });

  it("monthly sums with and without work account; negative balance stays a number", () => {
    const rows = employeeMonthRows({
      employees: [anna, ben], entries,
      summaries: new Map([["a", { workedMinutes: 1155, allocatedMinutes: 155, billingMinutes: 1000, overallBalanceMinutes: -5845 } as WorkAccountMonthSummary]]),
      statements: [{ employeeId: "a", status: "approved" } as MonthlyStatement],
    });
    const withAcc = monthSummaryCsv("2026-11", rows, true).slice(1).split("\r\n");
    expect(withAcc[0]).toBe("Monat;Personalnummer;Name;Einsatztage;Einsätze;Geleistet (Std.);Ins Arbeitszeitkonto (Std.);Kontostand (Std.);Abrechnung (Std.);Monatsnachweis");
    expect(withAcc[1]).toBe("2026-11;101;Anna Beispiel;2;3;19,25;2,58;-97,42;16,67;Freigegeben");
    expect(withAcc[2]).toBe("2026-11;102;Ben Muster;1;1;7,50;0,00;;7,50;Nicht eingereicht");
    const plain = monthSummaryCsv("2026-11", rows, false).slice(1).split("\r\n");
    expect(plain[0]).toBe("Monat;Personalnummer;Name;Einsatztage;Einsätze;Geleistet (Std.);Abrechnung (Std.);Monatsnachweis");
  });
});

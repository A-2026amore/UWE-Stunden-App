import { describe, expect, it } from "vitest";
import { legacyBackups, snapshots } from "../../../../tests/fixtures/legacy-storage";
import { UWE_BREAK_POLICY } from "../../core/breaks";
import { UWE_WORK_ACCOUNT_POLICY } from "../../core/workAccount";
import type { MigrationResult } from "../../core/migration";
import { personnelNumbersIn, planImport, readLegacyBrowserSnapshot, readSource } from "./legacyImport";

const target = (pn: string) => ({ tenantId: "t-1", employeeId: "emp-1", personnelNumber: pn });
const NOW = "2026-11-20T09:00:00.000Z";

function ok(read: ReturnType<typeof readSource>): MigrationResult {
  if (!read.ok) throw new Error("expected ok: " + read.reason);
  return read.result;
}

const plan = (result: MigrationResult, existing = result.entries.slice(0, 0), existingAllocations = result.allocations.slice(0, 0)) =>
  planImport({ result, existing, existingAllocations, statements: {}, breakPolicy: UWE_BREAK_POLICY, workAccount: UWE_WORK_ACCOUNT_POLICY });

describe("legacy import planning", () => {
  it("backup v4: report before writing with month totals old vs new and allocations", () => {
    const result = ok(readSource({ kind: "backup", fileName: "b.json", text: legacyBackups.v4 }, target("E1001"), NOW));
    const p = plan(result);
    expect(p.report.entriesRead).toBe(6);
    expect(p.toWrite).toHaveLength(6);
    expect(p.toWrite.every((e) => e.source === "migration" && e.employeeId === "emp-1")).toBe(true);
    expect(p.months).toEqual([
      { month: "2026-10", legacyMinutes: 450, beforeMinutes: 0, afterMinutes: 450 },
      { month: "2026-11", legacyMinutes: 1845, beforeMinutes: 0, afterMinutes: 1845 },
    ]);
    expect(p.allocationsToWrite.map((a) => [a.month, a.minutes])).toEqual([["2026-10", 300], ["2026-11", 600]]);
  });

  it("re-import is idempotent: everything already present, nothing to write", () => {
    const result = ok(readSource({ kind: "backup", fileName: "b.json", text: legacyBackups.v4 }, target("E1001"), NOW));
    const first = plan(result);
    const again = plan(result, first.toWrite, first.allocationsToWrite);
    expect(again.toWrite).toHaveLength(0);
    expect(again.alreadyPresent).toHaveLength(6);
    expect(again.allocationsToWrite).toHaveLength(0);
    expect(again.months.every((m) => m.afterMinutes === m.beforeMinutes && m.beforeMinutes === m.legacyMinutes)).toBe(true);
  });

  it("backup of another personnel number is refused", () => {
    const read = readSource({ kind: "backup", fileName: "b.json", text: legacyBackups.v2 }, target("E1001"));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toMatch(/Personalnummer E1002.*E1001.*abgelehnt/);
    const broken = readSource({ kind: "backup", fileName: "x.json", text: "{kaputt" }, target("E1001"));
    expect(broken.ok).toBe(false);
    const testApp = readSource({ kind: "backup", fileName: "t.json", text: legacyBackups.v4Test }, target("TEST001"));
    expect(testApp.ok).toBe(false);
  });

  it("v2 and v3 backups are readable", () => {
    const v2 = plan(ok(readSource({ kind: "backup", fileName: "v2.json", text: legacyBackups.v2 }, target("E1002"), NOW)));
    expect(v2.toWrite.map((e) => e.id)).toEqual(["legacy-79r8q4", "legacy-1eodjyu", "legacy-snbh87", "legacy-18vv1yy", "legacy-1q7qujg"]);
    expect(v2.months).toEqual([{ month: "2026-10", legacyMinutes: 2190, beforeMinutes: 0, afterMinutes: 2190 }]);
    const v3 = plan(ok(readSource({ kind: "backup", fileName: "v3.json", text: legacyBackups.v3 }, target("E1001"), NOW)));
    expect(v3.toWrite).toHaveLength(1);
  });

  it("browser snapshot: only the own personnel number is taken, other keys are reported", () => {
    const read = readSource({ kind: "browser", snapshot: snapshots.sharedDevice }, target("E1007"), NOW);
    expect(read.ok && read.otherPersonnelNumbers).toEqual(["E1001"]);
    const p = plan(ok(read));
    expect(p.toWrite.map((e) => e.date)).toEqual(["2026-10-27", "2026-10-28"]);
    expect(readSource({ kind: "browser", snapshot: snapshots.sharedDevice }, target("X1")).ok).toBe(false);
    expect(readSource({ kind: "browser", snapshot: snapshots.testMode }, target("TEST001")).ok).toBe(true);
  });

  it("invalid, duplicate and rule-violating entries are reported with reasons – nothing silently dropped", () => {
    const corrupt = plan(ok(readSource({ kind: "browser", snapshot: snapshots.corrupt }, target("E1006"), NOW)));
    const r = corrupt.report;
    expect(r.entriesRead).toBe(12);
    expect(r.entriesMigrated + r.duplicatesSkipped + r.invalid.filter((i) => i.key.startsWith("uwe_hours_2_")).length).toBe(12);
    expect(r.invalid.some((i) => /anderen Mitarbeiter/.test(i.reason))).toBe(true);
    expect(r.invalid.map((i) => i.reason).join(" | ")).toMatch(/Datum existiert nicht im Kalender/);

    const dup = plan(ok(readSource({ kind: "browser", snapshot: snapshots.duplicates }, target("E1003"), NOW)));
    expect(dup.report.duplicatesSkipped).toBe(1);
    expect(dup.rejected.map((x) => x.reason).join(" | ")).toMatch(/überschneidet sich/);
    const accounted = dup.toWrite.length + dup.alreadyPresent.length + dup.rejected.length;
    expect(accounted).toBe(dup.report.entriesMigrated);
  });

  it("reads only uwe_* keys from storage and detects personnel numbers", () => {
    const data: Record<string, string> = { ...snapshots.plainV27, other_app: "x" };
    const keys = Object.keys(data);
    const storage = { length: keys.length, key: (i: number) => keys[i] ?? null, getItem: (k: string) => data[k] ?? null };
    const snap = readLegacyBrowserSnapshot(storage);
    expect(Object.keys(snap).sort()).toEqual(Object.keys(snapshots.plainV27).sort());
    expect(personnelNumbersIn(snap)).toEqual(["E1001"]);
  });
});

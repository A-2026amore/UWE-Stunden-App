import { describe, expect, it } from "vitest";
import { entriesToImport, migrateLegacySnapshot, parseLegacyBackup } from "./migration";
import { isRealDate } from "./time";
import { loadIndexFunctions } from "./__legacy__/loadLegacy";
import { clock, int, pick, rng } from "./__legacy__/random";

const idx = loadIndexFunctions(["minutes", "worked", "valid", "makeEntryId", "fingerprint", "oldEntryId", "normalizeEntries"]);
const opts = { tenantId: "t1", employeeIdByPersonnelNumber: { "4711": "emp-4711", "0815": "emp-0815" }, now: "2026-10-26T12:00:00.000Z" };

function genLegacyRecords(r: () => number): unknown[] {
  const out: unknown[] = [];
  const n = int(r, 0, 30);
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.1 && out.length) { out.push(JSON.parse(JSON.stringify(pick(r, out)))); continue; } // exact duplicate
    if (roll < 0.15) { out.push(pick(r, [null, 5, "x", { date: "2026-02-30", start: "08:00", end: "09:00", pause: 0 }, { date: "2026-11-01" }])); continue; }
    const start = int(r, 0, 1439);
    const rec: Record<string, unknown> = {
      date: "2026-11-" + String(int(r, 1, 30)).padStart(2, "0"),
      start: clock(start),
      end: clock(start + int(r, 1, 700)),
      pause: pick(r, [0, 15, 30, 45, "30", -1]),
      note: pick(r, ["", "Fahrt", undefined, "Köln (Notfall)"]),
    };
    const idRoll = r();
    if (idRoll < 0.4) rec.id = "id-" + int(r, 1, 25); // explicit, may collide
    else if (idRoll < 0.5) rec.id = pick(r, ["x", "", 7, "bad id!"]); // not explicit → legacy id
    out.push(rec);
  }
  return out;
}

describe("migration – equivalence with legacy normalizeEntries (index.html)", () => {
  it("2000 random legacy arrays: same ids and fields as the legacy app shows them", () => {
    const r = rng(99);
    let compared = 0;
    for (let n = 0; n < 2000; n++) {
      const items = genLegacyRecords(r);
      const legacy = (idx.normalizeEntries!(JSON.parse(JSON.stringify(items))) as { id: string; date: string; start: string; end: string; pause: number; note: string }[])
        .filter((x) => isRealDate(x.date));
      const result = migrateLegacySnapshot({ uwe_hours_2_4711: JSON.stringify(items) }, opts);
      const mine = result.entries.map((e) => ({ id: e.id, date: e.date, start: e.start, end: e.end, pause: e.pauseMinutes, note: e.note }));
      expect(mine.length).toBe(legacy.length);
      for (let i = 0; i < legacy.length; i++) {
        const l = legacy[i]!, m = mine[i]!;
        // Legacy assigns a RANDOM id to a second record with the same explicit id; ours is deterministic.
        if (l.id.startsWith("rand-")) expect({ ...m, id: "" }).toEqual({ ...l, id: "" });
        else expect(m).toEqual(l);
        compared++;
      }
      // Nothing lost: read = migrated + duplicates + invalid.
      const rep = result.report;
      expect(rep.entriesRead).toBe(items.length);
      expect(rep.entriesMigrated + rep.duplicatesSkipped + rep.invalid.length).toBe(items.length);
    }
    expect(compared).toBeGreaterThan(20000);
  });
});

describe("migration – explicit cases", () => {
  const entries = [
    { id: "3f2a1b4c-1111-4222-8333-944455556666", date: "2026-11-02", start: "08:00", end: "16:00", pause: 30, note: "Tour" },
    { date: "2026-11-03", start: "22:00", end: "06:00", pause: 30, note: "" },
    { date: "2026-11-03", start: "22:00", end: "06:00", pause: 30, note: "" }, // exact duplicate without id
    { date: "2026-11-04", start: "08:00", end: "08:00", pause: 0, note: "kaputt" },
  ];
  const snapshot: Record<string, string> = {
    uwe_hours_2_4711: JSON.stringify(entries),
    uwe_arbeitszeitkonto_v1_4711: JSON.stringify({ version: 2, eid: "4711", openingMinutes: -6000, startMonth: "2026-09", allocations: { "2026-11": 120, "2026-12": 0, "2026-05": 60 } }),
    uwe_hours_2_0815: "{not json",
    uwe_test_hours_v1_only: JSON.stringify([{ date: "2026-11-01", start: "08:00", end: "09:00", pause: 0 }]),
    uwe_session: "token",
    uwe_chef_remembered_encrypted_backup_v1: "secret",
    uwe_hours_2_9999: JSON.stringify([{ date: "2026-11-05", start: "08:00", end: "09:00", pause: 0, note: "" }]),
  };

  it("maps 1:1, keeps legacy ids, reports corrupt data instead of dropping it", () => {
    const res = migrateLegacySnapshot(snapshot, opts);
    expect(res.entries.map((e) => e.id)).toEqual(["3f2a1b4c-1111-4222-8333-944455556666", idx.oldEntryId!(entries[1])]);
    expect(res.entries[1]).toMatchObject({ tenantId: "t1", employeeId: "emp-4711", pauseMinutes: 30, source: "migration", version: 1, deletedAt: null });
    expect(res.allocations).toEqual([{ employeeId: "emp-4711", month: "2026-11", minutes: 120, status: "proposed" }]);
    const rep = res.report;
    expect(rep.employees).toEqual(["0815", "4711", "9999"]);
    expect(rep.entriesRead).toBe(5);
    expect(rep.entriesMigrated).toBe(2);
    expect(rep.duplicatesSkipped).toBe(1);
    const keys = rep.invalid.map((x) => x.key);
    expect(keys).toContain("uwe_hours_2_4711[3]");
    expect(keys).toContain("uwe_hours_2_0815");
    expect(keys).toContain("uwe_arbeitszeitkonto_v1_4711.allocations.2026-05");
    expect(keys).toContain("uwe_hours_2_9999[0]"); // no employee mapping → reported with raw value
    expect(rep.invalid.find((x) => x.key === "uwe_hours_2_0815")?.raw).toBe("{not json");
    expect(rep.warnings.some((w) => w.includes("Testdaten") && w.includes("1 Einträge"))).toBe(true);
    expect(rep.warnings.some((w) => w.includes("uwe_session"))).toBe(true);
    expect(rep.warnings.some((w) => w.includes("uwe_chef_remembered_encrypted_backup_v1"))).toBe(true);
    // The input snapshot is untouched.
    expect(snapshot.uwe_session).toBe("token");
  });

  it("is idempotent: running twice yields identical ids and no duplicates", () => {
    const a = migrateLegacySnapshot(snapshot, opts);
    const b = migrateLegacySnapshot(snapshot, opts);
    expect(b).toEqual(a);
    const merged = entriesToImport(a.entries, b.entries);
    expect(merged.write).toEqual([]);
    expect(merged.skipped.length).toBe(a.entries.length);
    // Same content stored under another id (legacy restore rule) is skipped as well.
    const renamed = b.entries.map((e) => ({ ...e, id: e.id + "-x" }));
    expect(entriesToImport(a.entries, renamed).write).toEqual([]);
    // Another employee owning the id is a conflict, never an overwrite.
    expect(entriesToImport(a.entries, [{ ...a.entries[0]!, employeeId: "other" }]).conflicts.length).toBe(1);
  });

  it("explicit id used twice with different content → both kept, deterministic id, warning", () => {
    const items = [
      { id: "dup-1", date: "2026-11-02", start: "08:00", end: "10:00", pause: 0, note: "" },
      { id: "dup-1", date: "2026-11-02", start: "11:00", end: "12:00", pause: 0, note: "" },
    ];
    const one = migrateLegacySnapshot({ uwe_hours_2_4711: JSON.stringify(items) }, opts);
    const two = migrateLegacySnapshot({ uwe_hours_2_4711: JSON.stringify(items) }, opts);
    expect(one.entries.length).toBe(2);
    expect(one.entries[1]!.id).not.toBe("dup-1");
    expect(two.entries.map((e) => e.id)).toEqual(one.entries.map((e) => e.id));
    expect(one.report.warnings.some((w) => w.includes("dup-1"))).toBe(true);
  });

  it("identical shifts of two employees without ids do not swallow each other", () => {
    const shift = [{ date: "2026-11-02", start: "08:00", end: "10:00", pause: 0, note: "" }];
    const res = migrateLegacySnapshot({ uwe_hours_2_4711: JSON.stringify(shift), uwe_hours_2_0815: JSON.stringify(shift) }, opts);
    expect(res.entries.length).toBe(2);
    expect(new Set(res.entries.map((e) => e.id)).size).toBe(2);
  });

  it("corrupt account record is reported with its raw value", () => {
    const raw = JSON.stringify({ version: 2, eid: "OTHER", openingMinutes: -6000, allocations: {} });
    const res = migrateLegacySnapshot({ uwe_arbeitszeitkonto_v1_4711: raw }, opts);
    expect(res.report.invalid).toEqual([{ key: "uwe_arbeitszeitkonto_v1_4711", reason: expect.stringContaining("beschädigt"), raw }]);
  });

  it("parses backups v2–v4 into the same shape", () => {
    const v4 = { app: "UWE Stunden", version: 4, eid: "4711", name: "Test", exportedAt: "2026-10-01T00:00:00Z", entries,
      arbeitszeitkonto: { version: 2, eid: "4711", openingMinutes: -6000, startMonth: "2026-09", allocations: { "2026-10": 90 } } };
    const res = parseLegacyBackup(JSON.stringify(v4), opts);
    expect(res.entries.length).toBe(2);
    expect(res.allocations).toEqual([{ employeeId: "emp-4711", month: "2026-10", minutes: 90, status: "proposed" }]);
    expect(res.report.invalid.map((x) => x.key)).toEqual(["backup.entries[3]"]);
    expect(res.report.warnings.some((w) => w.includes("abgelehnt"))).toBe(true);
    const v2 = parseLegacyBackup({ ...v4, version: 2, arbeitszeitkonto: undefined }, opts);
    expect(v2.allocations).toEqual([]);
    expect(v2.entries.map((e) => e.id)).toEqual(res.entries.map((e) => e.id));
    expect(parseLegacyBackup("{oops", opts).report.invalid[0]).toMatchObject({ key: "backup", raw: "{oops" });
    expect(parseLegacyBackup({ ...v4, app: "Andere" }, opts).report.invalid[0]!.reason).toContain("beschädigt");
    expect(parseLegacyBackup({ ...v4, arbeitszeitkonto: undefined }, opts).report.invalid.some((x) => x.key === "backup.arbeitszeitkonto")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { MonthAllocation, ShiftLike, WorkAccountPolicy } from "./types";
import {
  NRW_SUMMER_HOLIDAYS, UWE_WORK_ACCOUNT_POLICY, cycleBalances, cycleForDate, cycleInfoForMonth, cycleStatusForMonth,
  invalidAllocations, nrwHolidayProvider, pickSummerHoliday, refreshHolidayCache, schoolYearCycle, staticHolidayProvider,
  summarizeMonth, validateAllocation, type AccountCycle, type HolidayCache,
} from "./workAccount";
import { addDays } from "./time";
import { loadLegacy } from "./__legacy__/loadLegacy";
import { clock, int, pick, rng } from "./__legacy__/random";

const NOW = new Date("2031-03-15T10:00:00Z");
const plain = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const policy = UWE_WORK_ACCOUNT_POLICY;

/**
 * Hypothetical cache rows used only to exercise the legacy cache code path
 * (they are NOT real holiday dates): one valid 2031 row and one 2032 row that
 * legacy validation rejects (start month March).
 */
const FIXTURE_CACHE: HolidayCache = { "2031": { start: "2031-07-14", end: "2031-08-26" }, "2032": { start: "2032-03-01", end: "2032-04-01" } };

function legacyFor(cache: HolidayCache | null) {
  const storage: Record<string, string> = cache ? { uwe_nrw_sommerferien_v2: JSON.stringify(cache) } : {};
  const ctx = loadLegacy(["uwe-arbeitszeitkonto.js"], { storage, now: NOW });
  return { lib: ctx.window.UweWorkAccount, store: ctx.localStorage, provider: nrwHolidayProvider(cache ?? undefined) };
}

function cycleView(c: AccountCycle | null | undefined) {
  if (!c) return c ?? null;
  return { year: c.year, id: c.id, label: c.label, start: c.start, lastSchoolDay: c.lastSchoolDay, summerStart: c.summerStart,
    summerEnd: c.summerEnd, afterSummerStart: c.afterSummerStart, source: c.source };
}

function infoView(month: string, provider: ReturnType<typeof nrwHolidayProvider>) {
  const info = cycleInfoForMonth(month, policy, provider);
  if (info.status === "active") return { ...cycleView(info.cycle), status: "active" };
  if (info.status === "vacation")
    return { status: "vacation", year: info.cycle?.year ?? null, label: info.label, previous: cycleView(info.previous),
      next: cycleView(info.next), summerStart: info.summerStart, summerEnd: info.summerEnd, afterSummerStart: info.afterSummerStart };
  return { status: info.status, year: null, label: info.label };
}

const BOUNDARY_MONTHS = ["2026-07", "2026-08", "2026-09", "2026-10", "2027-06", "2027-07", "2027-08", "2027-09",
  "2028-07", "2028-08", "2029-06", "2029-07", "2029-08", "2030-06", "2030-07", "2030-08", "2030-09", "2031-07", "2031-09"];
const ALL_MONTHS: string[] = [];
for (let y = 2025; y <= 2033; y++) for (let m = 1; m <= 12; m++) ALL_MONTHS.push(y + "-" + String(m).padStart(2, "0"));

function genRecords(r: () => number, months: string[]): ShiftLike[] {
  const out: ShiftLike[] = [];
  const count = int(r, 0, 25);
  for (let i = 0; i < count; i++) {
    const month = pick(r, months);
    const day = int(r, 1, 28 + (r() < 0.3 ? 3 : 0));
    const date = addDays(month + "-01", day - 1);
    const start = int(r, 0, 1439);
    const dur = r() < 0.2 ? pick(r, [360, 540, 720, 1, 1439]) : int(r, 30, 720);
    const pause = r() < 0.97 ? Math.min(dur - 1, pick(r, [0, 15, 30, 45])) : pick(r, [dur + 5, -3]);
    out.push({ id: "r" + i, date, start: clock(start), end: clock(start + dur), pause });
  }
  return out;
}

function capture<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: (e as Error).message }; }
}

describe("workAccount – equivalence with legacy uwe-arbeitszeitkonto.js", () => {
  for (const cache of [null, FIXTURE_CACHE]) {
    const label = cache ? "with cached online holidays" : "official table only";
    const { lib, store, provider } = legacyFor(cache);

    it("cycle(), schoolYearForDate(), calendarForMonth() – " + label, () => {
      for (let y = 2024; y <= 2034; y++) expect(cycleView(schoolYearCycle(y, provider))).toEqual(plain(lib.cycle(y, store)));
      for (let d = "2025-06-01"; d <= "2033-12-31"; d = addDays(d, 1))
        expect(cycleView(cycleForDate(d, policy, provider))).toEqual(plain(lib.schoolYearForDate(d, store)));
      for (const m of ALL_MONTHS) expect(infoView(m, provider)).toEqual(plain(lib.calendarForMonth(m, store)));
      for (const bad of ["2026-13", "2026-1", "", "1999-01"])
        expect(capture(() => cycleInfoForMonth(bad, policy, provider))).toEqual(capture(() => lib.calendarForMonth(bad, store)));
    });

    it("summary / update / invalidAllocations / cyclesWithBalances for 1500 random accounts – " + label, () => {
      const r = rng(cache ? 7 : 3);
      const monthsPool = [...BOUNDARY_MONTHS, ...ALL_MONTHS.filter((m) => m >= "2026-09" && m <= "2031-12")];
      let throws = 0;
      for (let n = 0; n < 1500; n++) {
        const months = Array.from({ length: int(r, 1, 4) }, () => pick(r, monthsPool));
        const records = genRecords(r, months);
        const allocMap: Record<string, number> = {};
        const allocations: MonthAllocation[] = [];
        for (let i = int(r, 0, 5); i > 0; i--) {
          const month = pick(r, months.filter((m) => m >= "2026-09").concat("2026-09"));
          const minutes = r() < 0.2 ? 0 : int(r, 1, 6000);
          if (minutes) allocMap[month] = minutes; else delete allocMap[month];
          allocations.push({ employeeId: "e1", month, minutes, status: "proposed" });
        }
        const state = { version: 2, eid: "4711", openingMinutes: -6000, startMonth: "2026-09", allocations: allocMap };
        for (const month of [...new Set([...months, pick(r, BOUNDARY_MONTHS)])]) {
          const legacySummary = capture(() => plain(lib.summary(state, records, month, store)));
          const mine = capture(() => summarizeMonth({ entries: records, allocations, month, policy, provider }));
          expect(mine.ok).toBe(legacySummary.ok);
          if (!mine.ok || !legacySummary.ok) {
            throws++;
            expect(mine.ok ? "" : mine.error).toBe(legacySummary.ok ? "" : legacySummary.error);
            continue;
          }
          const a = mine.value, b = legacySummary.value;
          expect(a.workedMinutes).toBe(b.total);
          expect(a.eligibleMinutes).toBe(b.eligibleWorked);
          expect(a.cycleStatus === "active").toBe(b.eligible);
          expect(a.allocatedMinutes).toBe(b.allocated);
          expect(a.billingMinutes).toBe(b.available);
          expect(a.balanceMinutes ?? policy.openingMinutes).toBe(b.balance);
          expect(a.overallBalanceMinutes ?? policy.openingMinutes).toBe(b.overallBalance);
          expect(a.remainingToZeroMinutes).toBe(b.remainingToZero);
          expect(a.progressPct).toBeCloseTo(b.progressPct, 10);
          expect(a.invalid).toEqual(b.invalid);
          expect(infoView(month, provider)).toEqual(b.schoolYear);

          const minutes = pick(r, [0, 1, 60, a.eligibleMinutes, a.eligibleMinutes + 1, -5, 1.5, int(r, 0, 9000)]);
          const up = capture(() => plain(lib.update(state, records, month, minutes, store)));
          const mineUp = capture(() => validateAllocation({ entries: records, allocations, month, minutes, policy, provider }));
          expect(mineUp.ok).toBe(up.ok);
          if (!mineUp.ok || !up.ok) expect(mineUp.ok ? "" : mineUp.error).toBe(up.ok ? "" : up.error);
          else expect(up.value.allocations[month] ?? 0).toBe(mineUp.value);
        }
        const inv = capture(() => plain(lib.invalidAllocations(state, records, null, store)));
        const mineInv = capture(() => invalidAllocations({ entries: records, allocations, policy, provider }));
        expect(mineInv).toEqual(inv);
        const balances = cycleBalances({ allocations, policy, provider, now: NOW }).map((x) => ({ cycle: cycleView(x.cycle), balance: x.balanceMinutes }));
        expect(balances).toEqual(plain(lib.cyclesWithBalances(state, store)));
      }
      // Invalid records must have been exercised as well.
      expect(throws).toBeGreaterThan(25);
    }, 180_000);
  }

  it("official holiday table is copied exactly", () => {
    const { lib } = legacyFor(null);
    expect(plain(NRW_SUMMER_HOLIDAYS)).toEqual(plain(lib.OFFICIAL));
    for (let y = 2020; y <= 2105; y++) {
      const { lib: l2, store } = legacyFor(FIXTURE_CACHE);
      const h = nrwHolidayProvider(FIXTURE_CACHE).summerHolidays(y);
      const legacy = plain(l2.holiday(y, store));
      expect(h ? { ...h, date: h.start } : null).toEqual(legacy);
    }
  });
});

describe("workAccount – explicit business cases", () => {
  const provider = nrwHolidayProvider();
  const shifts = (date: string, count: number, minutesEach: number): ShiftLike[] =>
    Array.from({ length: count }, (_, i) => ({ id: date + i, date: addDays(date, i), start: "06:00", end: clock(360 + minutesEach), pause: 0 }));

  it("50 h worked − 20 h allocated = 30 h billing (worked unchanged)", () => {
    const entries = shifts("2026-11-02", 10, 300); // 10 × 5 h
    const allocations: MonthAllocation[] = [{ employeeId: "e", month: "2026-11", minutes: 1200, status: "proposed" }];
    expect(validateAllocation({ entries, allocations, month: "2026-11", minutes: 1200, policy, provider })).toBe(1200);
    const s = summarizeMonth({ entries, allocations, month: "2026-11", policy, provider });
    expect(s.workedMinutes).toBe(3000);
    expect(s.allocatedMinutes).toBe(1200);
    expect(s.billingMinutes).toBe(1800);
    expect(s.balanceMinutes).toBe(-6000 + 1200);
    expect(s.cycle?.label).toBe("2026/27");
  });

  it("new school year starts again at −100 h, the old balance stays documented", () => {
    const entries = [...shifts("2027-05-03", 10, 300), ...shifts("2027-09-06", 2, 300)];
    const allocations: MonthAllocation[] = [{ employeeId: "e", month: "2027-05", minutes: 3000, status: "proposed" }];
    expect(summarizeMonth({ entries, allocations, month: "2027-05", policy, provider }).balanceMinutes).toBe(-3000);
    const aug = summarizeMonth({ entries, allocations, month: "2027-08", policy, provider });
    expect(aug.cycleStatus).toBe("vacation");
    expect(aug.balanceMinutes).toBe(-3000); // closed previous cycle
    const sep = summarizeMonth({ entries, allocations, month: "2027-09", policy, provider });
    expect(sep.cycle?.label).toBe("2027/28");
    expect(sep.balanceMinutes).toBe(-6000);
    const balances = cycleBalances({ allocations, policy, provider, now: new Date("2027-10-01T12:00:00Z") });
    expect(balances.map((b) => [b.cycle.label, b.balanceMinutes])).toEqual([["2026/27", -3000], ["2027/28", -6000]]);
    expect(() => validateAllocation({ entries, month: "2027-08", minutes: 60, policy, provider }))
      .toThrow("In den Sommerferien ist das Schuljahreskonto geschlossen. Für das neue Schuljahr beginnt ein neuer Stand von –100 Stunden.");
  });

  it("unknown 2031 holidays → no 2030/31 cycle, never guessed", () => {
    expect(schoolYearCycle(2029, provider)?.lastSchoolDay).toBe("2030-06-21");
    expect(schoolYearCycle(2030, provider)).toBeNull();
    expect(cycleStatusForMonth("2030-10", policy, provider)).toBe("unknown");
    expect(cycleStatusForMonth("2026-05", policy, provider)).toBe("before");
    expect(() => validateAllocation({ entries: shifts("2030-10-01", 1, 60), month: "2030-10", minutes: 60, policy, provider }))
      .toThrow("Für diesen Monat ist noch kein bestätigtes Schuljahr vorhanden. Bitte Ferienkalender online aktualisieren.");
    const s = summarizeMonth({ entries: shifts("2030-10-01", 1, 60), allocations: [], month: "2030-10", policy, provider });
    expect(s.cycle).toBeNull();
    expect(s.balanceMinutes).toBeNull();
    expect(s.billingMinutes).toBe(60);
  });

  it("pluggable provider: injected online value enables the cycle", async () => {
    const fetchFn = async () => ({ ok: true, json: async () => [
      { name: [{ text: "Osterferien" }], startDate: "2031-04-14", endDate: "2031-04-26" },
      { name: [{ text: "Sommerferien" }], startDate: "2031-07-14", endDate: "2031-08-26" },
    ] });
    const cache = await refreshHolidayCache(2031, {}, fetchFn);
    expect(cache).toEqual({ "2031": { start: "2031-07-14", end: "2031-08-26" } });
    expect(schoolYearCycle(2030, nrwHolidayProvider(cache))?.label).toBe("2030/31");
    expect(await refreshHolidayCache(2031, {}, async () => { throw new Error("offline"); })).toEqual({});
    expect(pickSummerHoliday("nope", 2031)).toBeNull();
    const custom = staticHolidayProvider({ 2026: { start: "2026-07-20", end: "2026-09-01" }, 2027: { start: "2027-07-19", end: "2027-08-31" } });
    expect(schoolYearCycle(2026, custom)?.start).toBe("2026-09-02");
  });

  it("calendar-year model: cycle 1 Jan – 31 Dec, opening from policy", () => {
    const cal: WorkAccountPolicy = { ...policy, model: "calendar-year", openingMinutes: -1200, startMonth: "2027-01", federalState: null };
    const entries = [...shifts("2027-07-28", 5, 480), ...shifts("2028-01-10", 1, 240)];
    const allocations: MonthAllocation[] = [{ employeeId: "e", month: "2027-07", minutes: 600, status: "proposed" }];
    const jul = summarizeMonth({ entries, allocations, month: "2027-07", policy: cal });
    expect(jul.cycleStatus).toBe("active"); // no summer-holiday gap in this model
    expect(jul.cycle).toMatchObject({ id: "2027", start: "2027-01-01", end: "2027-12-31" });
    expect(jul.eligibleMinutes).toBe(5 * 480 - 480); // 28–31 Jul count, 1 Aug is outside July
    expect(jul.balanceMinutes).toBe(-600);
    expect(summarizeMonth({ entries, allocations, month: "2028-01", policy: cal }).balanceMinutes).toBe(-1200);
    expect(cycleStatusForMonth("2026-12", cal)).toBe("before");
    expect(() => validateAllocation({ entries, month: "2026-12", minutes: 1, policy: cal })).toThrow("erst ab 01-2027");
    expect(() => validateAllocation({ entries, month: "2027-07", minutes: 99999, policy: cal })).toThrow("Du kannst höchstens 32,00 Stunden dieses Monats übertragen.");
    expect(cycleBalances({ allocations, policy: cal, now: new Date("2028-02-01T00:00:00") }).map((x) => [x.cycle.id, x.balanceMinutes]))
      .toEqual([["2027", -600], ["2028", -1200]]);
  });

  it("disabled account: status disabled, no allocation, billing = worked", () => {
    const off: WorkAccountPolicy = { ...policy, enabled: false };
    const entries = shifts("2026-11-02", 2, 300);
    const allocations: MonthAllocation[] = [{ employeeId: "e", month: "2026-11", minutes: 100, status: "approved" }];
    const s = summarizeMonth({ entries, allocations, month: "2026-11", policy: off });
    expect(s).toMatchObject({ cycleStatus: "disabled", workedMinutes: 600, allocatedMinutes: 0, billingMinutes: 600, balanceMinutes: null, cycle: null });
    expect(() => validateAllocation({ entries, month: "2026-11", minutes: 0, policy: off })).toThrow("nicht aktiviert");
    expect(cycleBalances({ allocations, policy: off })).toEqual([]);
  });

  it("approval workflow: rejected never counts; approvalRequired counts only approved", () => {
    const entries = shifts("2026-11-02", 2, 300);
    const rejected: MonthAllocation[] = [{ employeeId: "e", month: "2026-11", minutes: 100, status: "rejected" }];
    expect(summarizeMonth({ entries, allocations: rejected, month: "2026-11", policy }).allocatedMinutes).toBe(0);
    const strict = { ...policy, approvalRequired: true };
    const proposed: MonthAllocation[] = [{ employeeId: "e", month: "2026-11", minutes: 100, status: "proposed" }];
    expect(summarizeMonth({ entries, allocations: proposed, month: "2026-11", policy: strict }).allocatedMinutes).toBe(0);
    expect(summarizeMonth({ entries, allocations: [{ ...proposed[0]!, status: "approved" }], month: "2026-11", policy: strict }).allocatedMinutes).toBe(100);
  });
});

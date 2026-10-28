import { describe, expect, it } from "vitest";
import { MemoryStorage, loadWorkAccount } from "./support/load-legacy";
import type { Shift } from "./support/legacy-types";

const EID = "E1001";
const NOW = "2026-11-20T10:00:00+01:00";
const wa = () => loadWorkAccount({ now: NOW });

/** n shifts of 10 h net (08:00–18:45, 45 min pause) on consecutive weekdays from `firstDay`. */
function tenHourDays(firstDay: string, n: number): Shift[] {
  const out: Shift[] = [];
  const d = new Date(firstDay + "T12:00:00Z");
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push({ id: "s" + out.length + firstDay, date: d.toISOString().slice(0, 10), start: "08:00", end: "18:45", pause: 45 });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const H = (h: number) => h * 60;

describe("NRW school-year cycles (official table)", () => {
  it("uses the official summer holiday table 2026–2030", () => {
    const api = wa();
    expect(api.OFFICIAL[2026]).toEqual({ start: "2026-07-20", end: "2026-09-01" });
    expect(api.OFFICIAL[2027]).toEqual({ start: "2027-07-19", end: "2027-08-31" });
    expect(api.OFFICIAL[2028]).toEqual({ start: "2028-07-10", end: "2028-08-22" });
    expect(api.OFFICIAL[2029]).toEqual({ start: "2029-07-02", end: "2029-08-14" });
    expect(api.OFFICIAL[2030]).toEqual({ start: "2030-06-24", end: "2030-08-06" });
  });

  it("2026/27 starts 2026-09-02 and its last school day is Friday 2027-07-16", () => {
    const c = wa().cycle(2026)!;
    expect(c).toMatchObject({
      year: 2026,
      label: "2026/27",
      start: "2026-09-02",
      lastSchoolDay: "2027-07-16",
      summerStart: "2027-07-19",
      summerEnd: "2027-08-31",
      afterSummerStart: "2027-09-01",
      source: "Offizieller NRW-Ferienkalender",
    });
  });

  it("derives the following school years from the table (last school day skips weekends)", () => {
    const api = wa();
    expect(api.cycle(2027)).toMatchObject({ label: "2027/28", start: "2027-09-01", lastSchoolDay: "2028-07-07" });
    expect(api.cycle(2028)).toMatchObject({ label: "2028/29", start: "2028-08-23", lastSchoolDay: "2029-06-29" });
    expect(api.cycle(2029)).toMatchObject({ label: "2029/30", start: "2029-08-15", lastSchoolDay: "2030-06-21" });
  });

  it("returns null for school years whose dates are not officially known (no invented dates)", () => {
    const api = wa();
    expect(api.holiday(2031)).toBeNull();
    expect(api.cycle(2030)).toBeNull();
    expect(api.cycle(2031)).toBeNull();
    expect(api.cycle(2025)).toBeNull();
    expect(api.schoolYearForDate("2030-10-01")).toBeNull();
    expect(api.calendarForMonth("2030-10")).toMatchObject({ status: "unknown", year: null, label: "Termin offen" });
    expect(api.calendarForMonth("2026-05")).toMatchObject({ status: "before", year: null });
  });

  it("accepts a plausible cached online holiday row for unknown years, rejects implausible ones", () => {
    const good = loadWorkAccount({ now: NOW, storage: { uwe_nrw_sommerferien_v2: JSON.stringify({ 2031: { start: "2031-07-14", end: "2031-08-26" } }) } });
    expect(good.holiday(2031)).toMatchObject({ start: "2031-07-14", source: "OpenHolidays Online-Ferienkalender" });
    expect(good.cycle(2030)).toMatchObject({ start: "2030-08-07", lastSchoolDay: "2031-07-11" });

    for (const row of [
      { start: "2031-12-01", end: "2031-12-20" }, // not a summer month
      { start: "2031-02-30", end: "2031-03-20" }, // impossible date
      { start: "2031-08-20", end: "2031-07-14" }, // end before start
      "2031-07-14", // legacy v1 cache format (plain string)
    ]) {
      const api = loadWorkAccount({ storage: { uwe_nrw_sommerferien_v2: JSON.stringify({ 2031: row }) } });
      expect(api.holiday(2031)).toBeNull();
    }
    const corrupt = loadWorkAccount({ storage: { uwe_nrw_sommerferien_v2: "{not json" } });
    expect(corrupt.holiday(2031)).toBeNull();
  });

  it("findHolidayOnline does not invent dates when offline", async () => {
    const api = wa();
    await expect(api.findHolidayOnline(2031)).resolves.toBeNull();
    expect(api.storage.getItem("uwe_nrw_sommerferien_v2")).toBeNull();
  });

  it("maps dates and months to school year / vacation correctly", () => {
    const api = wa();
    expect(api.schoolYearForDate("2026-09-01")).toBeNull(); // last summer holiday day
    expect(api.schoolYearForDate("2026-09-02")?.label).toBe("2026/27");
    expect(api.schoolYearForDate("2027-07-16")?.label).toBe("2026/27");
    expect(api.schoolYearForDate("2027-07-19")).toBeNull();
    expect(api.schoolYearForDate("2027-09-01")?.label).toBe("2027/28");
    expect(api.calendarForMonth("2026-09")).toMatchObject({ status: "active", year: 2026 });
    expect(api.calendarForMonth("2027-07")).toMatchObject({ status: "active", year: 2026 });
    expect(api.calendarForMonth("2027-08")).toMatchObject({ status: "vacation", year: 2026, summerStart: "2027-07-19", afterSummerStart: "2027-09-01" });
    expect(api.calendarForMonth("2027-09")).toMatchObject({ status: "active", year: 2027 });
    expect(() => api.calendarForMonth("2026-13")).toThrow(/gültigen Monat/);
  });
});

describe("work account state", () => {
  it("opens every school year with −100 h (−6000 min)", () => {
    const api = wa();
    expect(api.START_MINUTES).toBe(-6000);
    expect(api.initial(EID)).toEqual({ version: 2, eid: EID, openingMinutes: -6000, startMonth: "2026-09", allocations: {} });
    expect(api.balanceForCycle(api.initial(EID), 2026)).toBe(-6000);
    expect(api.balanceForCycle(api.initial(EID), 2027)).toBe(-6000);
  });

  it("example: 50 h worked − 20 h allocated = 30 h for billing, balance −80 h", () => {
    const api = wa();
    const records = tenHourDays("2026-11-02", 5);
    expect(api.worked(records, "2026-11")).toBe(H(50));
    const state = api.update(api.initial(EID), records, "2026-11", H(20));
    const s = api.summary(state, records, "2026-11");
    expect(s).toMatchObject({ total: H(50), eligibleWorked: H(50), allocated: H(20), available: H(30), balance: -6000 + H(20), remainingToZero: H(80) });
    expect(api.hours(s.available)).toBe("30,00");
    expect(api.hours(s.balance)).toBe("-80,00");
    expect(s.progressPct).toBe(20);
  });

  it("no double booking: a second allocation for the same month replaces the first", () => {
    const api = wa();
    const records = tenHourDays("2026-11-02", 5);
    let state = api.update(api.initial(EID), records, "2026-11", H(20));
    state = api.update(state, records, "2026-11", H(10));
    expect(state.allocations).toEqual({ "2026-11": H(10) });
    expect(api.summary(state, records, "2026-11")).toMatchObject({ allocated: H(10), available: H(40), balance: -6000 + H(10) });
    state = api.update(state, records, "2026-11", 0);
    expect(state.allocations).toEqual({});
  });

  it("allocations are limited to hours worked during school time", () => {
    const api = wa();
    // July 2027: school until Fri 16th, summer holidays from Mon 19th.
    const records: Shift[] = [
      { date: "2027-07-15", start: "08:00", end: "16:30", pause: 30 },
      { date: "2027-07-20", start: "08:00", end: "16:30", pause: 30 },
    ];
    expect(api.worked(records, "2027-07")).toBe(H(16));
    expect(api.eligibleWorked(records, "2027-07")).toBe(H(8));
    expect(() => api.update(api.initial(EID), records, "2027-07", H(9))).toThrow(/höchstens 8,00 Stunden/);
    const ok = api.update(api.initial(EID), records, "2027-07", H(8));
    expect(api.summary(ok, records, "2027-07")).toMatchObject({ total: H(16), allocated: H(8), available: H(8) });
  });

  it("September 1st 2026 (holiday) is not eligible, September 2nd is", () => {
    const api = wa();
    const records: Shift[] = [
      { date: "2026-09-01", start: "08:00", end: "12:00", pause: 0 },
      { date: "2026-09-02", start: "08:00", end: "12:00", pause: 0 },
    ];
    expect(api.eligibleWorked(records, "2026-09")).toBe(H(4));
  });

  it("vacation months are closed for allocations", () => {
    const api = wa();
    const records: Shift[] = [{ date: "2027-08-10", start: "08:00", end: "16:30", pause: 30 }];
    expect(() => api.update(api.initial(EID), records, "2027-08", H(1))).toThrow(/Sommerferien/);
    expect(api.eligibleWorked(records, "2027-08")).toBe(0);
    expect(api.summary(api.initial(EID), records, "2027-08")).toMatchObject({ eligible: false, total: H(8), eligibleWorked: 0 });
  });

  it("unknown school years are closed for allocations", () => {
    const api = wa();
    const records: Shift[] = [{ date: "2030-10-10", start: "08:00", end: "16:30", pause: 30 }];
    expect(() => api.update(api.initial(EID), records, "2030-10", H(1))).toThrow(/kein bestätigtes Schuljahr/);
  });

  it("a new school year starts again at −100 h while the old year keeps its balance", () => {
    const api = wa();
    const records = [...tenHourDays("2027-06-01", 3), ...tenHourDays("2027-09-06", 2)];
    let state = api.update(api.initial(EID), records, "2027-06", H(25));
    state = api.update(state, records, "2027-09", H(5));
    expect(api.balanceForCycle(state, 2026)).toBe(-6000 + H(25));
    expect(api.balanceForCycle(state, 2027)).toBe(-6000 + H(5));
    expect(api.summary(state, records, "2027-09")).toMatchObject({ balance: -6000 + H(5), overallBalance: -6000 + H(5) });
    expect(api.summary(state, records, "2027-06").balance).toBe(-6000 + H(25));
    // Summer holidays in between show the closed previous year.
    expect(api.summary(state, records, "2027-08")).toMatchObject({ balance: -6000 + H(25) });
  });

  it("balance 'through month' only counts allocations up to that month", () => {
    const api = wa();
    const records = [...tenHourDays("2026-10-05", 2), ...tenHourDays("2026-11-02", 2)];
    let state = api.update(api.initial(EID), records, "2026-10", H(10));
    state = api.update(state, records, "2026-11", H(15));
    const oct = api.summary(state, records, "2026-10");
    expect(oct.balance).toBe(-6000 + H(10));
    expect(oct.overallBalance).toBe(-6000 + H(25));
  });

  it("cyclesWithBalances lists running and past school years", () => {
    const api = loadWorkAccount({ now: "2027-10-01T10:00:00+02:00" });
    const records = [...tenHourDays("2027-06-01", 2), ...tenHourDays("2027-09-06", 1)];
    let state = api.update(api.initial(EID), records, "2027-06", H(20));
    state = api.update(state, records, "2027-09", H(10));
    const list = api.cyclesWithBalances(state);
    expect(list.map((x) => [x.cycle.label, x.balance])).toEqual([
      ["2026/27", -6000 + H(20)],
      ["2027/28", -6000 + H(10)],
    ]);
  });

  it("invalidAllocations detects allocations that exceed school-time hours (e.g. after deleting shifts)", () => {
    const api = wa();
    const records = tenHourDays("2026-11-02", 2);
    const state = api.update(api.initial(EID), records, "2026-11", H(20));
    expect(api.invalidAllocations(state, records.slice(0, 1))).toEqual([{ month: "2026-11", allocated: H(20), worked: H(10) }]);
    expect(api.invalidAllocations(state, records)).toEqual([]);
  });

  it("midnight shifts count fully in the month of their start date", () => {
    const api = wa();
    const records: Shift[] = [{ date: "2026-11-30", start: "22:00", end: "06:00", pause: 30 }];
    expect(api.worked(records, "2026-11")).toBe(450);
    expect(api.worked(records, "2026-12")).toBe(0);
  });
});

describe("validate / load / persist", () => {
  it("round-trips through localStorage under uwe_arbeitszeitkonto_v1_<eid>", () => {
    const api = wa();
    const records = tenHourDays("2026-11-02", 5);
    const state = api.persist(api.update(api.initial(EID), records, "2026-11", H(20)));
    expect(JSON.parse(api.storage.getItem("uwe_arbeitszeitkonto_v1_E1001")!)).toEqual(state);
    expect(api.load(EID)).toEqual(state);
  });

  it("load() returns a fresh −100 h account when nothing is stored", () => {
    expect(wa().load("E9999")).toMatchObject({ openingMinutes: -6000, allocations: {} });
  });

  it("rejects data belonging to another employee", () => {
    const api = wa();
    expect(() => api.validate({ ...api.initial("E2000") }, EID)).toThrow(/anderen Mitarbeiter/);
    const store = new MemoryStorage({ uwe_arbeitszeitkonto_v1_E1001: JSON.stringify(api.initial("E2000")) });
    expect(() => api.load(EID, store)).toThrow(/anderen Mitarbeiter/);
  });

  it.each([
    ["null", null],
    ["unknown version", { version: 3, eid: EID, openingMinutes: -6000, allocations: {} }],
    ["tampered opening balance", { version: 2, eid: EID, openingMinutes: 0, allocations: {} }],
    ["allocations as array", { version: 2, eid: EID, openingMinutes: -6000, allocations: [] }],
    ["allocations missing", { version: 2, eid: EID, openingMinutes: -6000 }],
  ])("rejects corrupt account data: %s", (_label, data) => {
    expect(() => wa().validate(data, EID)).toThrow(/beschädigt/);
  });

  it.each([
    ["month before 2026-09", { "2026-08": 60 }],
    ["malformed month", { "2026-13": 60 }],
    ["negative minutes", { "2026-11": -60 }],
    ["fractional minutes", { "2026-11": 60.5 }],
    ["string minutes", { "2026-11": "60" }],
    ["absurd amount", { "2026-11": 600001 }],
  ])("rejects invalid stored allocations: %s", (_label, allocations) => {
    expect(() => wa().validate({ version: 2, eid: EID, openingMinutes: -6000, allocations }, EID)).toThrow(/Ungültiger gespeicherter/);
  });

  it("rejects invalid personnel numbers", () => {
    expect(() => wa().initial("E 1001")).toThrow(/Personalnummer/);
    expect(() => wa().load("../x")).toThrow(/Personalnummer/);
  });

  it("load() surfaces unparsable JSON as an exception (the app then blocks the account UI)", () => {
    const store = new MemoryStorage({ uwe_arbeitszeitkonto_v1_E1001: "{broken" });
    expect(() => wa().load(EID, store)).toThrow(/JSON/);
  });

  it("upgrades version-1 accounts (startMonth 2026-11, initialDeadline) to version 2 and drops zero allocations", () => {
    const v1 = { version: 1, eid: EID, openingMinutes: -6000, startMonth: "2026-11", initialDeadline: "2027-07-19", allocations: { "2026-11": 1200, "2026-12": 0 } };
    expect(wa().validate(v1, EID)).toEqual({ version: 2, eid: EID, openingMinutes: -6000, startMonth: "2026-09", allocations: { "2026-11": 1200 } });
  });
});

describe("helpers", () => {
  it("parseHours accepts German decimal comma and rejects garbage", () => {
    const api = wa();
    expect(api.parseHours("20")).toBe(1200);
    expect(api.parseHours("12,5")).toBe(750);
    expect(api.parseHours("0,25")).toBe(15);
    for (const bad of ["", "-1", "abc", "1,234", "100000"]) expect(() => api.parseHours(bad)).toThrow();
  });

  it("formats hours and dates the German way", () => {
    const api = wa();
    expect(api.hours(-6000)).toBe("-100,00");
    expect(api.hours(90)).toBe("1,50");
    expect(api.formatDate("2027-07-16")).toBe("16.07.2027");
  });

  it("nextSummer / daysUntil respect the frozen reference date", () => {
    const api = wa();
    expect(api.nextSummer(new Date(2026, 10, 20))).toMatchObject({ year: 2027, start: "2027-07-19" });
    expect(api.daysUntil("2027-07-16", new Date(2026, 10, 20))).toBe(238);
  });
});

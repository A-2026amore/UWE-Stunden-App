import { describe, expect, it } from "vitest";
import type { ShiftLike } from "./types";
import {
  BREAK_RULE_THRESHOLDS, NEW_TENANT_BREAK_RULE, UWE_BREAK_POLICY, breakRuleKind, breakRuleSummary, defaultBreakPolicy, errorsForMonth,
  evaluateDay, issueForDay, necessaryPause, requiredPauseText, statutoryBreakProblems, suggestedPause, thresholdLabel, thresholdsFor,
  validateBreakPolicy,
} from "./breaks";
import { loadLegacy } from "./__legacy__/loadLegacy";
import { clock, int, pick, rng } from "./__legacy__/random";

const legacy = loadLegacy(["uwe-break-rules.js"]).window.UweBreakRules;
const plain = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const DURATIONS = [359, 360, 361, 539, 540, 541, 719, 720, 721, 1, 15, 30, 240, 480, 600, 1439];
const PAUSES = [0, 0, 0, 14, 15, 16, 29, 30, 44, 45, 60, -1, 1.5];
const GAPS = [0, 1, 14, 15, 16, 30, 60, -10];
const STARTS = [0, 1, 360, 420, 480, 1080, 1320, 1380, 1439, 1425];
const BAD_CLOCKS = ["24:00", "7:00", "", "12:60", "aa:bb"];

function genDay(r: () => number, date: string): ShiftLike[] {
  const count = int(r, 1, 4);
  const out: ShiftLike[] = [];
  let cursor = r() < 0.5 ? pick(r, STARTS) : int(r, 0, 1439);
  for (let i = 0; i < count; i++) {
    const duration = r() < 0.6 ? pick(r, DURATIONS) : int(r, 1, 800);
    const start = cursor;
    const end = start + duration;
    const pause = r() < 0.7 ? pick(r, PAUSES) : r() < 0.5 ? int(r, 0, duration + 5) : duration;
    const shift: ShiftLike = { id: "s" + i + "-" + date, date, start: clock(start), end: clock(end), pause };
    if (r() < 0.03) shift.start = pick(r, BAD_CLOCKS);
    if (r() < 0.02) shift.end = clock(start); // start == end
    out.push(shift);
    // Mostly sequential blocks, sometimes overlapping (negative gap) or unordered.
    cursor = r() < 0.3 ? start + int(r, 0, duration) : end + (r() < 0.7 ? pick(r, GAPS) : int(r, 0, 300));
  }
  return out;
}

describe("breaks – equivalence with legacy uwe-break-rules.js", () => {
  it("necessaryPause matches legacy for every gross minute 0..1500", () => {
    for (let g = -5; g <= 1500; g++) expect(necessaryPause(g)).toBe(legacy.necessary(g));
    expect(necessaryPause(NaN)).toBe(legacy.necessary(NaN));
  });

  it("evaluateDay / issueForDay / suggestedPause / errorsForMonth for 5000 random days", () => {
    const r = rng(20261026);
    let checked = 0;
    const seen = { valid: 0, missing: 0, overlap: 0, tooLong: 0, bad: 0 };
    for (let n = 0; n < 5000; n++) {
      const d1 = "2026-11-" + String(int(r, 1, 27)).padStart(2, "0");
      const d2 = d1.slice(0, 8) + String(Number(d1.slice(8)) + 1).padStart(2, "0");
      const shifts = [...genDay(r, d1), ...(r() < 0.4 ? genDay(r, d2) : [])];
      for (const date of [d1, d2]) {
        const a = evaluateDay(shifts, date);
        const b = plain(legacy.evaluateDay(shifts, date));
        expect(a).toEqual(b);
        expect(issueForDay(a)).toBe(legacy.issueForDay(b));
        checked++;
        if (a.valid) seen.valid++;
        if ((a.missing ?? 0) > 0) seen.missing++;
        if (a.overlap) seen.overlap++;
        if (a.tooLong) seen.tooLong++;
        if (!a.valid && !a.overlap && !a.tooLong) seen.bad++;
      }
      expect(errorsForMonth(shifts, "2026-11")).toEqual(plain(legacy.errorsForMonth(shifts, "2026-11")));
      // suggestedPause for an existing shift (edit) and for a new shift.
      const target = pick(r, shifts);
      expect(suggestedPause(target, shifts)).toBe(legacy.suggestedPause(target, shifts));
      const fresh = { date: d1, start: clock(int(r, 0, 1439)), end: clock(int(r, 0, 1439)), pause: 0 };
      expect(suggestedPause(fresh, shifts)).toBe(legacy.suggestedPause(fresh, shifts));
    }
    expect(checked).toBe(10000);
    // The generator must cover every outcome category substantially.
    for (const v of Object.values(seen)) expect(v).toBeGreaterThan(50);
  });
});

describe("breaks – explicit cases", () => {
  const day = (...s: [string, string, number][]) => s.map(([start, end, pause], i) => ({ id: "x" + i, date: "2026-11-02", start, end, pause }));
  it("thresholds are inclusive (exactly 6 h / 9 h)", () => {
    expect(evaluateDay(day(["08:00", "14:00", 0]), "2026-11-02").required).toBe(30);
    expect(evaluateDay(day(["08:00", "13:59", 0]), "2026-11-02").required).toBe(0);
    expect(evaluateDay(day(["08:00", "17:00", 0]), "2026-11-02").required).toBe(45);
  });
  it("12 h limit per shift and per day", () => {
    expect(evaluateDay(day(["06:00", "18:00", 45]), "2026-11-02").valid).toBe(true);
    expect(evaluateDay(day(["06:00", "18:01", 45]), "2026-11-02").reason).toContain("höchstens 12 Stunden");
    expect(evaluateDay(day(["00:00", "07:00", 30], ["08:00", "14:00", 30]), "2026-11-02").reason).toContain("mehr als 12 Stunden");
  });
  it("gaps of 15 minutes count as rest, 14 do not", () => {
    expect(evaluateDay(day(["08:00", "11:00", 0], ["11:15", "14:15", 15]), "2026-11-02").missing).toBe(0);
    expect(evaluateDay(day(["08:00", "11:00", 0], ["11:14", "14:14", 15]), "2026-11-02").missing).toBe(15);
  });
  it("pause pieces under 15 minutes are not recognised", () => {
    const e = evaluateDay(day(["08:00", "12:00", 14], ["12:00", "15:00", 14]), "2026-11-02");
    expect(e.recognized).toBe(0);
    expect(e.missing).toBe(30);
    expect(issueForDay(e)).toContain("Es fehlen noch 30 Minuten");
  });
  it("custom policy generalises thresholds", () => {
    const policy = { thresholds: [{ minGrossMinutes: 361, minPauseMinutes: 30 }], maxShiftMinutes: 600, minPauseSegmentMinutes: 10 };
    expect(evaluateDay(day(["08:00", "14:00", 0]), "2026-11-02", policy).required).toBe(0);
    expect(evaluateDay(day(["08:00", "18:30", 30]), "2026-11-02", policy).reason).toContain("höchstens 10 Stunden");
    expect(UWE_BREAK_POLICY.maxShiftMinutes).toBe(720);
  });
});

describe("breaks – statutory vs. strict rule (§4 ArbZG, client 2026-10-28)", () => {
  const STATUTORY = { thresholds: thresholdsFor("statutory"), maxShiftMinutes: 600, minPauseSegmentMinutes: 15 };
  const STRICT = { thresholds: thresholdsFor("strict"), maxShiftMinutes: 720, minPauseSegmentMinutes: 15 };
  const one = (start: string, end: string, pause: number) => [{ id: "a", date: "2026-11-02", start, end, pause }];
  const valid = (start: string, end: string, pause: number, policy: typeof STRICT) =>
    issueForDay(evaluateDay(one(start, end, pause), "2026-11-02", policy), policy) === "";

  it("6:00 exactly without pause: valid under the statutory rule, invalid under the strict rule", () => {
    expect(valid("08:00", "14:00", 0, STATUTORY)).toBe(true);
    expect(valid("08:00", "14:00", 0, STRICT)).toBe(false);
  });
  it("6:01 needs 30 minutes under both rules", () => {
    for (const p of [STATUTORY, STRICT]) {
      expect(valid("08:00", "14:01", 0, p)).toBe(false);
      expect(valid("08:00", "14:01", 29, p)).toBe(false);
      expect(valid("08:00", "14:01", 30, p)).toBe(true);
    }
  });
  it("9:00 exactly with 30 minutes: valid statutory, strict needs 45; 9:01 needs 45 under both", () => {
    expect(valid("08:00", "17:00", 30, STATUTORY)).toBe(true);
    expect(valid("08:00", "17:00", 30, STRICT)).toBe(false);
    expect(valid("08:00", "17:00", 45, STRICT)).toBe(true);
    for (const p of [STATUTORY, STRICT]) {
      expect(valid("08:00", "17:01", 30, p)).toBe(false);
      expect(valid("08:00", "17:01", 45, p)).toBe(true);
    }
  });
  it("pause pieces under 15 minutes do not count under the statutory rule either", () => {
    const day = evaluateDay([{ id: "a", date: "2026-11-02", start: "08:00", end: "12:00", pause: 14 }, { id: "b", date: "2026-11-02", start: "12:00", end: "15:00", pause: 14 }], "2026-11-02", STATUTORY);
    expect(day.missing).toBe(30);
  });
  it("UWE keeps the strict rule; new tenants get the configured default", () => {
    expect(breakRuleKind(UWE_BREAK_POLICY)).toBe("strict");
    expect(NEW_TENANT_BREAK_RULE).toBe("statutory");
    expect(breakRuleKind(defaultBreakPolicy())).toBe(NEW_TENANT_BREAK_RULE);
    expect(defaultBreakPolicy()).toEqual({ thresholds: [{ minGrossMinutes: 361, minPauseMinutes: 30 }, { minGrossMinutes: 541, minPauseMinutes: 45 }], maxShiftMinutes: 600, minPauseSegmentMinutes: 15 });
    expect(breakRuleKind({ ...STRICT, thresholds: [{ minGrossMinutes: 300, minPauseMinutes: 30 }] })).toBe("custom");
  });
  it("wording follows the configuration: 360 → 'ab 6 Stunden', 361 → 'mehr als 6 Stunden'", () => {
    expect(thresholdLabel(360)).toBe("ab 6 Stunden");
    expect(thresholdLabel(361)).toBe("mehr als 6 Stunden");
    expect(thresholdLabel(540)).toBe("ab 9 Stunden");
    expect(thresholdLabel(541)).toBe("mehr als 9 Stunden");
    expect(thresholdLabel(390)).toBe("ab 6,5 Stunden");
    expect(thresholdLabel(60)).toBe("ab 1 Stunde");
    expect(breakRuleSummary(STRICT)).toBe("ab 6 Stunden Arbeitszeit mindestens 30 Minuten Pause, ab 9 Stunden mindestens 45 Minuten");
    expect(breakRuleSummary(STATUTORY)).toBe("bei mehr als 6 Stunden Arbeitszeit mindestens 30 Minuten Pause, bei mehr als 9 Stunden mindestens 45 Minuten");
  });
  it("required pause text names minimum and rule of the day", () => {
    const d = (end: string, p: typeof STRICT) => requiredPauseText(evaluateDay(one("08:00", end, 0), "2026-11-02", p), p);
    expect(d("14:00", STRICT)).toBe("Für diesen Tag (6,00 Std. Einsatzzeit) sind mindestens 30 Minuten Pause vorgeschrieben (Regel: ab 6 Stunden).");
    expect(d("14:00", STATUTORY)).toBe("Für diesen Tag (6,00 Std. Einsatzzeit) ist keine Mindestpause vorgeschrieben (Pausenpflicht erst mehr als 6 Stunden).");
    expect(d("17:30", STATUTORY)).toBe("Für diesen Tag (9,50 Std. Einsatzzeit) sind mindestens 45 Minuten Pause vorgeschrieben (Regel: mehr als 9 Stunden).");
    expect(d("12:00", STRICT)).toContain("keine Mindestpause vorgeschrieben (Pausenpflicht erst ab 6 Stunden)");
  });
  it("stricter configurations are accepted, laxer ones rejected", () => {
    expect(validateBreakPolicy(STATUTORY)).toEqual([]);
    expect(validateBreakPolicy(STRICT)).toEqual([]);
    expect(validateBreakPolicy({ ...STRICT, thresholds: [{ minGrossMinutes: 240, minPauseMinutes: 45 }] })).toEqual([]);
    expect(statutoryBreakProblems({ ...STRICT, thresholds: [{ minGrossMinutes: 362, minPauseMinutes: 30 }, { minGrossMinutes: 541, minPauseMinutes: 45 }] })[0])
      .toContain("bei mehr als 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben");
    expect(validateBreakPolicy({ ...STRICT, thresholds: [{ minGrossMinutes: 361, minPauseMinutes: 30 }, { minGrossMinutes: 541, minPauseMinutes: 40 }] })[0])
      .toContain("bei mehr als 9 Stunden");
    expect(validateBreakPolicy({ ...STRICT, thresholds: [] })).toHaveLength(2);
    expect(validateBreakPolicy({ ...STRICT, minPauseSegmentMinutes: 10 })[0]).toContain("unter 15 Minuten");
    expect(validateBreakPolicy({ ...STRICT, thresholds: [...BREAK_RULE_THRESHOLDS.strict].reverse() })[0]).toContain("aufsteigend");
  });
});

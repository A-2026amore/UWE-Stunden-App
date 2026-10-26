import { describe, expect, it } from "vitest";
import { loadBreakRules } from "./support/load-legacy";
import type { Shift } from "./support/legacy-types";

const rules = loadBreakRules();
const D = "2026-11-10";
const shift = (start: string, end: string, pause = 0, extra: Partial<Shift> = {}): Shift => ({
  date: D,
  start,
  end,
  pause,
  ...extra,
});

describe("UweBreakRules.gross / necessary", () => {
  it("computes gross minutes, including shifts across midnight", () => {
    expect(rules.gross(shift("08:00", "16:00"))).toBe(480);
    expect(rules.gross(shift("22:00", "06:00"))).toBe(480);
    expect(rules.gross(shift("23:30", "00:15"))).toBe(45);
  });

  it("rejects malformed or zero-length times", () => {
    expect(rules.gross(shift("8:00", "16:00"))).toBeNaN();
    expect(rules.gross(shift("24:00", "06:00"))).toBeNaN();
    expect(rules.gross(shift("08:60", "09:00"))).toBeNaN();
    expect(rules.gross(shift("08:00", "08:00"))).toBeNaN();
    expect(rules.gross(null)).toBeNaN();
  });

  it("UWE policy: exactly 6:00 h -> 30 min, 5:59 h -> 0, exactly 9:00 h -> 45, 8:59 h -> 30", () => {
    expect(rules.necessary(360)).toBe(30);
    expect(rules.necessary(359)).toBe(0);
    expect(rules.necessary(540)).toBe(45);
    expect(rules.necessary(539)).toBe(30);
    expect(rules.necessary(0)).toBe(0);
    expect(rules.necessary(Number.NaN)).toBe(0);
  });
});

describe("UweBreakRules.evaluateDay – single shift", () => {
  it("exactly 6:00 h without pause is missing 30 min", () => {
    const day = rules.evaluateDay([shift("08:00", "14:00", 0)], D);
    expect(day).toMatchObject({ valid: true, required: 30, missing: 30, gross: 360, net: 360 });
  });

  it("5:59 h without pause is fine", () => {
    const day = rules.evaluateDay([shift("08:00", "13:59", 0)], D);
    expect(day).toMatchObject({ valid: true, required: 0, missing: 0 });
  });

  it("exactly 9:00 h gross requires 45 min", () => {
    expect(rules.evaluateDay([shift("08:00", "17:00", 30)], D)).toMatchObject({ required: 45, missing: 15 });
    expect(rules.evaluateDay([shift("08:00", "17:00", 45)], D)).toMatchObject({ required: 45, missing: 0, net: 495 });
  });

  it("pause pieces < 15 min are deducted but do not qualify as statutory break", () => {
    const day = rules.evaluateDay([shift("08:00", "15:00", 10)], D);
    expect(day).toMatchObject({ valid: true, required: 30, recognized: 0, entered: 10, missing: 30, net: 410 });
  });

  it("rejects a single shift longer than 12 h, accepts exactly 12 h", () => {
    const tooLong = rules.evaluateDay([shift("06:00", "18:01", 45)], D);
    expect(tooLong).toMatchObject({ valid: false, tooLong: true });
    expect(tooLong.reason).toMatch(/höchstens 12 Stunden/);
    expect(rules.evaluateDay([shift("06:00", "18:00", 45)], D)).toMatchObject({ valid: true, required: 45, missing: 0 });
  });

  it("rejects pause >= duration, negative or fractional pause", () => {
    expect(rules.evaluateDay([shift("08:00", "09:00", 60)], D).valid).toBe(false);
    expect(rules.evaluateDay([shift("08:00", "09:00", -5)], D).valid).toBe(false);
    expect(rules.evaluateDay([shift("08:00", "09:00", 7.5)], D).valid).toBe(false);
  });

  it("midnight shift 22:00–06:00 is 8 h and needs 30 min", () => {
    expect(rules.evaluateDay([shift("22:00", "06:00", 0)], D)).toMatchObject({ valid: true, gross: 480, required: 30, missing: 30 });
    expect(rules.evaluateDay([shift("22:00", "06:00", 30)], D)).toMatchObject({ valid: true, missing: 0, net: 450 });
  });
});

describe("UweBreakRules.evaluateDay – several shifts per day", () => {
  it("sums gross time of all blocks of the same date and ignores other dates", () => {
    const items = [shift("06:00", "09:00"), shift("12:00", "15:30", 30), { ...shift("08:00", "20:00"), date: "2026-11-11" }];
    const day = rules.evaluateDay(items, D);
    expect(day).toMatchObject({ valid: true, shiftCount: 2, gross: 390, entered: 30 });
  });

  it("back-to-back blocks of 6:30 h total still need 30 min", () => {
    const day = rules.evaluateDay([shift("06:00", "10:00"), shift("10:00", "12:30")], D);
    expect(day).toMatchObject({ required: 30, gaps: 0, missing: 30 });
  });

  it("a gap >= 15 min between blocks counts as break and is not deducted twice", () => {
    const day = rules.evaluateDay([shift("06:00", "10:00"), shift("10:30", "13:00")], D);
    expect(day).toMatchObject({ valid: true, required: 30, gaps: 30, qualifying: 30, missing: 0 });
    // Net time = gross time of the blocks minus entered pause only; the gap is not subtracted again.
    expect(day.net).toBe(390);
    expect(day.gross).toBe(390);
  });

  it("gap and entered pauses add up (15 min gap + 15 min pause = 30)", () => {
    const day = rules.evaluateDay([shift("06:00", "10:00", 15), shift("10:15", "13:00")], D);
    expect(day).toMatchObject({ gaps: 15, recognized: 15, qualifying: 30, missing: 0 });
  });

  it("a gap shorter than 15 min does not qualify", () => {
    const day = rules.evaluateDay([shift("06:00", "10:00"), shift("10:10", "12:40")], D);
    expect(day).toMatchObject({ gaps: 0, missing: 30 });
  });

  it("two pause pieces of 10 min each do not qualify", () => {
    const day = rules.evaluateDay([shift("06:00", "10:00", 10), shift("10:00", "13:00", 10)], D);
    expect(day).toMatchObject({ recognized: 0, entered: 20, missing: 30 });
  });

  it("gaps are only counted between sorted blocks (input order irrelevant)", () => {
    const day = rules.evaluateDay([shift("10:30", "13:00"), shift("06:00", "10:00")], D);
    expect(day.gaps).toBe(30);
  });

  it("rejects a day whose blocks together exceed 12 h", () => {
    const day = rules.evaluateDay([shift("05:00", "11:00", 30), shift("12:00", "18:30", 30)], D);
    expect(day).toMatchObject({ valid: false, tooLong: true, gross: 750 });
    expect(day.reason).toMatch(/zusammen mehr als 12 Stunden/);
  });

  it("accepts exactly 12 h spread over two blocks", () => {
    const day = rules.evaluateDay([shift("05:00", "11:00", 30), shift("12:00", "18:00", 15)], D);
    expect(day).toMatchObject({ valid: true, gross: 720, required: 45 });
  });

  it("rejects overlapping blocks", () => {
    const day = rules.evaluateDay([shift("08:00", "12:00"), shift("11:00", "14:00")], D);
    expect(day).toMatchObject({ valid: false, overlap: true });
  });

  it("rejects a same-day block overlapping the part of a midnight shift on the same date", () => {
    const day = rules.evaluateDay([shift("22:00", "06:00", 30), shift("23:00", "23:30")], D);
    expect(day).toMatchObject({ valid: false, overlap: true });
  });

  it("touching blocks (end == next start) are not an overlap", () => {
    expect(rules.evaluateDay([shift("08:00", "10:00"), shift("10:00", "11:00")], D).valid).toBe(true);
  });

  // Suspected legacy bug / business clarification needed (documented, NOT fixed):
  // The stated rule is "gaps >= 15 min between same-day blocks count as break". The code skips
  // the gap when the later block runs past midnight, so a morning block and an evening/night block
  // of the same date with a 12 h gap in between still demand an extra 30 min pause.
  it.fails("LEGACY BUG? gap before an overnight block of the same date is not counted as break", () => {
    const day = rules.evaluateDay([shift("06:00", "10:00"), shift("22:00", "02:00")], D);
    expect(day.valid).toBe(true);
    expect(day.missing).toBe(0); // actual: 30 (gap of 720 min ignored)
  });
});

describe("UweBreakRules.suggestedPause", () => {
  it("suggests 0 / 30 / 45 for a single block by its length", () => {
    expect(rules.suggestedPause(shift("08:00", "13:00"), [])).toBe(0);
    expect(rules.suggestedPause(shift("08:00", "14:00"), [])).toBe(30);
    expect(rules.suggestedPause(shift("08:00", "16:00"), [])).toBe(30);
    expect(rules.suggestedPause(shift("07:00", "17:00"), [])).toBe(45);
    expect(rules.suggestedPause(shift("22:00", "06:00"), [])).toBe(30);
  });

  it("ignores the pause typed into the candidate (evaluates it with 0)", () => {
    expect(rules.suggestedPause(shift("08:00", "16:00", 30), [])).toBe(30);
  });

  it("takes existing same-day blocks and their gap into account", () => {
    const saved = [shift("06:00", "10:00", 0, { id: "a" })];
    expect(rules.suggestedPause(shift("10:30", "13:00"), saved)).toBe(0);
    expect(rules.suggestedPause(shift("10:05", "13:00"), saved)).toBe(30);
  });

  it("suggests at least 15 min when less is missing", () => {
    const saved = [shift("06:00", "10:00", 20, { id: "a" })];
    // Day: 4 h + 3 h = 7 h -> 30 required, 20 already recognized, 10 missing -> rounded up to 15.
    expect(rules.suggestedPause(shift("10:00", "13:00"), saved)).toBe(15);
  });

  it("ignores blocks of other dates", () => {
    const saved = [{ ...shift("06:00", "12:00", 30, { id: "a" }), date: "2026-11-09" }];
    expect(rules.suggestedPause(shift("08:00", "13:00"), saved)).toBe(0);
  });

  it("when editing, the edited entry itself is excluded from the saved list", () => {
    const saved = [shift("08:00", "16:00", 30, { id: "edit-me" })];
    expect(rules.suggestedPause(shift("08:00", "13:00", 0, { id: "edit-me" }), saved)).toBe(0);
    // Without id the old version would overlap -> no suggestion.
    expect(rules.suggestedPause(shift("08:00", "13:00"), saved)).toBeNull();
  });

  it("returns null for invalid / too long / incomplete candidates", () => {
    expect(rules.suggestedPause(shift("06:00", "19:00"), [])).toBeNull();
    expect(rules.suggestedPause({ date: D, start: "", end: "16:00", pause: 0 }, [])).toBeNull();
    expect(rules.suggestedPause({ date: "", start: "08:00", end: "16:00", pause: 0 }, [])).toBeNull();
    expect(rules.suggestedPause(null, [])).toBeNull();
  });
});

describe("UweBreakRules.issueForDay / errorsForMonth", () => {
  it("returns an empty string for a compliant day", () => {
    expect(rules.issueForDay(rules.evaluateDay([shift("08:00", "16:00", 30)], D))).toBe("");
  });

  it("explains the missing minutes and mentions already counted gaps", () => {
    const msg = rules.issueForDay(rules.evaluateDay([shift("06:00", "10:00"), shift("10:15", "16:00")], D));
    expect(msg).toContain("mindestens 45 Minuten Pause erforderlich");
    expect(msg).toContain("Es fehlen noch 30 Minuten");
    expect(msg).toContain("15 Minuten zwischen den Einsätzen");
  });

  it("lists every non-compliant day of the month, sorted, and ignores other months", () => {
    const shifts: Shift[] = [
      { date: "2026-11-20", start: "08:00", end: "15:00", pause: 0 },
      { date: "2026-11-03", start: "06:00", end: "19:00", pause: 45 },
      { date: "2026-11-05", start: "08:00", end: "16:00", pause: 30 },
      { date: "2026-12-01", start: "08:00", end: "16:00", pause: 0 },
    ];
    const issues = rules.errorsForMonth(shifts, "2026-11");
    expect(issues.map((x) => x.date)).toEqual(["2026-11-03", "2026-11-20"]);
    expect(issues[0]!.message).toMatch(/12 Stunden/);
    expect(issues[1]!.message).toMatch(/Es fehlen noch 30 Minuten/);
    expect(rules.errorsForMonth(shifts, "2026-10")).toEqual([]);
    expect(rules.errorsForMonth([], "2026-11")).toEqual([]);
  });

  it("reports overlaps as month errors", () => {
    const issues = rules.errorsForMonth([shift("08:00", "12:00"), shift("11:00", "13:00")], "2026-11");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/überschneiden/);
  });
});

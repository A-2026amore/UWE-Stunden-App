/**
 * Break (pause) rules per working day.
 *
 * Port of the legacy uwe-break-rules.js with the thresholds generalised into
 * a tenant BreakPolicy. With UWE_BREAK_POLICY every output is identical to the
 * legacy module (proven by breaks.equivalence.test.ts).
 *
 * Saved hours are never changed automatically – these functions only
 * evaluate and suggest.
 *
 * Legal notes (documented, behaviour intentionally unchanged):
 *  - UWE applies the 30/45 minute thresholds from EXACTLY 6:00 / 9:00 hours
 *    of gross shift time ("ab genau 6 Stunden"). §4 ArbZG requires breaks for
 *    working time of MORE THAN 6 / 9 hours, measured as working time (net),
 *    so the UWE rule is stricter than the statute. That is a company policy
 *    decision, not a bug.
 *  - Gross time of all shifts of one calendar date is summed; a shift that
 *    crosses midnight counts completely for its start date.
 *  - Gaps of ≥ 15 minutes between separate same-day blocks count as rest
 *    (they are unpaid anyway); overnight blocks never contribute gap time.
 *  - The 12-hour limit (`maxShiftMinutes`) applies to the sum of gross time
 *    per date. Daily maximum working time under §3 ArbZG (8 h, up to 10 h)
 *    is NOT checked – unchanged from legacy.
 */
import type { BreakPolicy, DayEvaluation, ISODate, ISOMonth, ShiftLike } from "./types";
import { grossMinutes, parseClock } from "./time";

export const UWE_BREAK_POLICY: BreakPolicy = Object.freeze({
  thresholds: Object.freeze([
    Object.freeze({ minGrossMinutes: 360, minPauseMinutes: 30 }),
    Object.freeze({ minGrossMinutes: 540, minPauseMinutes: 45 }),
  ]) as unknown as BreakPolicy["thresholds"],
  maxShiftMinutes: 720,
  minPauseSegmentMinutes: 15,
}) as BreakPolicy;

/** Required pause for the given gross minutes (thresholds are inclusive). */
export function necessaryPause(gross: number, policy: BreakPolicy = UWE_BREAK_POLICY): number {
  if (!Number.isFinite(gross) || gross <= 0) return 0;
  let required = 0;
  for (const t of policy.thresholds) {
    if (gross >= t.minGrossMinutes && t.minPauseMinutes > required) required = t.minPauseMinutes;
  }
  return required;
}

/** "12" / "10,5" – hours text used inside messages (legacy uses de-DE locale formatting). */
function hoursWord(minutes: number): string {
  return (minutes / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 });
}

/**
 * Evaluates all shifts of `date` (other dates in `shifts` are ignored).
 * Legacy `UweBreakRules.evaluateDay`.
 */
export function evaluateDay(
  shifts: readonly (ShiftLike | null | undefined)[] | null | undefined,
  date: ISODate,
  policy: BreakPolicy = UWE_BREAK_POLICY,
): DayEvaluation {
  const segment = policy.minPauseSegmentMinutes;
  const max = policy.maxShiftMinutes;
  const dayShifts = (shifts || []).filter((s): s is ShiftLike => !!s && s.date === date);
  let totalGross = 0;
  let totalEntered = 0;
  let recognized = 0;
  const timeline: { start: number; end: number; overnight: boolean }[] = [];
  for (const s of dayShifts) {
    const duration = grossMinutes(s);
    const pause = Number(s.pause);
    if (!Number.isFinite(duration) || !Number.isInteger(pause) || pause < 0 || pause >= duration) {
      return { valid: false, reason: "Bitte Arbeitsbeginn, Ende und Pause korrigieren.", date };
    }
    if (duration > max) {
      return {
        valid: false,
        reason: "Ein Einsatz darf höchstens " + hoursWord(max) + " Stunden dauern. Bitte die Uhrzeiten prüfen.",
        date,
        tooLong: true,
      };
    }
    totalGross += duration;
    totalEntered += pause;
    // Pause pieces shorter than the minimum segment do not satisfy the
    // statutory requirement (they are still deducted as unpaid time).
    if (pause >= segment) recognized += pause;
    const start = parseClock(s.start);
    timeline.push({ start, end: start + duration, overnight: start + duration > 1440 });
  }
  if (totalGross > max) {
    return {
      valid: false,
      reason: "Die eingetragenen Einsätze ergeben zusammen mehr als " + hoursWord(max) + " Stunden an diesem Tag. Bitte korrigieren.",
      date,
      tooLong: true,
      gross: totalGross,
    };
  }
  timeline.sort((a, b) => a.start - b.start);
  let gap = 0;
  for (let i = 1; i < timeline.length; i++) {
    const previous = timeline[i - 1]!;
    const next = timeline[i]!;
    if (previous.end > next.start) {
      return { valid: false, reason: "Zwei Einsätze überschneiden sich am selben Tag. Bitte die Zeiten korrigieren.", date, overlap: true };
    }
    // A gap between separate same-day blocks is already unpaid: count it as
    // qualifying rest only when >= segment minutes, never deduct twice.
    if (!previous.overnight && !next.overnight && next.start - previous.end >= segment) gap += next.start - previous.end;
  }
  const required = necessaryPause(totalGross, policy);
  const qualifying = recognized + gap;
  return {
    valid: true,
    date,
    required,
    qualifying,
    entered: totalEntered,
    recognized,
    gaps: gap,
    missing: Math.max(0, required - qualifying),
    gross: totalGross,
    net: totalGross - totalEntered,
    shiftCount: dayShifts.length,
  };
}

/**
 * Pause to pre-fill for a new / edited shift, or null when the day cannot be
 * evaluated. Legacy `UweBreakRules.suggestedPause`.
 */
export function suggestedPause(
  candidate: ShiftLike | null | undefined,
  saved: readonly (ShiftLike | null | undefined)[] | null | undefined,
  policy: BreakPolicy = UWE_BREAK_POLICY,
): number | null {
  if (!candidate || !candidate.date || !Number.isFinite(grossMinutes(candidate))) return null;
  const id = typeof candidate.id === "string" && candidate.id ? candidate.id : null;
  const others = (saved || []).filter((x): x is ShiftLike => !!x && x.date === candidate.date && (!id || x.id !== id));
  const newShift: ShiftLike = { ...candidate, pause: 0 };
  const day = evaluateDay([...others, newShift], candidate.date, policy);
  if (!day.valid) return null;
  return day.missing === 0 ? 0 : Math.max(policy.minPauseSegmentMinutes, day.missing ?? 0);
}

/** German problem text for a day ("" when fine). Legacy `issueForDay`. */
export function issueForDay(day: DayEvaluation, policy: BreakPolicy = UWE_BREAK_POLICY): string {
  if (!day.valid) return day.reason ?? "";
  const missing = day.missing ?? 0;
  if (missing > 0) {
    const gaps = day.gaps ?? 0;
    const parts = gaps > 0
      ? " (" + gaps + " Minuten zwischen den Einsätzen zählen bereits als freie Zeit und werden nicht doppelt abgezogen)"
      : "";
    return "Für diesen Arbeitstag mit " + ((day.gross ?? 0) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 }) +
      " Stunden erfasster Einsatzzeit sind mindestens " + day.required +
      " Minuten Pause erforderlich. Es fehlen noch " + missing +
      " Minuten gültige Pause. Bitte die tatsächlich genommenen Pausen eintragen" +
      parts + ". Pausenabschnitte müssen mindestens " + policy.minPauseSegmentMinutes + " Minuten dauern.";
  }
  return "";
}

export interface DayIssue {
  date: ISODate;
  message: string;
}

/** All days of `month` with a break problem, sorted by date. Legacy `errorsForMonth`. */
export function errorsForMonth(
  shifts: readonly (ShiftLike | null | undefined)[] | null | undefined,
  month: ISOMonth,
  policy: BreakPolicy = UWE_BREAK_POLICY,
): DayIssue[] {
  const dates = [...new Set((shifts || [])
    .filter((x): x is ShiftLike => !!x && !!x.date && x.date.slice(0, 7) === month)
    .map((x) => x.date))].sort();
  const issues: DayIssue[] = [];
  for (const date of dates) {
    const problem = issueForDay(evaluateDay(shifts, date, policy), policy);
    if (problem) issues.push({ date, message: problem });
  }
  return issues;
}

/**
 * Validates a break policy configured by a tenant. Returns German problems
 * (empty array = OK). Does not enforce statutory minimums – that is a
 * product decision documented in the report.
 */
export function validateBreakPolicy(policy: BreakPolicy): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(policy.maxShiftMinutes) || policy.maxShiftMinutes <= 0 || policy.maxShiftMinutes > 1439)
    problems.push("Die maximale Einsatzdauer muss zwischen 1 und 1439 Minuten liegen.");
  if (!Number.isInteger(policy.minPauseSegmentMinutes) || policy.minPauseSegmentMinutes < 0)
    problems.push("Die Mindestdauer eines Pausenabschnitts ist ungültig.");
  for (const t of policy.thresholds) {
    if (!Number.isInteger(t.minGrossMinutes) || t.minGrossMinutes <= 0 || !Number.isInteger(t.minPauseMinutes) || t.minPauseMinutes < 0)
      problems.push("Eine Pausenschwelle ist ungültig.");
  }
  return problems;
}

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
 * Legal notes:
 *  - UWE applies the 30/45 minute thresholds from EXACTLY 6:00 / 9:00 hours
 *    of gross shift time ("ab genau 6 Stunden", rule "strict"). §4 ArbZG
 *    requires breaks for working time of MORE THAN 6 / 9 hours (rule
 *    "statutory", 361 / 541). Tenants choose one of both; nothing laxer than
 *    the statute is accepted (validateBreakPolicy, DB migration 0014).
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

/**
 * The two selectable break rules. Thresholds are inclusive (`gross >= minGrossMinutes`):
 *  - "statutory": wording of §4 ArbZG – MORE THAN 6 h → 30 min, MORE THAN 9 h → 45 min (361 / 541).
 *  - "strict":    UWE company rule – FROM EXACTLY 6 h / 9 h (360 / 540), stricter than the statute.
 */
export type BreakRuleKind = "statutory" | "strict";

const freezeThresholds = (list: [number, number][]): BreakPolicy["thresholds"] =>
  Object.freeze(list.map(([g, p]) => Object.freeze({ minGrossMinutes: g, minPauseMinutes: p }))) as unknown as BreakPolicy["thresholds"];

export const BREAK_RULE_THRESHOLDS: Readonly<Record<BreakRuleKind, BreakPolicy["thresholds"]>> = Object.freeze({
  statutory: freezeThresholds([[361, 30], [541, 45]]),
  strict: freezeThresholds([[360, 30], [540, 45]]),
});

/**
 * SINGLE PLACE for the rule new tenants get (decision of the client pending,
 * recommendation: statutory). Changing it also requires the same values in
 * the SQL default `private.default_tenant_settings()` (new migration);
 * tests/db/break-policy.test.ts fails while both differ.
 */
export const NEW_TENANT_BREAK_RULE: BreakRuleKind = "statutory";
/** Maximum shift length for new tenants (§3 ArbZG: 10 h). UWE keeps 12 h. */
export const NEW_TENANT_MAX_SHIFT_MINUTES = 600;

/** Statutory minimum (§4 ArbZG) that no tenant configuration may fall below. */
export const STATUTORY_MINIMUM = Object.freeze({
  thresholds: BREAK_RULE_THRESHOLDS.statutory,
  minPauseSegmentMinutes: 15,
});

export const UWE_BREAK_POLICY: BreakPolicy = Object.freeze({
  thresholds: BREAK_RULE_THRESHOLDS.strict,
  maxShiftMinutes: 720,
  minPauseSegmentMinutes: 15,
}) as BreakPolicy;

/** Break policy for a newly created tenant (mirrors `private.default_tenant_settings()`). */
export function defaultBreakPolicy(): BreakPolicy {
  return {
    thresholds: BREAK_RULE_THRESHOLDS[NEW_TENANT_BREAK_RULE].map((t) => ({ ...t })),
    maxShiftMinutes: NEW_TENANT_MAX_SHIFT_MINUTES,
    minPauseSegmentMinutes: 15,
  };
}

/** Thresholds of a selectable rule (fresh copies). */
export function thresholdsFor(kind: BreakRuleKind): BreakPolicy["thresholds"] {
  return BREAK_RULE_THRESHOLDS[kind].map((t) => ({ ...t }));
}

/** Which selectable rule the policy's thresholds correspond to ("custom" otherwise). */
export function breakRuleKind(policy: BreakPolicy): BreakRuleKind | "custom" {
  for (const kind of ["statutory", "strict"] as const) {
    const ref = BREAK_RULE_THRESHOLDS[kind];
    if (policy.thresholds.length === ref.length &&
      policy.thresholds.every((t, i) => t.minGrossMinutes === ref[i]!.minGrossMinutes && t.minPauseMinutes === ref[i]!.minPauseMinutes)) return kind;
  }
  return "custom";
}

function hoursPhrase(minutes: number): string {
  const h = minutes / 60;
  return h.toLocaleString("de-DE", { maximumFractionDigits: 2 }) + (h === 1 ? " Stunde" : " Stunden");
}

/**
 * German wording of an inclusive threshold: 360 → "ab 6 Stunden",
 * 361 → "mehr als 6 Stunden" (one minute above a quarter hour = "more than").
 */
export function thresholdLabel(minGrossMinutes: number): string {
  const below = minGrossMinutes - 1;
  if (below > 0 && below % 15 === 0) return "mehr als " + hoursPhrase(below);
  return "ab " + hoursPhrase(minGrossMinutes);
}

/** "ab 6 Stunden" / "bei mehr als 6 Stunden" – usable after a noun ("Pausenpflicht …"). */
export function thresholdPhrase(minGrossMinutes: number): string {
  const label = thresholdLabel(minGrossMinutes);
  return label.startsWith("ab ") ? label : "bei " + label;
}

/** One sentence describing the policy, e.g. "bei mehr als 6 Stunden Arbeitszeit mindestens 30 Minuten Pause, bei mehr als 9 Stunden mindestens 45 Minuten". */
export function breakRuleSummary(policy: BreakPolicy): string {
  const parts = policy.thresholds
    .filter((t) => t.minPauseMinutes > 0)
    .map((t, i) => thresholdPhrase(t.minGrossMinutes) + (i === 0 ? " Arbeitszeit" : "") + " mindestens " + t.minPauseMinutes + " Minuten" + (i === 0 ? " Pause" : ""));
  return parts.length ? parts.join(", ") : "keine Mindestpause";
}

/** The threshold that determines the required pause for `gross` (null when none applies). */
export function applicableThreshold(gross: number, policy: BreakPolicy): BreakPolicy["thresholds"][number] | null {
  let best: BreakPolicy["thresholds"][number] | null = null;
  for (const t of policy.thresholds) {
    if (gross >= t.minGrossMinutes && t.minPauseMinutes > (best?.minPauseMinutes ?? 0)) best = t;
  }
  return best;
}

/** First threshold that requires a pause (for "no pause needed until …" texts). */
export function firstPauseThreshold(policy: BreakPolicy): BreakPolicy["thresholds"][number] | null {
  return policy.thresholds.find((t) => t.minPauseMinutes > 0) ?? null;
}

/**
 * Neutral sentence naming the minimum pause of a (valid) evaluated day, worded
 * from the tenant's thresholds, e.g. "Für diesen Tag (8,00 Std. Einsatzzeit)
 * sind mindestens 30 Minuten Pause vorgeschrieben (Regel: mehr als 6 Stunden)."
 */
export function requiredPauseText(day: DayEvaluation, policy: BreakPolicy): string {
  const gross = day.gross ?? 0;
  const hours = (gross / 60).toFixed(2).replace(".", ",");
  const rule = applicableThreshold(gross, policy);
  if (rule) return `Für diesen Tag (${hours} Std. Einsatzzeit) sind mindestens ${rule.minPauseMinutes} Minuten Pause vorgeschrieben (Regel: ${thresholdLabel(rule.minGrossMinutes)}).`;
  const first = firstPauseThreshold(policy);
  return `Für diesen Tag (${hours} Std. Einsatzzeit) ist keine Mindestpause vorgeschrieben` +
    (first ? ` (Pausenpflicht erst ${thresholdLabel(first.minGrossMinutes)}).` : ".");
}

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
 * Problems when the policy is laxer than §4 ArbZG for any working day
 * (empty array = at least as strict as the statute). Stricter is allowed.
 */
export function statutoryBreakProblems(policy: BreakPolicy): string[] {
  const problems: string[] = [];
  for (const law of STATUTORY_MINIMUM.thresholds) {
    // necessaryPause(g) is the maximum over thresholds with g >= minGross, so
    // it covers every g >= law.minGross iff one threshold starts no later and
    // requires at least as much.
    const covered = policy.thresholds.some((t) => t.minGrossMinutes <= law.minGrossMinutes && t.minPauseMinutes >= law.minPauseMinutes);
    if (!covered) {
      problems.push("Die Pausenregel darf nicht hinter § 4 Arbeitszeitgesetz zurückbleiben: " +
        thresholdPhrase(law.minGrossMinutes) + " Arbeitszeit sind mindestens " + law.minPauseMinutes + " Minuten Pause vorgeschrieben.");
    }
  }
  if (Number.isInteger(policy.minPauseSegmentMinutes) && policy.minPauseSegmentMinutes < STATUTORY_MINIMUM.minPauseSegmentMinutes)
    problems.push("Pausenabschnitte unter " + STATUTORY_MINIMUM.minPauseSegmentMinutes + " Minuten zählen nach § 4 Arbeitszeitgesetz nicht als Pause.");
  return problems;
}

/**
 * Validates a break policy configured by a tenant. Returns German problems
 * (empty array = OK). Includes the statutory minimum (§4 ArbZG); the same
 * rule is enforced by the database (migration 0014).
 */
export function validateBreakPolicy(policy: BreakPolicy): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(policy.maxShiftMinutes) || policy.maxShiftMinutes <= 0 || policy.maxShiftMinutes > 1439)
    problems.push("Die maximale Einsatzdauer muss zwischen 1 und 1439 Minuten liegen.");
  if (!Number.isInteger(policy.minPauseSegmentMinutes) || policy.minPauseSegmentMinutes < 0)
    problems.push("Die Mindestdauer eines Pausenabschnitts ist ungültig.");
  let previous = 0;
  for (const t of policy.thresholds) {
    if (!Number.isInteger(t.minGrossMinutes) || t.minGrossMinutes <= 0 || !Number.isInteger(t.minPauseMinutes) || t.minPauseMinutes < 0)
      problems.push("Eine Pausenschwelle ist ungültig.");
    else if (t.minGrossMinutes <= previous) problems.push("Pausenschwellen müssen aufsteigend sortiert sein.");
    else previous = t.minGrossMinutes;
  }
  if (problems.length === 0) problems.push(...statutoryBreakProblems(policy));
  return problems;
}

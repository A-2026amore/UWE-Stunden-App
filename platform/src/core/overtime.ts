/**
 * Separate Überstundenzettel (tenant setting `overtimeSheet`, decision of the owner 18.11.2026).
 *
 * With a target from the employment contract (core/employment.ts) the monthly statement shows the
 * hours only up to the target; the Mehrstunden of the month (payable − target) are printed on a
 * separate overtime sheet. The latest hours of the month count as overtime: entries are taken from
 * the end of the month until the overtime is covered; the entry that crosses the target is shown on
 * both sheets with its share ("anteilig"). Both sheets together always contain every worked minute –
 * nothing is deleted or changed. Once the month is approved, the overtime counts as settled and is
 * not booked into the hours account (employmentAccount, `overtimeSettled`).
 */
import type { EmploymentContract, ISOMonth } from "./types";
import { contractForMonth } from "./employment";
import { asShift, netMinutes, type ShiftInput } from "./time";

/** One row of a sheet: the original entry plus the minutes shown on this sheet. */
export type SheetEntry<T> = T & { minutes: number; partial: boolean };

export interface OvertimeSplit<T> {
  targetMinutes: number;
  /** Payable minutes of the month (worked − work-time account), from summarizeMonth().billingMinutes. */
  payableMinutes: number;
  overtimeMinutes: number;
  /** Rows of the monthly statement (everything except the overtime). */
  regular: SheetEntry<T>[];
  /** Rows of the Überstundenzettel. */
  overtime: SheetEntry<T>[];
}

/** Target of the month from the contract versions; null = no contract / open contract. */
export function targetForMonth(versions: readonly EmploymentContract[], month: ISOMonth): number | null {
  return contractForMonth(versions, month)?.monthlyTargetMinutes ?? null;
}

function sortKey(e: ShiftInput): string {
  const s = asShift(e);
  return s.date + " " + s.start + " " + s.end;
}

/**
 * Splits the entries of a month at the target. Returns null when there is no target or no overtime
 * (then the statement stays as it is).
 */
export function splitOvertime<T extends ShiftInput>(args: {
  entries: readonly T[];
  targetMinutes: number | null;
  payableMinutes: number;
}): OvertimeSplit<T> | null {
  const { targetMinutes, payableMinutes } = args;
  if (targetMinutes === null || !Number.isSafeInteger(payableMinutes) || payableMinutes <= targetMinutes) return null;
  const sorted = [...args.entries].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const worked = sorted.reduce((sum, e) => sum + netMinutes(asShift(e)), 0);
  // Never more than was worked (payable ≤ worked; defensive).
  const overtimeMinutes = Math.min(payableMinutes - targetMinutes, worked);
  if (overtimeMinutes <= 0) return null;
  const regular: SheetEntry<T>[] = [];
  const overtime: SheetEntry<T>[] = [];
  let open = overtimeMinutes;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i]!;
    const m = netMinutes(asShift(e));
    if (open <= 0 || m <= 0) { regular.unshift({ ...e, minutes: m, partial: false }); continue; }
    if (m <= open) {
      overtime.unshift({ ...e, minutes: m, partial: false });
      open -= m;
    } else {
      overtime.unshift({ ...e, minutes: open, partial: true });
      regular.unshift({ ...e, minutes: m - open, partial: true });
      open = 0;
    }
  }
  return { targetMinutes, payableMinutes, overtimeMinutes, regular, overtime };
}

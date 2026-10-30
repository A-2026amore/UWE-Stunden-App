/**
 * Price model of the platform (decision of the client, 28.10.2026) as pure functions.
 * The database implements the same rules in SQL (db/migrations/0012_billing.sql);
 * the demo repository uses this module. Money in integer cents, time as instants
 * (ms / ISO strings) – month boundaries in Europe/Berlin.
 *
 *  - 5,00 € net per billable employee and month, no base fee, no minimum, no tiers.
 *  - Billable in month M: role "employee" and active at any time in M;
 *    leadership (manager/owner) only when active in M with own non-deleted time entries in M.
 *  - Locked/deactivated persons are billed for the month of the change, not afterwards.
 *  - Invited persons who were never active are never billable.
 */
import type {
  BillableReason, BillingCondition, EmployeeStatus, ISODate, ISOMonth, License, PlatformRevenue, PlatformRevenueRow, TenantBlock, TenantRole,
  TenantStatus,
} from "./types";

/** Platform default: 5,00 € net per billable employee and month. */
export const DEFAULT_EMPLOYEE_PRICE_CENTS = 500;
export const BILLING_TIME_ZONE = "Europe/Berlin";
/** Shown next to every net amount. */
export const VAT_NOTE = "zzgl. gesetzlicher USt.";

export const BILLING_CONDITION_LABEL: Record<BillingCondition, string> = {
  standard: "Standardpreis",
  special: "Sonderpreis",
  free: "Kostenloses Konto",
  pilot_free: "Kostenlos – Pilot",
  tenant_suspended: "Firma gesperrt – nicht berechnet",
  tenant_deactivated: "Firma deaktiviert – nicht berechnet",
};

export const BILLING_STATUS_LABEL: Record<string, string> = {
  open: "Offen",
  invoiced: "In Rechnung gestellt",
  paid: "Bezahlt",
  waived: "Erlassen",
};

export const BILLABLE_REASON_LABEL: Record<BillableReason, string> = {
  employee: "Mitarbeiter/in, im Monat aktiv",
  leader_with_time: "Leitung mit eigenen Arbeitszeiten im Monat",
};

/** One validity period of (status, role) of a person; `to` null = until now. */
export interface StatusPeriod {
  status: EmployeeStatus;
  role: TenantRole;
  /** ISO instant (inclusive). */
  from: string;
  /** ISO instant (exclusive) or null. */
  to: string | null;
}

// ------------------------------------------------------------------ time zone

let berlinFormat: Intl.DateTimeFormat | null = null;

/** Offset of Europe/Berlin to UTC at the given instant, in minutes (+60 / +120). */
export function berlinOffsetMinutes(utcMs: number): number {
  berlinFormat ??= new Intl.DateTimeFormat("en-US", {
    timeZone: BILLING_TIME_ZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of berlinFormat.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** UTC instant (ms) of 00:00 Berlin time on the given day. */
export function berlinMidnight(date: ISODate): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - berlinOffsetMinutes(guess) * 60000;
  t = guess - berlinOffsetMinutes(t) * 60000;
  return t;
}

export function addMonths(month: ISOMonth, delta: number): ISOMonth {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface MonthBounds {
  /** 1st of the month 00:00 Berlin (UTC ms, inclusive). */
  start: number;
  /** 1st of the next month 00:00 Berlin (UTC ms, exclusive). */
  end: number;
  firstDay: ISODate;
  lastDay: ISODate;
}

export function monthBounds(month: ISOMonth): MonthBounds {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Bitte einen gültigen Monat (JJJJ-MM) angeben.");
  const next = addMonths(month, 1);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: berlinMidnight(`${month}-01`), end: berlinMidnight(`${next}-01`), firstDay: `${month}-01`, lastDay: `${month}-${String(last).padStart(2, "0")}` };
}

/** Calendar month (Berlin) of an instant. */
export function berlinMonthOf(instant: Date | number | string): ISOMonth {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
  const local = new Date(ms + berlinOffsetMinutes(ms) * 60000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ rules

function overlaps(p: StatusPeriod, b: MonthBounds): boolean {
  const from = Date.parse(p.from);
  const to = p.to === null ? Infinity : Date.parse(p.to);
  return from < b.end && to > b.start;
}

/**
 * Why a person is billable in the month – or null.
 * @param ownEntryDates work dates (YYYY-MM-DD) of the person's own non-deleted time entries
 */
export function billableReason(periods: StatusPeriod[], ownEntryDates: readonly string[], month: ISOMonth): BillableReason | null {
  const b = monthBounds(month);
  const active = periods.filter((p) => p.status === "active" && overlaps(p, b));
  if (active.length === 0) return null;
  if (active.some((p) => p.role === "employee")) return "employee";
  return ownEntryDates.some((d) => d >= b.firstDay && d <= b.lastDay) ? "leader_with_time" : null;
}

/** One validity period of the status of a tenant (tenant_status_history, migration 0018). */
export interface TenantStatusPeriod {
  status: TenantStatus;
  from: string;
  to: string | null;
  reason?: string | null;
}

/**
 * Block of a tenant covering the WHOLE month (decision 28.10.2026): every status period
 * that overlaps the month is "suspended" or "deactivated". The month of the block itself
 * is still billed (block on 10.11. → November billed, December not); a reactivation in a
 * month makes that month billable again. Same rule as private.tenant_block in the database.
 */
export function tenantBlockFor(periods: readonly TenantStatusPeriod[], month: ISOMonth): (TenantBlock & { reason: string | null }) | null {
  const b = monthBounds(month);
  const ov = periods.filter((p) => Date.parse(p.from) < b.end && (p.to === null || Date.parse(p.to) > b.start))
    .sort((x, y) => x.from.localeCompare(y.from));
  if (!ov.length || ov.some((p) => p.status !== "suspended" && p.status !== "deactivated")) return null;
  const last = ov[ov.length - 1]!;
  return { status: last.status as TenantBlock["status"], since: last.from, reason: last.reason ?? null };
}

export type LicenseCondition = Pick<License, "plan" | "status" | "employeePriceCents" | "freeOfCharge" | "conditionValidFrom" | "conditionValidUntil">;

/**
 * Price of a tenant for a month: pilot_free is always free; a special condition
 * (free of charge or own price) applies when its validity overlaps the month;
 * otherwise (or without active licence) the platform default price.
 */
export function billingConditionFor(license: LicenseCondition | null, defaultPriceCents: number, month: ISOMonth, block?: TenantBlock | null): { condition: BillingCondition; unitPriceCents: number } {
  const b = monthBounds(month);
  if (block) return { condition: block.status === "suspended" ? "tenant_suspended" : "tenant_deactivated", unitPriceCents: 0 };
  if (!license || license.status !== "active") return { condition: "standard", unitPriceCents: defaultPriceCents };
  if (license.plan === "pilot_free") return { condition: "pilot_free", unitPriceCents: 0 };
  const applies = (license.conditionValidFrom === null || license.conditionValidFrom <= b.lastDay)
    && (license.conditionValidUntil === null || license.conditionValidUntil >= b.firstDay);
  if (applies && license.freeOfCharge) return { condition: "free", unitPriceCents: 0 };
  if (applies && license.employeePriceCents !== null) return { condition: "special", unitPriceCents: license.employeePriceCents };
  return { condition: "standard", unitPriceCents: defaultPriceCents };
}

/** Net amount in cents: count × unit price (both non-negative integers). */
export function billingAmount(billableCount: number, unitPriceCents: number): number {
  if (!Number.isInteger(billableCount) || billableCount < 0) throw new Error("Anzahl muss eine ganze Zahl ≥ 0 sein.");
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) throw new Error("Preis muss in ganzen Cent ≥ 0 angegeben werden.");
  return billableCount * unitPriceCents;
}

/** 123456 → "1.234,56 €" */
export function formatEuro(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "−" : ""}${euros},${String(abs % 100).padStart(2, "0")} €`;
}

/** "5,00" / "5" / "4,5" → 500 / 500 / 450 cents; throws a German message. */
export function parseEuro(raw: string): number {
  const s = raw.trim().replace(/\s*€$/, "");
  const m = /^(\d{1,6})(?:[,.](\d{1,2}))?$/.exec(s);
  if (!m) throw new Error("Bitte einen Betrag in Euro angeben, z. B. 5,00.");
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** Months from `current` backwards, not before `first`, at most `limit`. */
export function monthsBack(current: ISOMonth, first: ISOMonth, limit: number): ISOMonth[] {
  const out: ISOMonth[] = [];
  for (let m = current; m >= first && out.length < limit; m = addMonths(m, -1)) out.push(m);
  return out;
}

/**
 * Totals of the platform revenue overview: demo tenants are not revenue; waived
 * months are reported separately.
 */
export function revenueTotals(rows: ReadonlyArray<Pick<PlatformRevenueRow, "isDemo" | "status" | "billableCount" | "amountCents">>): PlatformRevenue["totals"] {
  const t = { billableCount: 0, amountCents: 0, waivedCents: 0, demoAmountCents: 0 };
  for (const r of rows) {
    if (r.isDemo) { t.demoAmountCents += r.amountCents; continue; }
    t.billableCount += r.billableCount;
    if (r.status === "waived") t.waivedCents += r.amountCents;
    else t.amountCents += r.amountCents;
  }
  return t;
}

/**
 * Price model of the platform (decision of the client, 28.10.2026) as pure functions.
 * The database implements the same rules in SQL (db/migrations/0012_billing.sql);
 * the demo repository uses this module. Money in integer cents, time as instants
 * (ms / ISO strings) – month boundaries in Europe/Berlin.
 *
 *  - 5,00 € gross (incl. VAT) per billable employee and month in the 12-month subscription,
 *    6,50 € in the monthly plan (decision 30.10.2026, subscription.ts / migration 0023),
 *    no base fee, no minimum, no tiers. Free trial only as introductory offer (trial window).
 *  - Promo codes (migration 0022): a discount of 1–100 % on the price that applies
 *    otherwise, for every month the redemption period touches, until the super admin ends it.
 *  - Billable in month M: role "employee" and active at any time in M;
 *    leadership (manager/owner) only when active in M with own non-deleted time entries in M.
 *  - Locked/deactivated persons are billed for the month of the change, not afterwards.
 *  - Invited persons who were never active are never billable.
 */
import type {
  BillableReason, BillingCondition, EmployeeStatus, ISODate, ISOMonth, License, PlatformRevenue, PlatformRevenueRow, TenantBlock, TenantRole,
  SubscriptionInterval, TenantStatus,
} from "./types";

/** Platform default: 5,00 € gross (incl. VAT) per billable employee and month. */
export const DEFAULT_EMPLOYEE_PRICE_CENTS = 500;
export const BILLING_TIME_ZONE = "Europe/Berlin";
/** Shown next to every amount: prices are gross since 30.10.2026. */
export const VAT_NOTE = "inkl. gesetzlicher USt.";

export const BILLING_CONDITION_LABEL: Record<BillingCondition, string> = {
  standard: "Standardpreis",
  special: "Sonderpreis",
  free: "Kostenloses Konto",
  pilot_free: "Kostenlos – Pilot",
  tenant_suspended: "Firma gesperrt – nicht berechnet",
  tenant_deactivated: "Firma deaktiviert – nicht berechnet",
  promo: "Aktionscode",
  monthly: "Monatstarif",
  trial: "Testphase – kostenlos",
  ended: "Kein laufender Vertrag – nicht berechnet",
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

/** One promo redemption of a tenant (migration 0022); `to` null = still running. */
export interface PromoPeriod {
  code: string;
  discountPercent: number;
  /** ISO instant of the redemption (inclusive). */
  from: string;
  /** ISO instant of the end or null. */
  to: string | null;
}

/**
 * Promo discount for a month: the redemption whose period touches the month (several:
 * the highest discount) – same rule as private.promo_for. The month in which the super
 * admin ends a discount is still discounted; the following month is regular.
 */
export function promoFor(periods: readonly PromoPeriod[], month: ISOMonth): PromoPeriod | null {
  const b = monthBounds(month);
  const ov = periods.filter((p) => Date.parse(p.from) < b.end && (p.to === null || Date.parse(p.to) > b.start))
    .sort((x, y) => y.discountPercent - x.discountPercent || y.from.localeCompare(x.from));
  return ov[0] ?? null;
}

/** Price after a discount in percent, rounded half up to whole cents (PostgreSQL round). */
export function discountedPrice(priceCents: number, discountPercent: number): number {
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new Error("Der Nachlass muss zwischen 0 und 100 % liegen.");
  return Math.floor((priceCents * (100 - discountPercent) + 50) / 100);
}

export type LicenseCondition = Pick<License, "plan" | "status" | "employeePriceCents" | "freeOfCharge" | "conditionValidFrom" | "conditionValidUntil">;

/** Subscription data of a tenant for a month (migration 0023). */
export interface SubscriptionForMonth {
  trialEndsOn: ISODate | null;
  /** Interval of the term covering the month, null = no term (ended / not started). */
  interval: SubscriptionInterval | null;
  monthlyPriceCents: number;
}

/**
 * Price of a tenant for a month: blocked tenants and pilot_free are free; a "free" special
 * condition overlapping the month is free. With subscription data (0023): a trial month is free,
 * a month without term is not billed ("ended"); otherwise the special price, else the price of
 * the interval (annual = platform default "standard", monthly = monthly price). Without
 * subscription data the platform default applies (behaviour before 0023). A promo discount
 * (0022) reduces the resulting price.
 */
export function billingConditionFor(license: LicenseCondition | null, defaultPriceCents: number, month: ISOMonth, block?: TenantBlock | null, promo?: Pick<PromoPeriod, "discountPercent"> | null, subscription?: SubscriptionForMonth | null): { condition: BillingCondition; unitPriceCents: number } {
  const b = monthBounds(month);
  if (block) return { condition: block.status === "suspended" ? "tenant_suspended" : "tenant_deactivated", unitPriceCents: 0 };
  const active = license && license.status === "active" ? license : null;
  if (active?.plan === "pilot_free") return { condition: "pilot_free", unitPriceCents: 0 };
  const applies = !!active && (active.conditionValidFrom === null || active.conditionValidFrom <= b.lastDay)
    && (active.conditionValidUntil === null || active.conditionValidUntil >= b.firstDay);
  if (applies && active.freeOfCharge) return { condition: "free", unitPriceCents: 0 };
  if (subscription) {
    if (subscription.trialEndsOn && b.firstDay <= subscription.trialEndsOn) return { condition: "trial", unitPriceCents: 0 };
    if (!subscription.interval) return { condition: "ended", unitPriceCents: 0 };
  }
  const base: { condition: BillingCondition; unitPriceCents: number } = applies && active.employeePriceCents !== null
    ? { condition: "special", unitPriceCents: active.employeePriceCents }
    : subscription?.interval === "monthly"
      ? { condition: "monthly", unitPriceCents: subscription.monthlyPriceCents }
      : { condition: "standard", unitPriceCents: defaultPriceCents };
  if (promo && base.unitPriceCents > 0) return { condition: "promo", unitPriceCents: discountedPrice(base.unitPriceCents, promo.discountPercent) };
  return base;
}

/** Amount in cents (gross since 30.10.2026): count × unit price (both non-negative integers). */
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

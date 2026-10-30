/**
 * Shared domain types of the multi-tenant time-tracking platform.
 *
 * This file is the contract between domain logic (src/core), data access
 * (src/data), the UI apps (src/apps) and the database schema (supabase/).
 * Times are local wall-clock "HH:MM", dates ISO "YYYY-MM-DD", months
 * "YYYY-MM". All durations are integer MINUTES – never floating hours.
 */

export type ISODate = string;
export type ISOMonth = string;
export type ClockTime = string;
export type UUID = string;

// ---------------------------------------------------------------- tenants

export interface Branding {
  /** Public URL or data: URL of the company logo. Null → neutral product logo. */
  logoUrl: string | null;
  /** Small mark used as watermark / app icon (e.g. the UWE wing). */
  markUrl: string | null;
  /** Hex colours, validated as #RRGGBB. */
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  slogan: string | null;
}

export interface CompanyContact {
  legalName: string;
  street: string;
  postalCode: string;
  city: string;
  phone: string | null;
  /** Digits only incl. country code, e.g. "4924140011111" (for wa.me links). */
  whatsapp: string | null;
  email: string | null;
  website: string | null;
  contactPerson: string | null;
}

export interface BreakThreshold {
  /** Pause requirement applies when the day's gross working time is >= this. */
  minGrossMinutes: number;
  minPauseMinutes: number;
}

export interface BreakPolicy {
  /** UWE: [{360,30},{540,45}] – thresholds are inclusive ("ab genau 6 Stunden"). */
  thresholds: BreakThreshold[];
  /** UWE: 720 – longer shifts / days must not be saved. */
  maxShiftMinutes: number;
  /** Pause pieces shorter than this do not count as statutory break (§4 ArbZG: 15). */
  minPauseSegmentMinutes: number;
}

export type WorkAccountModel = "school-year" | "calendar-year";

export interface WorkAccountPolicy {
  enabled: boolean;
  model: WorkAccountModel;
  /** Opening balance per cycle in minutes. UWE: -6000 (= –100 h). */
  openingMinutes: number;
  /** German federal state code for school holidays, e.g. "NW". */
  federalState: string | null;
  /** First month in which allocations are possible (UWE: "2026-09"). */
  startMonth: ISOMonth;
  /** Monthly allocations require manager approval before they are final. */
  approvalRequired: boolean;
}

export interface TenantSettings {
  breakPolicy: BreakPolicy;
  workAccount: WorkAccountPolicy;
}

export type TenantStatus = "active" | "suspended" | "pending" | "deactivated";

export interface Tenant {
  id: UUID;
  slug: string;
  name: string;
  status: TenantStatus;
  branding: Branding;
  contact: CompanyContact;
  settings: TenantSettings;
  /** Demo / anonymised test tenant – never contains real personal data. */
  isDemo: boolean;
  /** Owner setting: managers and owners must use two-factor authentication (missing = false). */
  requireTwoFactorForManagers?: boolean;
  /**
   * Owner setting (0016): months after an employee left before the record may be anonymised.
   * Missing/null = not configured (anonymisation refused). Legal period to be checked (docs/datenschutz.md).
   */
  retentionMonthsAfterExit?: number | null;
}

// ---------------------------------------------------------------- licences

export type LicensePlan = "pilot_free" | "standard" | "business" | "enterprise";
export type LicenseStatus = "active" | "suspended" | "expired";

export interface License {
  id: UUID;
  tenantId: UUID;
  plan: LicensePlan;
  status: LicenseStatus;
  /**
   * Legacy flat price of the licence (always 0). Not used for billing since the
   * price model of 28.10.2026 – see employeePriceCents / BillingSettings.
   */
  priceCents: number;
  /** "none" = no payment data, no invoices, no automatic conversion. */
  billing: "none" | "manual" | "provider";
  validFrom: ISODate;
  /** Null = unlimited. */
  validUntil: ISODate | null;
  maxEmployees: number | null;
  features: string[];
  note: string | null;
  /**
   * Special condition (price model 2026-10-28): own gross price per billable
   * employee and month in cents; null = platform default price.
   */
  employeePriceCents: number | null;
  /** Free customer account (e.g. pilot, test). Always true for pilot_free. */
  freeOfCharge: boolean;
  conditionNote: string | null;
  /** Validity of the special condition (null = open). It applies to every month it overlaps. */
  conditionValidFrom: ISODate | null;
  conditionValidUntil: ISODate | null;
}

// ---------------------------------------------------------------- billing (price model 2026-10-28)

/** Which price applies to a tenant in a month. */
export type BillingCondition = "standard" | "special" | "free" | "pilot_free"
  /** Customer blocked (suspended / deactivated) for the whole month: 0 € (decision 28.10.2026, migration 0018). */
  | "tenant_suspended" | "tenant_deactivated"
  /** Promo code discount (migration 0022). */
  | "promo"
  /** Monthly plan price (migration 0023); "standard" is the 12-month subscription price. */
  | "monthly"
  /** Free introductory trial (migration 0023): the month contains at least one trial day. */
  | "trial"
  /** No subscription term covers the month (cancelled / ended): 0 € (migration 0023). */
  | "ended";

/** Block of a customer covering a whole month (status and start of the block). */
export interface TenantBlock {
  status: "suspended" | "deactivated";
  since: string;
}
/** Manual billing status of a tenant and month (platform operator). */
export type BillingStatus = "open" | "invoiced" | "paid" | "waived";
/** Why a person is billable: role employee, or leadership with own time entries in the month. */
export type BillableReason = "employee" | "leader_with_time";

export interface BillingSettings {
  /** Gross price (incl. VAT) per billable employee and month in cents for the 12-month subscription (default 500 = 5,00 €). */
  defaultPriceCents: number;
  /** Gross price per billable employee and month for the monthly plan (default 650 = 6,50 €, migration 0023). */
  monthlyPriceCents: number;
  /** Introductory offer (migration 0023): tenants created on a day in [from, until] get a free trial. Null = no offer. */
  trialWindowFrom: ISODate | null;
  trialWindowUntil: ISODate | null;
  /** Length of the free trial in months (default 3). */
  trialMonths: number;
  /** A cancellation must be received at least this many days before the term end (default 0 = up to the last day). */
  cancelNoticeDays: number;
  /** Promo code sent automatically in the invitation mail of every newly created tenant (null = none). */
  welcomePromoCodeId: UUID | null;
  welcomePromoCode: string | null;
  currency: "EUR";
}

/** Changes of the billing settings by the super admin (each field optional, reason required). */
export interface BillingSettingsPatch {
  defaultPriceCents?: number;
  monthlyPriceCents?: number;
  trialWindowFrom?: ISODate | null;
  trialWindowUntil?: ISODate | null;
  trialMonths?: number;
  cancelNoticeDays?: number;
  welcomePromoCodeId?: UUID | null;
  reason: string;
}

// ---------------------------------------------------------------- subscription (migration 0023)

/** "annual" = 12-month subscription (5,00 €), renews by 6 months unless cancelled; "monthly" = monthly plan (6,50 €). */
export type SubscriptionInterval = "monthly" | "annual";

/** One subscription term of a tenant. Terms start on the first and end on the last day of a month. */
export interface SubscriptionTerm {
  id: UUID;
  interval: SubscriptionInterval;
  /** First day of the first billed month. */
  startsOn: ISODate;
  /** Annual and not ended: last day of the current term as of today (12 months, then +6 per renewal). Else null. */
  currentTermEndsOn: ISODate | null;
  /** Last day once cancelled or replaced (startsOn − 1 day = never active), else null (runs on). */
  endsOn: ISODate | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** Annual cancelled with "continue monthly afterwards". */
  thenMonthly: boolean;
}

/** Subscription state of a tenant (leadership of the tenant and platform staff). */
export interface TenantSubscription {
  tenantId: UUID;
  /** Last day of the free trial; null = no trial (created outside the introductory window). */
  trialEndsOn: ISODate | null;
  inTrial: boolean;
  /** First month that is billed (the month after the month in which the trial ends; without trial the month of creation). */
  firstPaidMonth: ISOMonth;
  /** Term that covers today, else the next term that starts (e.g. during the trial). */
  current: SubscriptionTerm | null;
  /** Term after `current` (e.g. monthly after a cancelled annual, or annual after a switch). */
  next: SubscriptionTerm | null;
  /** Last day of the contract when it is cancelled without follow-up, else null. */
  contractEndsOn: ISODate | null;
  /** No term covers today or later: the contract has ended. */
  ended: boolean;
  annualPriceCents: number;
  monthlyPriceCents: number;
  termMonths: number;
  renewalMonths: number;
  cancelNoticeDays: number;
}

/** One billable person (only visible to owner/manager of the tenant). */
export interface BillingLine {
  employeeId: UUID;
  displayName: string;
  personnelNumber: string;
  role: TenantRole;
  status: EmployeeStatus;
  reason: BillableReason;
}

/** Numbers of one tenant and month (no names). */
export interface BillingMonthSummary {
  month: ISOMonth;
  status: BillingStatus;
  /** True when frozen by the platform operator (status other than "open"). */
  final: boolean;
  condition: BillingCondition;
  unitPriceCents: number;
  billableCount: number;
  /** Gross amount in cents (billableCount × unitPriceCents). */
  amountCents: number;
}

/** Billing of a tenant for one month incl. the billable persons (owner/manager). */
export interface TenantBillingMonth extends BillingMonthSummary {
  tenantId: UUID;
  isCurrentMonth: boolean;
  plan: LicensePlan | null;
  currency: "EUR";
  closedAt: string | null;
  lines: BillingLine[];
  /** Set when the customer was blocked for the whole month (condition tenant_*), else null. */
  tenantBlock?: TenantBlock | null;
  /** Set when a promo discount applies (condition "promo"), else null. */
  promo?: { code: string; discountPercent: number } | null;
  /** Subscription term covering the month (migration 0023), else null. */
  interval?: SubscriptionInterval | null;
  /** Last day of the free trial of the tenant, null = no trial. */
  trialEndsOn?: ISODate | null;
}

/** One row of the platform revenue overview – numbers only, never names. */
export interface PlatformRevenueRow extends BillingMonthSummary {
  tenantId: UUID;
  tenantName: string;
  slug: string;
  isDemo: boolean;
  tenantStatus: Tenant["status"];
  plan: LicensePlan | null;
  note: string | null;
  closedAt: string | null;
  /** Condition tenant_*: start of the block and the reason given by the super-admin. */
  blockSince?: string | null;
  blockReason?: string | null;
  /** Condition promo: the code and its discount. */
  promoCode?: string | null;
  promoDiscountPercent?: number | null;
  /** Subscription term covering the month and the trial end (migration 0023). */
  interval?: SubscriptionInterval | null;
  trialEndsOn?: ISODate | null;
}

// ---------------------------------------------------------------- promo codes (migration 0022)

/** One redemption of a promo code by a tenant. endedAt null = the discount is running. */
export interface PromoRedemption {
  id: UUID;
  promoCodeId: UUID;
  code: string;
  tenantId: UUID;
  /** Only in the platform view. */
  tenantName: string | null;
  discountPercent: number;
  redeemedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

/** Promo code created by the super admin (discount 1–100 %). */
export interface PromoCode {
  id: UUID;
  code: string;
  discountPercent: number;
  note: string | null;
  /** null = unlimited. */
  maxRedemptions: number | null;
  /** Last day for redeeming; null = no end. */
  redeemableUntil: ISODate | null;
  createdAt: string;
  endedAt: string | null;
  endReason: string | null;
  redemptionCount: number;
  activeCount: number;
  redemptions: PromoRedemption[];
}

export interface NewPromoCode {
  code: string;
  discountPercent: number;
  note?: string | null;
  maxRedemptions?: number | null;
  redeemableUntil?: ISODate | null;
}

export interface PlatformRevenue {
  month: ISOMonth;
  defaultPriceCents: number;
  rows: PlatformRevenueRow[];
  totals: {
    /** Billable employees of all non-demo tenants. */
    billableCount: number;
    /** Net amount of all non-demo tenants, without waived months. */
    amountCents: number;
    /** Net amount of waived months (non-demo). */
    waivedCents: number;
    /** Net amount of demo tenants (not revenue). */
    demoAmountCents: number;
  };
  /** Payment provider of the server: only "none" exists (nothing is charged automatically). */
  paymentProvider: "none";
}

// ---------------------------------------------------------------- people

export type TenantRole = "employee" | "manager" | "owner";
export type PlatformRole = "super_admin" | "support";
/** locked = temporarily blocked (no sign-in, data kept, reversible); deactivated = left the company. */
export type EmployeeStatus = "invited" | "active" | "locked" | "deactivated";

export interface Employee {
  id: UUID;
  tenantId: UUID;
  personnelNumber: string;
  displayName: string;
  email: string | null;
  role: TenantRole;
  status: EmployeeStatus;
  createdAt: string;
  /** Set when the owner anonymised the record of a former employee (0016); missing = not anonymised. */
  anonymizedAt?: string | null;
}

// ---------------------------------------------------------------- time

export interface TimeEntry {
  /** Client-generated UUID → idempotent offline sync, no duplicates. */
  id: string;
  tenantId: UUID;
  employeeId: UUID;
  date: ISODate;
  start: ClockTime;
  end: ClockTime;
  pauseMinutes: number;
  note: string;
  /** Optimistic concurrency counter, incremented on every server update. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Soft delete – original records are never physically removed by users. */
  deletedAt: string | null;
  source: "app" | "migration" | "correction";
}

/** Minimal shape the pure calculations need (legacy records satisfy it). */
export interface ShiftLike {
  id?: string;
  date: ISODate;
  start: ClockTime;
  end: ClockTime;
  pause: number;
}

export interface DayEvaluation {
  valid: boolean;
  date: ISODate;
  reason?: string;
  tooLong?: boolean;
  overlap?: boolean;
  required?: number;
  qualifying?: number;
  entered?: number;
  recognized?: number;
  gaps?: number;
  missing?: number;
  gross?: number;
  net?: number;
  shiftCount?: number;
}

// ---------------------------------------------------------------- work account

export interface WorkAccountCycle {
  /** e.g. "2026" for school year 2026/27. */
  id: string;
  label: string;
  start: ISODate;
  /** Last day on which hours count for this cycle. */
  end: ISODate;
  /** School-year model only. */
  summerStart?: ISODate;
  summerEnd?: ISODate;
  source: string;
}

export interface MonthAllocation {
  employeeId: UUID;
  month: ISOMonth;
  minutes: number;
  status: "proposed" | "approved" | "rejected";
}

export interface MonthSummary {
  month: ISOMonth;
  /** Actually worked minutes (net of pauses) – never changed by allocations. */
  workedMinutes: number;
  /** Minutes eligible for the work account (e.g. inside school time). */
  eligibleMinutes: number;
  allocatedMinutes: number;
  /** workedMinutes − allocatedMinutes (≥ 0): hours intended for payroll. */
  billingMinutes: number;
  cycle: WorkAccountCycle | null;
  cycleStatus: "active" | "vacation" | "before" | "unknown" | "disabled";
  /** Balance of the cycle up to and including this month. */
  balanceMinutes: number | null;
}

// ---------------------------------------------------------------- statements

/** "reopened": an approved month re-opened by the leadership with a reason (decision 28.10.2026, migration 0017). */
export type StatementStatus = "draft" | "submitted" | "approved" | "returned" | "reopened";

export interface MonthlyStatement {
  id: UUID;
  tenantId: UUID;
  employeeId: UUID;
  month: ISOMonth;
  status: StatementStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: UUID | null;
  /** Mandatory when status = "returned". */
  reviewNote: string | null;
  workedMinutes: number;
  allocatedMinutes: number;
  billingMinutes: number;
  /** Status "reopened": when the month was re-opened (the reason is in reviewNote). */
  reopenedAt?: string | null;
  /**
   * Legacy cases only: corrections of an approved month made after the approval
   * before migration 0017. Since the decision of 28.10.2026 an approved month can
   * only be changed after a documented re-opening, so new cases cannot arise.
   */
  correctedAfterApproval?: { count: number; lastAt: string } | null;
}

/** One entry of the history of a monthly statement (monthly_statement_events). */
export interface StatementEvent {
  action: "submit" | "approve" | "return" | "reopen";
  at: string;
  actorName: string | null;
  reason: string | null;
  workedMinutes: number;
  allocatedMinutes: number;
  billingMinutes: number;
}

// ---------------------------------------------------------------- correction requests

/** Values of a time entry as used in correction requests and revisions. */
export interface EntryValues {
  date: ISODate;
  start: ClockTime;
  end: ClockTime;
  pauseMinutes: number;
  note: string;
}

export type CorrectionKind = "change" | "delete" | "add";
export type CorrectionStatus = "open" | "accepted" | "rejected" | "withdrawn";

/** An employee asks the leadership to change, delete or add one of their own entries. */
export interface CorrectionRequest {
  id: UUID;
  tenantId: UUID;
  employeeId: UUID;
  kind: CorrectionKind;
  /** Entry concerned (change/delete); null for "add". */
  entryId: string | null;
  /** Entry version at request time (accepting fails when the entry changed since). */
  entryVersion: number | null;
  /** Values at request time (change/delete). */
  before: EntryValues | null;
  /** Requested values (change/add). */
  proposed: EntryValues | null;
  /** Mandatory reason of the employee. */
  reason: string;
  status: CorrectionStatus;
  createdAt: string;
  decidedAt: string | null;
  /** Display name of the deciding person (null when not visible to the caller). */
  decidedByName: string | null;
  /** Answer of the leadership (mandatory for rejections). */
  decisionNote: string | null;
  /** Entry changed/created by the acceptance. */
  appliedEntryId: string | null;
}

/** One version of a time entry from the change history (time_entry_revisions). */
export interface TimeEntryRevision {
  entryId: string;
  version: number;
  operation: "insert" | "update" | "delete" | "restore";
  /** Made through the leadership's correction function. */
  isCorrection: boolean;
  changedAt: string;
  /** Display name of the person (null when not visible to the caller). */
  changedByName: string | null;
  reason: string | null;
  values: EntryValues;
  deleted: boolean;
  source: TimeEntry["source"];
}

// ---------------------------------------------------------------- audit

export interface AuditEvent {
  id: UUID;
  tenantId: UUID | null;
  actorId: UUID | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
}

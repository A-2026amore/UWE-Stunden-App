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

export type TenantStatus = "active" | "suspended" | "pending";

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
}

// ---------------------------------------------------------------- licences

export type LicensePlan = "pilot_free" | "standard" | "business" | "enterprise";
export type LicenseStatus = "active" | "suspended" | "expired";

export interface License {
  id: UUID;
  tenantId: UUID;
  plan: LicensePlan;
  status: LicenseStatus;
  /** Always 0 for pilot_free. Final prices are a business decision (not set). */
  priceCents: number;
  /** "none" = no payment data, no invoices, no automatic conversion. */
  billing: "none" | "manual" | "provider";
  validFrom: ISODate;
  /** Null = unlimited. */
  validUntil: ISODate | null;
  maxEmployees: number | null;
  features: string[];
  note: string | null;
}

// ---------------------------------------------------------------- people

export type TenantRole = "employee" | "manager" | "owner";
export type PlatformRole = "super_admin" | "support";
export type EmployeeStatus = "invited" | "active" | "deactivated";

export interface Employee {
  id: UUID;
  tenantId: UUID;
  personnelNumber: string;
  displayName: string;
  email: string | null;
  role: TenantRole;
  status: EmployeeStatus;
  createdAt: string;
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

export type StatementStatus = "draft" | "submitted" | "approved" | "returned";

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

/**
 * Data-access contract used by all UI apps.
 *
 * Two implementations exist / are planned:
 *  - DemoRepository (src/data/demo.ts): runs fully in the browser with
 *    anonymised seed data for two separate demo companies. Used for staging
 *    previews and E2E tests. NEVER holds real personal data.
 *  - ApiRepository (src/data/api.ts): talks to our own Node API (server/),
 *    which runs every request under PostgreSQL Row Level Security
 *    (db/migrations). Tenant isolation is enforced in the database – the
 *    client-side checks here are only for usability, never the security
 *    boundary.
 *
 * Every method acts on behalf of the signed-in Session. Implementations must
 * reject access to other tenants' data with AccessDeniedError.
 */
import type {
  AuditEvent, BillingMonthSummary, BillingSettings, BillingSettingsPatch, BillingStatus, CompanyContact, Branding, CorrectionRequest, CorrectionStatus,
  Employee, EntryValues, ISOMonth, License, LicensePlan, MonthAllocation, MonthlyStatement, PlatformRevenue, Tenant,
  NewPromoCode, PromoCode, PromoRedemption, SubscriptionInterval, TenantBillingMonth, TenantSubscription, TenantRole, TenantSettings, TimeEntry, TimeEntryRevision, UUID,
} from "../core/types";
import type { PersonalDataExport, TenantDataExport } from "../core/privacy";
import type { Invoice, InvoiceDraft, InvoiceSettings, InvoiceSettingsPatch } from "../core/invoice";
import type { StatementEvent } from "../core/types";

export class AccessDeniedError extends Error {
  constructor(message = "Kein Zugriff auf diese Daten.") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export class ConflictError extends Error {
  constructor(message = "Der Datensatz wurde zwischenzeitlich geändert.") {
    super(message);
    this.name = "ConflictError";
  }
}

export interface Session {
  userId: UUID;
  email: string;
  /** Set for tenant users (employee / manager / owner). */
  tenantId: UUID | null;
  employeeId: UUID | null;
  role: TenantRole | null;
  /** Set for platform operators. */
  platformRole: "super_admin" | "support" | null;
  /**
   * Two-factor authentication is mandatory for this account (platform staff,
   * or managers/owners of a tenant that requires it) but not set up yet: the
   * apps show only the setup until it is done.
   */
  twoFactorSetupRequired?: boolean;
  /** Set after a sign-in with a recovery code: unused codes left. */
  recoveryCodesRemaining?: number;
}

/**
 * Thrown by signIn when the password was correct and the account uses
 * two-factor authentication: continue with verifyTwoFactor (code from the
 * authenticator app or a recovery code).
 */
export class TwoFactorRequiredError extends Error {
  constructor(message = "Bitte gib den Bestätigungscode aus der Authenticator-App ein.") {
    super(message);
    this.name = "TwoFactorRequiredError";
  }
}

export type TwoFactorProof = { code: string } | { recoveryCode: string };

export interface TwoFactorStatus {
  enabled: boolean;
  enrolledAt: string | null;
  /** A setup was started but not confirmed. */
  pending: boolean;
  /** Mandatory for this account – disabling is possible only to set it up again. */
  required: boolean;
  requiredBy: "platform" | "tenant" | null;
  recoveryCodesRemaining: number;
}

export interface TwoFactorSetup {
  /** Base32 secret for manual entry (shown once). */
  secret: string;
  /** otpauth://totp/… for the QR code. */
  otpauthUri: string;
  issuer: string;
  account: string;
}

/** Two-factor functions of the signed-in user (demo and API). */
export interface TwoFactorApi {
  /** Second sign-in step after TwoFactorRequiredError. */
  verifyTwoFactor(proof: TwoFactorProof): Promise<Session>;
  getTwoFactorStatus(): Promise<TwoFactorStatus>;
  startTwoFactorSetup(): Promise<TwoFactorSetup>;
  /** Confirms with the first code; returns the 10 recovery codes (only now). */
  confirmTwoFactorSetup(code: string): Promise<{ recoveryCodes: string[] }>;
  /** Requires password + code (or recovery code). */
  disableTwoFactor(password: string, proof: TwoFactorProof): Promise<{ setupRequired: boolean }>;
  regenerateRecoveryCodes(password: string, proof: TwoFactorProof): Promise<{ recoveryCodes: string[] }>;
  /** Owner only: require 2FA for managers and owners of the tenant. */
  setTwoFactorRequirement(tenantId: UUID, required: boolean): Promise<Tenant>;
}

export interface NewTimeEntry {
  /** Client-generated UUID (idempotency key for offline sync). */
  id: string;
  date: string;
  start: string;
  end: string;
  pauseMinutes: number;
  note: string;
  /** "migration" for entries taken over from the legacy app; defaults to "app". */
  source?: "app" | "migration";
}

/** Input of Repository.createCorrectionRequest (reason: at least 5 characters). */
export type NewCorrectionRequest =
  | { kind: "change"; entryId: string; proposed: Partial<EntryValues>; reason: string }
  | { kind: "delete"; entryId: string; reason: string }
  | { kind: "add"; proposed: EntryValues; reason: string };

export interface TenantOverview {
  tenant: Tenant;
  license: License | null;
  employeeCount: number;
  activeEmployeeCount: number;
}

/** Returned by inviteEmployee / resendInvitation when an invitation was created. */
export interface InvitationInfo {
  expiresAt: string;
  /**
   * "email": sent via SMTP · "log": development server without SMTP (link in the server log) · "none": not sent (SMTP missing)
   * · "link": not sent – `link` is returned once for sharing (copy / WhatsApp) · "demo": demo build, nothing sent.
   */
  delivery: "email" | "log" | "none" | "link" | "demo";
  /** One-time invitation link (only for delivery "link"). Never stored by the client. */
  link?: string;
  /**
   * The address already belongs to an account (e.g. a person working for two companies): accepting links the
   * membership without a password, so the server mails the link to that address instead of returning it.
   */
  existingAccount?: boolean;
}

/** How a new invitation reaches the employee: e-mail from the server, or a link the manager shares. */
export type InvitationChannel = "email" | "link";

export interface NewEmployee {
  displayName: string;
  personnelNumber: string;
  email: string | null;
  role: TenantRole;
  /** Default "email". */
  invitation?: InvitationChannel;
}

export type InvitedEmployee = Employee & { invitation?: InvitationInfo };

/** Input of Repository.createTenant. freeOfCharge = free test customer in one step (special condition "free"). */
export interface NewTenant {
  name: string;
  slug: string;
  plan: LicensePlan;
  isDemo: boolean;
  ownerEmail: string;
  freeOfCharge?: boolean;
  conditionNote?: string | null;
  /** Last day of the free condition (YYYY-MM-DD); null/undefined = unlimited. */
  conditionValidUntil?: string | null;
}

/** Technical status for platform staff (GET /api/platform/system) – no secrets, no personal data. */
export interface SystemOverview {
  version: string | null;
  commit: string | null;
  serverTime: string;
  uptimeSeconds: number;
  nodeVersion: string;
  production: boolean;
  database: { reachable: boolean; time: string | null };
  migrations: { count: number; latest: string | null; appliedAt: string | null } | null;
  activeSessions: number | null;
  tenants: Record<string, number>;
  mail: { configured: boolean; delivery: "email" | "log" | "none" };
  paymentProvider: string;
  /** null = not known. */
  lastBackupAt: string | null;
}

export interface Repository {
  // ---- authentication
  /** Throws TwoFactorRequiredError when the account uses two-factor authentication. */
  signIn(email: string, password: string): Promise<Session>;
  signOut(): Promise<void>;
  currentSession(): Promise<Session | null>;
  requestPasswordReset(email: string): Promise<void>;

  // ---- tenant (any member reads own tenant; owner/manager edits)
  getTenant(tenantId: UUID): Promise<Tenant>;
  updateBranding(tenantId: UUID, branding: Partial<Branding>): Promise<Tenant>;
  updateContact(tenantId: UUID, contact: Partial<CompanyContact>): Promise<Tenant>;
  updateSettings(tenantId: UUID, settings: Partial<TenantSettings>): Promise<Tenant>;

  // ---- employees (managers: whole tenant; employees: only themselves)
  listEmployees(tenantId: UUID): Promise<Employee[]>;
  inviteEmployee(tenantId: UUID, input: { displayName: string; personnelNumber: string; email: string | null; role: TenantRole }): Promise<Employee>;
  updateEmployee(employeeId: UUID, patch: Partial<Pick<Employee, "displayName" | "personnelNumber" | "email" | "role">>): Promise<Employee>;
  /** "locked" = temporarily blocked (only from "active"), "active" = unlock / reactivate. */
  setEmployeeStatus(employeeId: UUID, status: "active" | "locked" | "deactivated", reason: string): Promise<Employee>;

  // ---- time entries
  listTimeEntries(employeeId: UUID, month: ISOMonth): Promise<TimeEntry[]>;
  listTenantTimeEntries(tenantId: UUID, fromDate: string, toDate: string): Promise<TimeEntry[]>;
  /** Idempotent: same id twice → no duplicate. */
  createTimeEntry(employeeId: UUID, entry: NewTimeEntry): Promise<TimeEntry>;
  /** Fails with ConflictError when expectedVersion is outdated. */
  updateTimeEntry(entryId: string, patch: Partial<NewTimeEntry>, expectedVersion: number, reason?: string): Promise<TimeEntry>;
  /** Soft delete. */
  deleteTimeEntry(entryId: string, expectedVersion: number, reason?: string): Promise<void>;

  // ---- work account
  listAllocations(employeeId: UUID): Promise<MonthAllocation[]>;
  setAllocation(employeeId: UUID, month: ISOMonth, minutes: number): Promise<MonthAllocation>;
  reviewAllocation(employeeId: UUID, month: ISOMonth, decision: "approved" | "rejected", reason: string): Promise<MonthAllocation>;

  // ---- monthly statements
  listStatements(tenantId: UUID, month: ISOMonth): Promise<MonthlyStatement[]>;
  getStatement(employeeId: UUID, month: ISOMonth): Promise<MonthlyStatement | null>;
  submitStatement(employeeId: UUID, month: ISOMonth): Promise<MonthlyStatement>;
  approveStatement(statementId: UUID): Promise<MonthlyStatement>;
  returnStatement(statementId: UUID, reason: string): Promise<MonthlyStatement>;

  // ---- correction requests (docs/bedienung-korrekturen.md)
  /** Employees: only their own requests; leadership: whole tenant; platform staff only with support grant. */
  listCorrectionRequests(tenantId: UUID, filter?: { employeeId?: UUID; status?: CorrectionStatus }): Promise<CorrectionRequest[]>;
  /** Employee, own entries only. */
  createCorrectionRequest(employeeId: UUID, input: NewCorrectionRequest): Promise<CorrectionRequest>;
  /** Employee withdraws an own open request. */
  withdrawCorrectionRequest(requestId: UUID): Promise<CorrectionRequest>;
  /** Leadership: "accepted" applies the change as a correction; "rejected" needs a note. */
  decideCorrectionRequest(requestId: UUID, decision: "accepted" | "rejected", note?: string): Promise<CorrectionRequest>;
  /** Change history of one entry (oldest first). */
  listTimeEntryRevisions(employeeId: UUID, entryId: string): Promise<TimeEntryRevision[]>;

  // ---- audit
  listAudit(tenantId: UUID, limit?: number): Promise<AuditEvent[]>;

  // ---- platform administration (super_admin only)
  listTenants(): Promise<TenantOverview[]>;
  createTenant(input: NewTenant): Promise<TenantOverview>;
  setTenantStatus(tenantId: UUID, status: Tenant["status"], reason: string): Promise<Tenant>;
  setLicense(tenantId: UUID, plan: LicensePlan, patch?: LicensePatch): Promise<License>;
}

/** Changeable licence fields incl. the special billing condition (super_admin). */
export type LicensePatch = Partial<Pick<License,
  "maxEmployees" | "validUntil" | "note" | "features"
  | "employeePriceCents" | "freeOfCharge" | "conditionNote" | "conditionValidFrom" | "conditionValidUntil">> & {
  /** Optional reason for the audit log. */
  reason?: string;
};

/**
 * Data protection (GDPR, migration 0016, docs/datenschutz.md). Access and audit
 * are enforced by the database; legal periods are tenant settings, not code.
 */
export interface PrivacyApi {
  /** Everything stored about one person in the tenant – for the person themself or the owner. */
  exportPersonalData(employeeId: UUID): Promise<PersonalDataExport>;
  /** Owner: all data of the tenant (e.g. on termination). */
  exportTenantData(tenantId: UUID): Promise<TenantDataExport>;
  /** Owner: retention period after an employee left, in months (1–600); null = not configured. */
  setRetentionPolicy(tenantId: UUID, months: number | null): Promise<Tenant>;
  /**
   * Owner: anonymise a deactivated employee after the retention period. The personnel number
   * must be repeated as confirmation. Working times stay (anonymised); cannot be undone.
   */
  anonymizeEmployee(employeeId: UUID, confirmPersonnelNumber: string): Promise<Employee>;
}

/**
 * Price model (2026-10-28): billing views. Owner/manager see their own tenant
 * with the billable persons; platform staff see numbers only (no names).
 */
export interface BillingApi {
  getTenantBilling(tenantId: UUID, month: ISOMonth): Promise<TenantBillingMonth>;
  /** Current month and previous months (newest first, not before the tenant was created). */
  listTenantBillingHistory(tenantId: UUID, limit?: number): Promise<BillingMonthSummary[]>;
  /** super_admin / support: revenue of all tenants for one month. */
  getPlatformRevenue(month: ISOMonth): Promise<PlatformRevenue>;
  getBillingSettings(): Promise<BillingSettings>;
  /** super_admin: default gross price (12-month subscription) per billable employee and month (cents), reason required. */
  setDefaultPrice(cents: number, reason: string): Promise<BillingSettings>;
  /** super_admin: prices, trial window, notice days, welcome code (migration 0023); only given fields change, reason required. */
  updateBillingSettings(patch: BillingSettingsPatch): Promise<BillingSettings>;
  /**
   * super_admin: manual billing status of a past month. Leaving "open" freezes
   * the month; "waived" and reopening ("open") need a note.
   */
  setBillingStatus(tenantId: UUID, month: ISOMonth, status: BillingStatus, note?: string): Promise<BillingMonthSummary>;
}

/**
 * Decision of 28.10.2026: an approved month is changed only after a documented
 * re-opening (reason, audit) and a new approval (migration 0017).
 */
export interface StatementReviewApi {
  /** Leadership: approved → reopened (reason ≥ 5 characters). The own statement only the owner. */
  reopenStatement(statementId: UUID, reason: string): Promise<MonthlyStatement>;
  /** Submissions, approvals, returns and re-openings of one statement (oldest first). */
  listStatementEvents(statementId: UUID): Promise<StatementEvent[]>;
}

/**
 * Invoices (migration 0019). Platform staff: all customers; the owner: own invoices.
 * Nothing is sent and nothing is charged – the PDF is generated in the app.
 */
export interface InvoiceApi {
  getInvoiceSettings(): Promise<InvoiceSettings>;
  /** super_admin, reason required. */
  updateInvoiceSettings(patch: InvoiceSettingsPatch, reason: string): Promise<InvoiceSettings>;
  /** Platform staff: invoices of all customers (optionally one customer / month), newest first. */
  listInvoices(filter?: { tenantId?: UUID; month?: ISOMonth }): Promise<Invoice[]>;
  /** Owner: invoices of the own tenant. */
  listTenantInvoices(tenantId: UUID): Promise<Invoice[]>;
  /** Preview without number; `missing` lists absent mandatory data (then only a draft PDF is possible). */
  getInvoiceDraft(tenantId: UUID, month: ISOMonth): Promise<InvoiceDraft>;
  /** super_admin: issues the invoice of a past billing month (freezes an open month as "invoiced"). */
  issueInvoice(tenantId: UUID, month: ISOMonth): Promise<Invoice>;
  /** super_admin: cancellation document with its own number; the original stays. */
  cancelInvoice(invoiceId: UUID, reason: string): Promise<Invoice>;
}

/**
 * Promo codes (decision 30.10.2026, migration 0022). The super admin creates codes
 * with 1–100 % discount and ends them; the owner of a tenant redeems one. The
 * discount runs until the super admin ends it (effective from the following month).
 */
export interface PromoApi {
  /** Platform staff: all codes with their redemptions (company names only). */
  listPromoCodes(): Promise<PromoCode[]>;
  /** super_admin. */
  createPromoCode(input: NewPromoCode): Promise<PromoCode>;
  /** super_admin: no new redemptions; all running discounts of the code end (reason required). */
  endPromoCode(promoCodeId: UUID, reason: string): Promise<PromoCode>;
  /** super_admin: ends the running discount of one tenant (reason required). */
  endTenantPromo(tenantId: UUID, reason: string): Promise<PromoRedemption>;
  /** Leadership of the tenant (and platform staff): redemptions of the tenant, newest first. */
  listTenantPromo(tenantId: UUID): Promise<PromoRedemption[]>;
  /** Owner: redeem a code. */
  redeemPromoCode(tenantId: UUID, code: string): Promise<PromoRedemption>;
}

/**
 * Subscription (decision 30.10.2026, migration 0023, core/subscription.ts): trial, 12-month
 * subscription or monthly plan, cancellation. Leadership of the tenant and platform staff read;
 * only the owner changes. Every change is audited; cancelling sends a confirmation mail (API).
 */
export interface SubscriptionApi {
  getTenantSubscription(tenantId: UUID): Promise<TenantSubscription>;
  /** Owner: choose a plan (monthly → annual from the next month; after the end: new term). */
  chooseSubscription(tenantId: UUID, interval: SubscriptionInterval): Promise<TenantSubscription>;
  /** Owner: cancel the running term (annual optionally "continue monthly afterwards"). */
  cancelSubscription(tenantId: UUID, input: { thenMonthly?: boolean; reason?: string | null }): Promise<TenantSubscription>;
  /** Owner: withdraw a cancellation before it takes effect. */
  withdrawCancellation(tenantId: UUID): Promise<TenantSubscription>;
}

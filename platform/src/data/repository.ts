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
  AuditEvent, CompanyContact, Branding, Employee, ISOMonth, License, LicensePlan,
  MonthAllocation, MonthlyStatement, Tenant, TenantRole, TenantSettings, TimeEntry, UUID,
} from "../core/types";

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
}

export interface NewTimeEntry {
  /** Client-generated UUID (idempotency key for offline sync). */
  id: string;
  date: string;
  start: string;
  end: string;
  pauseMinutes: number;
  note: string;
}

export interface TenantOverview {
  tenant: Tenant;
  license: License | null;
  employeeCount: number;
  activeEmployeeCount: number;
}

export interface Repository {
  // ---- authentication
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
  setEmployeeStatus(employeeId: UUID, status: "active" | "deactivated", reason: string): Promise<Employee>;

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

  // ---- audit
  listAudit(tenantId: UUID, limit?: number): Promise<AuditEvent[]>;

  // ---- platform administration (super_admin only)
  listTenants(): Promise<TenantOverview[]>;
  createTenant(input: { name: string; slug: string; plan: LicensePlan; isDemo: boolean; ownerEmail: string }): Promise<TenantOverview>;
  setTenantStatus(tenantId: UUID, status: Tenant["status"], reason: string): Promise<Tenant>;
  setLicense(tenantId: UUID, plan: LicensePlan, patch?: Partial<Pick<License, "maxEmployees" | "validUntil" | "note" | "features">>): Promise<License>;
}

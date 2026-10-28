/**
 * ApiRepository: Repository implementation that talks to our own Node API
 * (server/, see docs/api.md) via fetch with the HttpOnly session cookie
 * (`credentials: "include"`).
 *
 * Error mapping:
 *  - signIn answered with {twoFactorRequired: true} → TwoFactorRequiredError
 *    (continue with verifyTwoFactor; the pending sign-in is an HttpOnly cookie)
 *  - 403 with code "two_factor_setup_required" → TwoFactorSetupRequiredError
 *    (an AccessDeniedError; mandatory 2FA not set up yet)
 *  - 401 outside of signIn → SessionExpiredError (an AccessDeniedError)
 *  - 403 with code "tenant_suspended" → TenantSuspendedError (an AccessDeniedError)
 *  - other 403 → AccessDeniedError
 *  - 409 with code "version_conflict" → ConflictError
 *  - no connection → ApiError with status 0 and `network === true` (the sync
 *    layer treats it like a fetch TypeError and keeps the change queued)
 *  - everything else → ApiError (status + code + German message from the server)
 *
 * Expired sessions and suspended tenants are additionally reported to
 * `options.onAuthFailure`, so the apps can return to the login screen.
 *
 * The browser sends the Origin header itself; every write is sent as
 * `Content-Type: application/json` as required by the server's CSRF check.
 */
import type {
  AuditEvent, BillingMonthSummary, BillingSettings, Branding, CompanyContact, CorrectionRequest, Employee, ISOMonth, License,
  LicensePlan, MonthAllocation, MonthlyStatement, PlatformRevenue, Tenant, TenantBillingMonth, TenantSettings, TimeEntry,
  TimeEntryRevision, UUID,
} from "../core/types";
import {
  AccessDeniedError, ConflictError, TwoFactorRequiredError,
  type BillingApi, type LicensePatch, type NewCorrectionRequest, type NewTenant, type NewTimeEntry, type Repository, type Session,
  type InvitationChannel, type InvitationInfo, type InvitedEmployee, type NewEmployee, type SystemOverview, type TenantOverview,
  type TwoFactorApi, type TwoFactorProof,
  type TwoFactorSetup, type TwoFactorStatus,
} from "./repository";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
  /** True when the server could not be reached (see isNetworkError in sync.ts). */
  get network(): boolean {
    return this.status === 0;
  }
}

/** 401: the session cookie is missing, expired or idle-timed-out. */
export class SessionExpiredError extends AccessDeniedError {
  constructor(message = "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** 403 tenant_suspended: the company access is blocked by the platform operator. */
export class TenantSuspendedError extends AccessDeniedError {
  constructor(message = "Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber.") {
    super(message);
    this.name = "TenantSuspendedError";
  }
}

/** 403 two_factor_setup_required: the account must set up two-factor authentication first. */
export class TwoFactorSetupRequiredError extends AccessDeniedError {
  constructor(message = "Für dein Konto ist die Zwei-Faktor-Anmeldung vorgeschrieben. Bitte richte sie zuerst ein.") {
    super(message);
    this.name = "TwoFactorSetupRequiredError";
  }
}

export type AuthFailure = { kind: "expired" | "suspended" | "two_factor_setup"; message: string };

export type { InvitationChannel, InvitationInfo, InvitedEmployee, NewEmployee } from "./repository";

export interface InvitationResult {
  existingAccount: boolean;
  /** German text for the user. */
  message: string;
}

export interface SupportGrantInfo {
  tenantId: UUID;
  grantedUntil: string;
  grantedBy: UUID | null;
}

/** Repository plus the server functions the UI uses beyond the base contract. */
export interface ApiRepository extends Repository, TwoFactorApi, BillingApi {
  listPlatformAudit(limit?: number): Promise<AuditEvent[]>;
  getSupportGrant(tenantId: UUID): Promise<SupportGrantInfo | null>;
  setSupportGrant(tenantId: UUID, hours: number, reason?: string): Promise<SupportGrantInfo | null>;
  confirmPasswordReset(token: string, password: string): Promise<void>;
  /**
   * New account: sets the password. Existing account with that e-mail: links
   * the invitation without changing the password (existingAccount = true) –
   * show `message` and ask the user to sign in with the existing password.
   */
  acceptInvitation(token: string, password?: string): Promise<InvitationResult>;
  inviteEmployee(tenantId: UUID, input: NewEmployee): Promise<InvitedEmployee>;
  resendInvitation(employeeId: UUID): Promise<InvitationInfo | null>;
  /** New invitation for an invited employee (earlier links become invalid). */
  createInvitation(employeeId: UUID, channel: InvitationChannel): Promise<InvitationInfo>;
  /** Owner: display name of the company. */
  renameTenant(tenantId: UUID, name: string): Promise<Tenant>;
  /** super_admin / support: technical status. */
  getSystemOverview(): Promise<SystemOverview>;
}

export interface ApiRepositoryOptions {
  /** Custom fetch (tests, SSR). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Called on 401 (outside signIn) and on 403 tenant_suspended – e.g. to show the login again. */
  onAuthFailure?: (failure: AuthFailure) => void;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const enc = encodeURIComponent;

export function createApiRepository(baseUrl: string, options: ApiRepositoryOptions = {}): ApiRepository {
  const base = baseUrl.replace(/\/+$/, "");
  // Late-bound so a fetch installed after construction (tests, polyfills) is used.
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  /** entry id → employee id, learned from list/create results (ids are unique per employee only). */
  const entryOwner = new Map<string, UUID>();

  async function request<T>(method: Method, path: string, body?: unknown, opts: { signIn?: boolean } = {}): Promise<T> {
    const init: RequestInit = { method, credentials: "include", headers: { Accept: "application/json" } };
    if (method !== "GET") {
      init.headers = { Accept: "application/json", "Content-Type": "application/json" };
      init.body = JSON.stringify(body ?? {});
    }
    let res: Response;
    try {
      res = await doFetch(base + path, init);
    } catch {
      throw new ApiError(0, "network", "Keine Verbindung zum Server. Bitte später erneut versuchen.");
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (res.ok) return data as T;
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code ?? "error";
    const message = err?.message ?? `Anfrage fehlgeschlagen (${res.status}).`;
    if (res.status === 401 && !opts.signIn) {
      const e = new SessionExpiredError(err?.message && code !== "unauthenticated" ? err.message : undefined);
      options.onAuthFailure?.({ kind: "expired", message: e.message });
      throw e;
    }
    if (res.status === 403 && code === "two_factor_setup_required") {
      const e = new TwoFactorSetupRequiredError(err?.message);
      options.onAuthFailure?.({ kind: "two_factor_setup", message: e.message });
      throw e;
    }
    if (res.status === 403 && code === "tenant_suspended") {
      const e = new TenantSuspendedError(err?.message);
      if (!opts.signIn) options.onAuthFailure?.({ kind: "suspended", message: e.message });
      throw e;
    }
    if (res.status === 403) throw new AccessDeniedError(message);
    if (res.status === 409 && code === "version_conflict") throw new ConflictError(message);
    throw new ApiError(res.status, code, message);
  }

  const remember = (entries: TimeEntry[]) => {
    for (const e of entries) entryOwner.set(e.id, e.employeeId);
    return entries;
  };
  const entryPath = (entryId: string) => {
    const owner = entryOwner.get(entryId);
    return owner ? `/api/employees/${enc(owner)}/time-entries/${enc(entryId)}` : `/api/time-entries/${enc(entryId)}`;
  };

  return {
    // ---- authentication
    async signIn(email, password) {
      const r = await request<Session | { twoFactorRequired: true }>("POST", "/api/auth/login", { email, password }, { signIn: true });
      if (r && "twoFactorRequired" in r && r.twoFactorRequired) throw new TwoFactorRequiredError();
      return r as Session;
    },
    verifyTwoFactor(proof: TwoFactorProof) {
      return request<Session>("POST", "/api/auth/2fa/verify", proof, { signIn: true });
    },
    getTwoFactorStatus() {
      return request<TwoFactorStatus>("GET", "/api/auth/2fa");
    },
    startTwoFactorSetup() {
      return request<TwoFactorSetup>("POST", "/api/auth/2fa/setup", {});
    },
    confirmTwoFactorSetup(code) {
      return request<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/setup/confirm", { code });
    },
    disableTwoFactor(password, proof: TwoFactorProof) {
      return request<{ setupRequired: boolean }>("POST", "/api/auth/2fa/disable", { password, ...proof });
    },
    regenerateRecoveryCodes(password, proof: TwoFactorProof) {
      return request<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/recovery-codes", { password, ...proof });
    },
    setTwoFactorRequirement(tenantId, required) {
      return request<Tenant>("PUT", `/api/tenants/${enc(tenantId)}/two-factor-policy`, { requireTwoFactorForManagers: required });
    },
    async signOut() {
      entryOwner.clear();
      await request<void>("POST", "/api/auth/logout", {});
    },
    async currentSession() {
      return request<Session | null>("GET", "/api/auth/session");
    },
    async requestPasswordReset(email) {
      await request<void>("POST", "/api/auth/password-reset", { email });
    },
    async confirmPasswordReset(token, password) {
      await request<void>("POST", "/api/auth/password-reset/confirm", { token, password });
    },
    acceptInvitation(token, password) {
      return request<InvitationResult>("POST", "/api/auth/invitation/accept", password === undefined ? { token } : { token, password });
    },

    // ---- tenant
    getTenant(tenantId) {
      return request<Tenant>("GET", `/api/tenants/${enc(tenantId)}`);
    },
    updateBranding(tenantId, branding: Partial<Branding>) {
      return request<Tenant>("PATCH", `/api/tenants/${enc(tenantId)}/branding`, branding);
    },
    updateContact(tenantId, contact: Partial<CompanyContact>) {
      return request<Tenant>("PATCH", `/api/tenants/${enc(tenantId)}/contact`, contact);
    },
    renameTenant(tenantId, name) {
      return request<Tenant>("PATCH", `/api/tenants/${enc(tenantId)}/name`, { name });
    },
    updateSettings(tenantId, settings: Partial<TenantSettings>) {
      return request<Tenant>("PATCH", `/api/tenants/${enc(tenantId)}/settings`, settings);
    },
    getSupportGrant(tenantId) {
      return request<SupportGrantInfo | null>("GET", `/api/tenants/${enc(tenantId)}/support-grant`);
    },
    setSupportGrant(tenantId, hours, reason) {
      return request<SupportGrantInfo | null>("PUT", `/api/tenants/${enc(tenantId)}/support-grant`, reason === undefined ? { hours } : { hours, reason });
    },

    // ---- employees
    listEmployees(tenantId) {
      return request<Employee[]>("GET", `/api/tenants/${enc(tenantId)}/employees`);
    },
    inviteEmployee(tenantId, input: NewEmployee) {
      const { invitation, ...rest } = input;
      return request<InvitedEmployee>("POST", `/api/tenants/${enc(tenantId)}/employees`, invitation === "link" ? { ...rest, invitation } : rest);
    },
    async resendInvitation(employeeId) {
      const r = await request<{ expiresAt: string; delivery?: InvitationInfo["delivery"] } | null>("POST", `/api/employees/${enc(employeeId)}/invitation`, {});
      return r ? { expiresAt: r.expiresAt, delivery: r.delivery ?? "email" } : null;
    },
    async createInvitation(employeeId, channel) {
      const r = await request<InvitationInfo>("POST", `/api/employees/${enc(employeeId)}/invitation`, channel === "link" ? { channel } : {});
      return { expiresAt: r.expiresAt, delivery: r.delivery ?? "email", ...(r.link ? { link: r.link } : {}) };
    },
    updateEmployee(employeeId, patch) {
      return request<Employee>("PATCH", `/api/employees/${enc(employeeId)}`, patch);
    },
    setEmployeeStatus(employeeId, status, reason) {
      return request<Employee>("POST", `/api/employees/${enc(employeeId)}/status`, { status, reason });
    },

    // ---- time entries
    async listTimeEntries(employeeId, month: ISOMonth) {
      return remember(await request<TimeEntry[]>("GET", `/api/employees/${enc(employeeId)}/time-entries?month=${enc(month)}`));
    },
    async listTenantTimeEntries(tenantId, fromDate, toDate) {
      return remember(await request<TimeEntry[]>("GET", `/api/tenants/${enc(tenantId)}/time-entries?from=${enc(fromDate)}&to=${enc(toDate)}`));
    },
    async createTimeEntry(employeeId, entry: NewTimeEntry) {
      // `source` ("app" | "migration") is sent only when set; the server defaults to "app".
      const body = { id: entry.id, date: entry.date, start: entry.start, end: entry.end, pauseMinutes: entry.pauseMinutes, note: entry.note, ...(entry.source ? { source: entry.source } : {}) };
      const created = await request<TimeEntry>("POST", `/api/employees/${enc(employeeId)}/time-entries`, body);
      remember([created]);
      return created;
    },
    async updateTimeEntry(entryId, patch, expectedVersion, reason) {
      const { id: _ignored, ...rest } = patch;
      void _ignored;
      const body: Record<string, unknown> = { patch: rest, expectedVersion };
      if (reason !== undefined) body.reason = reason;
      const updated = await request<TimeEntry>("PATCH", entryPath(entryId), body);
      remember([updated]);
      return updated;
    },
    async deleteTimeEntry(entryId, expectedVersion, reason) {
      const body: Record<string, unknown> = { expectedVersion };
      if (reason !== undefined) body.reason = reason;
      await request<void>("DELETE", entryPath(entryId), body);
    },

    // ---- work account
    listAllocations(employeeId) {
      return request<MonthAllocation[]>("GET", `/api/employees/${enc(employeeId)}/allocations`);
    },
    setAllocation(employeeId, month, minutes) {
      return request<MonthAllocation>("PUT", `/api/employees/${enc(employeeId)}/allocations/${enc(month)}`, { minutes });
    },
    reviewAllocation(employeeId, month, decision, reason) {
      return request<MonthAllocation>("POST", `/api/employees/${enc(employeeId)}/allocations/${enc(month)}/review`, { decision, reason });
    },

    // ---- monthly statements
    listStatements(tenantId, month) {
      return request<MonthlyStatement[]>("GET", `/api/tenants/${enc(tenantId)}/statements?month=${enc(month)}`);
    },
    getStatement(employeeId, month) {
      return request<MonthlyStatement | null>("GET", `/api/employees/${enc(employeeId)}/statements/${enc(month)}`);
    },
    submitStatement(employeeId, month) {
      return request<MonthlyStatement>("POST", `/api/employees/${enc(employeeId)}/statements/${enc(month)}/submit`, {});
    },
    approveStatement(statementId) {
      return request<MonthlyStatement>("POST", `/api/statements/${enc(statementId)}/approve`, {});
    },
    returnStatement(statementId, reason) {
      return request<MonthlyStatement>("POST", `/api/statements/${enc(statementId)}/return`, { reason });
    },

    // ---- correction requests
    listCorrectionRequests(tenantId, filter = {}) {
      const qs = new URLSearchParams();
      if (filter.employeeId) qs.set("employeeId", filter.employeeId);
      if (filter.status) qs.set("status", filter.status);
      const query = qs.toString();
      return request<CorrectionRequest[]>("GET", `/api/tenants/${enc(tenantId)}/correction-requests${query ? `?${query}` : ""}`);
    },
    createCorrectionRequest(employeeId, input: NewCorrectionRequest) {
      return request<CorrectionRequest>("POST", `/api/employees/${enc(employeeId)}/correction-requests`, input);
    },
    withdrawCorrectionRequest(requestId) {
      return request<CorrectionRequest>("POST", `/api/correction-requests/${enc(requestId)}/withdraw`, {});
    },
    decideCorrectionRequest(requestId, decision, note) {
      return request<CorrectionRequest>("POST", `/api/correction-requests/${enc(requestId)}/decide`, note === undefined ? { decision } : { decision, note });
    },
    listTimeEntryRevisions(employeeId, entryId) {
      return request<TimeEntryRevision[]>("GET", `/api/employees/${enc(employeeId)}/time-entries/${enc(entryId)}/revisions`);
    },

    // ---- audit
    listAudit(tenantId, limit) {
      return request<AuditEvent[]>("GET", `/api/tenants/${enc(tenantId)}/audit${limit ? `?limit=${limit}` : ""}`);
    },
    listPlatformAudit(limit) {
      return request<AuditEvent[]>("GET", `/api/platform/audit${limit ? `?limit=${limit}` : ""}`);
    },

    // ---- platform administration
    listTenants() {
      return request<TenantOverview[]>("GET", "/api/platform/tenants");
    },
    createTenant(input: NewTenant) {
      return request<TenantOverview>("POST", "/api/platform/tenants", input);
    },
    getSystemOverview() {
      return request<SystemOverview>("GET", "/api/platform/system");
    },
    setTenantStatus(tenantId, status, reason) {
      return request<Tenant>("POST", `/api/platform/tenants/${enc(tenantId)}/status`, { status, reason });
    },
    setLicense(tenantId, plan: LicensePlan, patch: LicensePatch = {}) {
      return request<License>("PUT", `/api/platform/tenants/${enc(tenantId)}/license`, { plan, ...patch });
    },

    // ---- billing (price model 2026-10-28)
    getTenantBilling(tenantId, month) {
      return request<TenantBillingMonth>("GET", `/api/tenants/${enc(tenantId)}/billing?month=${enc(month)}`);
    },
    listTenantBillingHistory(tenantId, limit) {
      return request<BillingMonthSummary[]>("GET", `/api/tenants/${enc(tenantId)}/billing/history${limit ? `?limit=${limit}` : ""}`);
    },
    getPlatformRevenue(month) {
      return request<PlatformRevenue>("GET", `/api/platform/billing?month=${enc(month)}`);
    },
    getBillingSettings() {
      return request<BillingSettings>("GET", "/api/platform/billing/settings");
    },
    setDefaultPrice(cents, reason) {
      return request<BillingSettings>("PUT", "/api/platform/billing/settings", { defaultPriceCents: cents, reason });
    },
    setBillingStatus(tenantId, month, status, note) {
      return request<BillingMonthSummary>("PUT", `/api/platform/tenants/${enc(tenantId)}/billing/${enc(month)}`, note === undefined ? { status } : { status, note });
    },
  };
}

/**
 * ApiRepository: Repository implementation that talks to our own Node API
 * (server/, see docs/api.md) via fetch with the HttpOnly session cookie
 * (`credentials: "include"`).
 *
 * Error mapping:
 *  - 403 (and 401 outside of signIn) → AccessDeniedError
 *  - 409 with code "version_conflict" → ConflictError
 *  - everything else → ApiError (status + code + German message from the server)
 *
 * The browser sends the Origin header itself; every write is sent as
 * `Content-Type: application/json` as required by the server's CSRF check.
 */
import type {
  AuditEvent, Branding, CompanyContact, Employee, ISOMonth, License, LicensePlan,
  MonthAllocation, MonthlyStatement, Tenant, TenantRole, TenantSettings, TimeEntry, UUID,
} from "../core/types";
import {
  AccessDeniedError, ConflictError,
  type NewTimeEntry, type Repository, type Session, type TenantOverview,
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
}

export interface SupportGrantInfo {
  tenantId: UUID;
  grantedUntil: string;
  grantedBy: UUID | null;
}

/** Repository plus the server functions the UI uses beyond the base contract. */
export interface ApiRepository extends Repository {
  listPlatformAudit(limit?: number): Promise<AuditEvent[]>;
  getSupportGrant(tenantId: UUID): Promise<SupportGrantInfo | null>;
  setSupportGrant(tenantId: UUID, hours: number, reason?: string): Promise<SupportGrantInfo | null>;
  confirmPasswordReset(token: string, password: string): Promise<void>;
  acceptInvitation(token: string, password: string): Promise<void>;
  resendInvitation(employeeId: UUID): Promise<void>;
}

export interface ApiRepositoryOptions {
  /** Custom fetch (tests, SSR). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
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
    if (res.status === 403 || (res.status === 401 && !opts.signIn)) throw new AccessDeniedError(message);
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
      return request<Session>("POST", "/api/auth/login", { email, password }, { signIn: true });
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
    async acceptInvitation(token, password) {
      await request<void>("POST", "/api/auth/invitation/accept", { token, password });
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
    inviteEmployee(tenantId, input: { displayName: string; personnelNumber: string; email: string | null; role: TenantRole }) {
      return request<Employee>("POST", `/api/tenants/${enc(tenantId)}/employees`, input);
    },
    async resendInvitation(employeeId) {
      await request<unknown>("POST", `/api/employees/${enc(employeeId)}/invitation`, {});
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
      const created = await request<TimeEntry>("POST", `/api/employees/${enc(employeeId)}/time-entries`, entry);
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
    createTenant(input: { name: string; slug: string; plan: LicensePlan; isDemo: boolean; ownerEmail: string }) {
      return request<TenantOverview>("POST", "/api/platform/tenants", input);
    },
    setTenantStatus(tenantId, status, reason) {
      return request<Tenant>("POST", `/api/platform/tenants/${enc(tenantId)}/status`, { status, reason });
    },
    setLicense(tenantId, plan: LicensePlan, patch: Partial<Pick<License, "maxEmployees" | "validUntil" | "note" | "features">> = {}) {
      return request<License>("PUT", `/api/platform/tenants/${enc(tenantId)}/license`, { plan, ...patch });
    },
  };
}

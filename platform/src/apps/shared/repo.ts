/**
 * Repository wiring for the UI apps.
 *
 * Build-time switch `VITE_DATA_MODE`:
 *  - "demo" (default, staging): in-browser DemoRepository with invented data;
 *    every app area keeps its own demo login.
 *  - "api": our own Node API (server/, docs/api.md) at `VITE_API_BASE`
 *    (default: same origin). One HttpOnly session cookie is shared by all
 *    areas of the origin.
 */
import type { AuditEvent, Tenant, UUID } from "../../core/types";
import { createApiRepository, type ApiRepository, type AuthFailure, type SupportGrantInfo } from "../../data/api";
import { createDemoRepository, memoryStorage, type DemoRepository, type KeyValueStorage } from "../../data/demo";
import type {
  BillingApi, InvitationChannel, InvitationInfo, InvitedEmployee, InvoiceApi, NewEmployee, PrivacyApi, Repository, StatementReviewApi,
  SystemOverview, TwoFactorApi,
} from "../../data/repository";

export type AppArea = "app" | "chef" | "admin";
export type DataMode = "demo" | "api";

export const DATA_MODE: DataMode = import.meta.env.VITE_DATA_MODE === "api" ? "api" : "demo";
/** True while the app runs on demo data (staging build). */
export const IS_DEMO = DATA_MODE === "demo";
/** API base URL without trailing slash ("" = same origin). */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

/** What the three apps use: the repository contract plus 2FA, billing, privacy, support-grant and platform-audit helpers (demo and API). */
export interface AreaRepository extends Repository, TwoFactorApi, BillingApi, PrivacyApi, StatementReviewApi, InvoiceApi {
  listPlatformAudit(limit?: number): Promise<AuditEvent[]>;
  getSupportGrant(tenantId: UUID): Promise<SupportGrantInfo | null>;
  setSupportGrant(tenantId: UUID, hours: number): Promise<SupportGrantInfo | null>;
  inviteEmployee(tenantId: UUID, input: NewEmployee): Promise<InvitedEmployee>;
  createInvitation(employeeId: UUID, channel: InvitationChannel): Promise<InvitationInfo>;
  renameTenant(tenantId: UUID, name: string): Promise<Tenant>;
  getSystemOverview(): Promise<SystemOverview>;
}

export function safeStorage(): KeyValueStorage {
  try {
    const probe = "__stundenwerk_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryStorage();
  }
}

// ------------------------------------------------------------------ auth failures (api mode)

const authListeners = new Set<(f: AuthFailure) => void>();

/** Expired session (401) or suspended tenant (403 tenant_suspended) – the app returns to its login. */
export function onAuthFailure(listener: (f: AuthFailure) => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function emitAuthFailure(f: AuthFailure): void {
  for (const l of [...authListeners]) {
    try { l(f); } catch { /* a broken listener must not hide the error */ }
  }
}

// ------------------------------------------------------------------ repositories

const demoCache = new Map<AppArea, DemoRepository>();
let api: ApiRepository | null = null;

/** Demo build only: the in-browser demo database of one area (start page: reset). */
export function getDemoRepository(area: AppArea): DemoRepository {
  let repo = demoCache.get(area);
  if (!repo) {
    repo = createDemoRepository(safeStorage(), { sessionKey: `stundenwerk_demo_session_${area}` });
    demoCache.set(area, repo);
  }
  return repo;
}

/** API build only: the API client (one per page; the session cookie is shared by all areas). */
export function getApiRepository(): ApiRepository {
  if (!api) api = createApiRepository(API_BASE, { onAuthFailure: emitAuthFailure });
  return api;
}

/** Repository of an app area (demo: own demo login per area; api: shared API client). */
export function getRepository(area: AppArea): AreaRepository {
  return DATA_MODE === "api" ? getApiRepository() : getDemoRepository(area);
}

/** Demo build only: the current 2FA code of the account signing in (no authenticator app needed). */
export async function demoTwoFactorCode(area: AppArea): Promise<string | null> {
  return IS_DEMO ? getDemoRepository(area).demoTwoFactorCode() : null;
}

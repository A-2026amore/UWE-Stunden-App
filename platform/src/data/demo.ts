/**
 * DemoRepository: complete in-browser implementation of the Repository
 * contract for staging previews and UI tests.
 *
 * - Two fictional demo companies with anonymised seed data (no real people).
 * - Enforces tenant isolation and role checks (AccessDeniedError) so UI tests
 *   can verify that cross-tenant access is denied. In production the database
 *   (row level security on the server) is the security boundary – these checks
 *   mirror its rules for the demo only.
 * - Audit events for all administrative changes, soft delete, optimistic
 *   version checks and time-entry validation with the core rules
 *   (12 h maximum, overlaps, statutory breaks).
 *
 * All demo passwords are "demo". Never put real personal data in here.
 *
 * Two-factor authentication works like on the server (real TOTP, RFC 6238,
 * usable with any authenticator app; replay protection; single-use recovery
 * codes). Demo deviations: the secret and the recovery codes are kept in
 * plain text in this browser's storage, and the mandatory 2FA for platform
 * accounts is NOT enforced (the demo admin stays usable without a phone).
 * The owner's requirement for managers is enforced. `demoTwoFactorCode()`
 * shows the current code without an app (docs/security.md, "Demo").
 */
import type {
  AuditEvent, BillableReason, BillingCondition, BillingMonthSummary, BillingStatus, Branding, CompanyContact, CorrectionRequest,
  Employee, EntryValues, ISODate, ISOMonth, License, LicensePlan, MonthAllocation, MonthlyStatement, PlatformRevenueRow, Tenant,
  TenantBillingMonth, TenantRole, TenantSettings, TimeEntry, TimeEntryRevision, UUID, WorkAccountPolicy,
} from "../core/types";
import {
  DEFAULT_EMPLOYEE_PRICE_CENTS, billableReason, billingAmount, billingConditionFor, berlinMonthOf, monthsBack, revenueTotals,
  type StatusPeriod,
} from "../core/billing";
import { activeShifts, addDays, findOverlapAcrossDays, grossMinutes, isRealDate, isValidEntry, isValidMonth, parseClock } from "../core/time";
import { retentionEndsAt, type ExportPerson, type ExportRecords, type ExportTimeEntry, type PersonalDataExport, type TenantDataExport } from "../core/privacy";
import { UWE_BREAK_POLICY, defaultBreakPolicy, evaluateDay, issueForDay, validateBreakPolicy } from "../core/breaks";
import { UWE_WORK_ACCOUNT_POLICY, summarizeMonth, validateAllocation } from "../core/workAccount";
import {
  AccessDeniedError, ConflictError, TwoFactorRequiredError,
  type BillingApi, type InvitationChannel, type InvitationInfo, type InvitedEmployee, type NewEmployee, type NewTimeEntry, type PrivacyApi, type Repository,
  type Session, type SystemOverview, type TenantOverview, type TwoFactorApi, type TwoFactorProof,
} from "./repository";
import {
  base32Decode, base32Encode, generateRecoveryCode, matchTotpStep, normalizeRecoveryCode, normalizeTotpCode, otpauthUri,
  hotp, RECOVERY_CODE_COUNT, timeStep, TOTP_SECRET_BYTES,
} from "../security/totp";

// ------------------------------------------------------------------ public constants

export const DEMO_PASSWORD = "demo";
export const DEMO_DB_KEY = "stundenwerk_demo_db_v1";

export interface DemoLogin { email: string; label: string; area: "app" | "chef" | "admin"; tenant: string | null }

export const DEMO_LOGINS: DemoLogin[] = [
  { email: "anna@demo-kt.example", label: "Mitarbeiterin (Demo Krankentransporte)", area: "app", tenant: "Demo Krankentransporte" },
  { email: "ben@demo-kt.example", label: "Mitarbeiter (Demo Krankentransporte)", area: "app", tenant: "Demo Krankentransporte" },
  { email: "chef@demo-kt.example", label: "Chef / Inhaber (Demo Krankentransporte)", area: "chef", tenant: "Demo Krankentransporte" },
  { email: "mia@muster-pflege.example", label: "Mitarbeiterin (Muster Pflegedienst)", area: "app", tenant: "Muster Pflegedienst GmbH" },
  { email: "leitung@muster-pflege.example", label: "Leitung (Muster Pflegedienst)", area: "chef", tenant: "Muster Pflegedienst GmbH" },
  { email: "admin@plattform.example", label: "Super-Admin (Plattformbetreiber)", area: "admin", tenant: null },
  { email: "support@plattform.example", label: "Support (Plattformbetreiber)", area: "admin", tenant: null },
];

export const DEMO_TENANT_IDS = {
  kt: "10000000-0000-4000-8000-000000000001",
  pflege: "10000000-0000-4000-8000-000000000002",
} as const;

/** Maximum size of an uploaded logo (data URL) in bytes. */
export const MAX_LOGO_BYTES = 300 * 1024;
/** Like the API (server/src/validate.ts imageUrl): no SVG uploads – SVG can carry script. */
export const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];

// ------------------------------------------------------------------ storage + db types

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage (tests, private browsing fallback). */
export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

interface Account {
  userId: UUID;
  email: string;
  password: string;
  tenantId: UUID | null;
  employeeId: UUID | null;
  platformRole: "super_admin" | "support" | null;
}

interface StoredAllocation extends MonthAllocation {
  tenantId: UUID;
  reviewNote: string | null;
  updatedAt: string;
}

export interface SupportGrant {
  tenantId: UUID;
  grantedUntil: string;
  grantedBy: UUID;
}

/** Demo only: plain-text secret and recovery codes in browser storage (the server encrypts/hashes). */
interface DemoTwoFactor {
  userId: UUID;
  secret: string;
  createdAt: string;
  enrolledAt: string | null;
  lastUsedStep: number | null;
  recoveryCodes: Array<{ code: string; usedAt: string | null }>;
}

/** Correction request as stored in the demo database (decidedBy: employee id of the deciding person). */
interface StoredCorrection extends CorrectionRequest {
  decidedBy: UUID | null;
}

/** Change history of time entries (like time_entry_revisions on the server). */
interface StoredRevision extends Omit<TimeEntryRevision, "changedByName"> {
  tenantId: UUID;
  employeeId: UUID;
  changedBy: UUID | null;
}

/** Validity period of (status, role) of one person (like employee_status_history in the database). */
interface DemoStatusPeriod extends StatusPeriod {
  employeeId: UUID;
  tenantId: UUID;
}

/** Billing status of a tenant and month; snapshot fields set when not "open" (frozen month). */
interface DemoBillingPeriod {
  tenantId: UUID;
  month: ISOMonth;
  status: BillingStatus;
  note: string | null;
  closedAt: string | null;
  snapshot: { condition: BillingCondition; plan: LicensePlan | null; unitPriceCents: number; billableCount: number; amountCents: number;
    lines: Array<{ employeeId: UUID; reason: BillableReason }> } | null;
}

interface DemoDb {
  schema: 1;
  seededAt: string;
  tenants: Tenant[];
  licenses: License[];
  employees: Employee[];
  accounts: Account[];
  entries: TimeEntry[];
  allocations: StoredAllocation[];
  statements: MonthlyStatement[];
  audit: AuditEvent[];
  supportGrants: SupportGrant[];
  /** Added with two-factor authentication; missing in older stored demo databases. */
  twoFactor?: DemoTwoFactor[];
  /** Added with correction requests (migration 0013); missing in older stored demo databases. */
  correctionRequests?: StoredCorrection[];
  /** Entry history recorded from correction requests on; older entries show their current state only. */
  revisions?: StoredRevision[];
  /** Added with the price model (2026-10-28); filled on load for older stored demo databases. */
  statusHistory?: DemoStatusPeriod[];
  defaultPriceCents?: number;
  billingPeriods?: DemoBillingPeriod[];
}

/** Demo-only extensions used by the start page, admin portal and tests. */
export interface DemoRepository extends Repository, TwoFactorApi, BillingApi, PrivacyApi {
  /**
   * Demo only: current 6-digit code of the account that is signing in
   * (second step) or signed in – so 2FA can be tried without an app.
   */
  demoTwoFactorCode(): Promise<string | null>;
  /** Discards all changes and re-seeds the demo data. */
  resetDemoData(): void;
  /** Platform-level audit (tenant / licence changes) – super_admin / support only. */
  listPlatformAudit(limit?: number): Promise<AuditEvent[]>;
  /** Support access granted by the tenant owner (time-limited). */
  getSupportGrant(tenantId: UUID): Promise<SupportGrant | null>;
  /** Owner/manager grants (hours > 0) or revokes (0) platform support access. */
  setSupportGrant(tenantId: UUID, hours: number): Promise<SupportGrant | null>;
  inviteEmployee(tenantId: UUID, input: NewEmployee): Promise<InvitedEmployee>;
  /** Demo: a new invitation of an invited employee (nothing is sent; the link is a placeholder). */
  createInvitation(employeeId: UUID, channel: InvitationChannel): Promise<InvitationInfo>;
  /** Owner: display name of the company. */
  renameTenant(tenantId: UUID, name: string): Promise<Tenant>;
  /** Platform staff: technical status (demo values). */
  getSystemOverview(): Promise<SystemOverview>;
}

/** Text for a sign-in into a tenant that is not active. */
function tenantBlockedText(tenant: Tenant | undefined): string {
  return tenant?.status === "deactivated" ? "Der Firmenzugang ist deaktiviert." : "Der Firmenzugang ist derzeit gesperrt.";
}

/** Demo invitations: valid 7 days, like the API (create_invitation). */
const INVITATION_DAYS = 7;

function demoInvitation(channel: InvitationChannel): InvitationInfo {
  const expiresAt = new Date(Date.now() + INVITATION_DAYS * 86400000).toISOString();
  if (channel === "email") return { expiresAt, delivery: "demo" };
  const token = `demo-${uuid().replace(/-/g, "")}`;
  const origin = typeof location !== "undefined" && location.origin && location.origin !== "null" ? location.origin : "https://zeit.demo.example";
  return { expiresAt, delivery: "link", link: `${origin}/einladung/#token=${token}` };
}

export interface DemoOptions {
  /** Storage key for the session – each app area keeps its own login. */
  sessionKey?: string;
  /** Reference date for seeding (tests). */
  now?: Date;
}

// ------------------------------------------------------------------ helpers

const ANONYMIZED_FINAL = "Dieser Datensatz ist anonymisiert und kann nicht mehr geändert werden.";

function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c) c.getRandomValues(bytes); else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function localISODate(d: Date): ISODate {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function monthOf(date: ISODate): ISOMonth {
  return date.slice(0, 7);
}

export function shiftMonth(month: ISOMonth, delta: number): ISOMonth {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

function requireReason(reason: string | undefined | null, what = "Bitte eine Begründung angeben."): string {
  const r = (reason ?? "").trim();
  if (r.length < 3) throw new Error(what);
  if (r.length > 500) throw new Error("Die Begründung ist zu lang (max. 500 Zeichen).");
  return r;
}

/** Deterministic PRNG for reproducible seed data. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function validateLogoDataUrl(url: string): void {
  const m = /^data:([a-z+/.-]+);base64,/.exec(url);
  if (!m) throw new Error("Das Logo muss als Bilddatei hochgeladen werden.");
  if (!ALLOWED_LOGO_TYPES.includes(m[1]!)) throw new Error("Erlaubte Formate: PNG, JPG oder WebP.");
  const bytes = Math.floor(((url.length - m[0].length) * 3) / 4);
  if (bytes > MAX_LOGO_BYTES) throw new Error(`Das Logo ist zu groß (max. ${Math.round(MAX_LOGO_BYTES / 1024)} KB).`);
}

// ------------------------------------------------------------------ seed

// New tenants (and the generic demo tenant, like db/seed.sql) get the default
// rule from core/breaks.ts; only the UWE replica keeps the strict UWE rule.
function defaultSettings(): TenantSettings {
  return {
    breakPolicy: defaultBreakPolicy(),
    workAccount: { enabled: false, model: "calendar-year", openingMinutes: 0, federalState: null, startMonth: "2026-01", approvalRequired: true },
  };
}

type Pattern = Array<[string, string, number]>;
// All patterns satisfy the strict UWE break rules (≥ 6 h → 30 min, ≥ 9 h → 45 min, gaps ≥ 15 min count),
// hence also the statutory rule of the generic tenant.
const KT_PATTERNS: Pattern[] = [
  [["06:30", "14:45", 30]],
  [["07:00", "12:30", 0]],
  [["06:45", "08:45", 0], ["12:30", "16:00", 0]],
  [["06:30", "09:00", 0], ["12:00", "16:30", 0]],
  [["07:00", "16:30", 45]],
  [["06:15", "08:30", 0], ["11:45", "13:15", 0], ["14:00", "16:45", 0]],
];
const PFLEGE_PATTERNS: Pattern[] = [
  [["06:00", "13:30", 30]],
  [["13:30", "21:00", 30]],
  [["06:00", "10:00", 0], ["17:00", "20:00", 0]],
  [["07:00", "12:00", 0]],
];

function seedDb(now: Date): DemoDb {
  const created = new Date(now.getTime() - 60 * 86400000).toISOString();
  const today = localISODate(now);
  const currentMonth = monthOf(today);
  const previousMonth = shiftMonth(currentMonth, -1);

  const ktPolicy: WorkAccountPolicy = { ...UWE_WORK_ACCOUNT_POLICY, approvalRequired: true };
  const tenants: Tenant[] = [
    {
      id: DEMO_TENANT_IDS.kt, slug: "demo-krankentransporte", name: "Demo Krankentransporte", status: "active", isDemo: true,
      branding: {
        logoUrl: "brands/uwe/uwe-logo.svg", markUrl: "brands/uwe/uwe-fluegel.svg",
        primaryColor: "#087f89", secondaryColor: "#19363c", accentColor: "#00a99e", slogan: "Verantwortung, die bewegt.",
      },
      contact: {
        legalName: "Demo Krankentransporte GmbH (fiktiv)", street: "Beispielstraße 1", postalCode: "52062", city: "Aachen",
        phone: "0241 000 000 00", whatsapp: "492410000000", email: "kontakt@demo-kt.example", website: "https://demo-kt.example",
        contactPerson: "Chef Demo",
      },
      settings: { breakPolicy: clone(UWE_BREAK_POLICY), workAccount: ktPolicy },
    },
    {
      id: DEMO_TENANT_IDS.pflege, slug: "muster-pflegedienst", name: "Muster Pflegedienst GmbH", status: "active", isDemo: true,
      branding: {
        logoUrl: "brands/muster/muster-logo.svg", markUrl: "brands/muster/muster-mark.svg",
        primaryColor: "#6b3fa0", secondaryColor: "#3b2457", accentColor: "#e0a100", slogan: "Mit Herz und Zeit.",
      },
      contact: {
        legalName: "Muster Pflegedienst GmbH (fiktiv)", street: "Musterweg 12", postalCode: "10115", city: "Berlin",
        phone: "030 000 000 00", whatsapp: "49300000000", email: "buero@muster-pflege.example", website: "https://muster-pflege.example",
        contactPerson: "Petra Leitung",
      },
      settings: {
        breakPolicy: defaultBreakPolicy(),
        workAccount: { enabled: true, model: "calendar-year", openingMinutes: 0, federalState: "BE", startMonth: "2026-01", approvalRequired: false },
      },
    },
  ];

  const licenses: License[] = [
    {
      id: "20000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_IDS.kt, plan: "pilot_free", status: "active",
      priceCents: 0, billing: "none", validFrom: "2026-09-01", validUntil: null, maxEmployees: null,
      features: ["work_account", "pdf_statements", "chef_portal"], note: "Pilotkunde – kostenlos, unbefristet, keine Zahlungsdaten.",
      employeePriceCents: null, freeOfCharge: true, conditionNote: "Pilotkunde – kostenloses Konto.", conditionValidFrom: null, conditionValidUntil: null,
    },
    {
      id: "20000000-0000-4000-8000-000000000002", tenantId: DEMO_TENANT_IDS.pflege, plan: "standard", status: "active",
      priceCents: 0, billing: "manual", validFrom: "2026-10-01", validUntil: null, maxEmployees: 25,
      features: ["pdf_statements", "chef_portal"], note: "Demo-Lizenz – Standardkunde.",
      employeePriceCents: null, freeOfCharge: false, conditionNote: null, conditionValidFrom: null, conditionValidUntil: null,
    },
  ];

  const employees: Employee[] = [];
  const accounts: Account[] = [];
  const addPerson = (id: string, tenantId: UUID, nr: string, name: string, email: string, role: TenantRole, status: Employee["status"]) => {
    employees.push({ id, tenantId, personnelNumber: nr, displayName: name, email, role, status, createdAt: created });
    accounts.push({ userId: `u-${id}`, email, password: DEMO_PASSWORD, tenantId, employeeId: id, platformRole: null });
  };
  // Demo Krankentransporte (fictional people)
  addPerson("30000000-0000-4000-8000-000000000100", DEMO_TENANT_IDS.kt, "1000", "Chef Demo", "chef@demo-kt.example", "owner", "active");
  addPerson("30000000-0000-4000-8000-000000000101", DEMO_TENANT_IDS.kt, "1001", "Anna Beispiel", "anna@demo-kt.example", "employee", "active");
  addPerson("30000000-0000-4000-8000-000000000102", DEMO_TENANT_IDS.kt, "1002", "Ben Muster", "ben@demo-kt.example", "employee", "active");
  addPerson("30000000-0000-4000-8000-000000000103", DEMO_TENANT_IDS.kt, "1003", "Carla Probe", "carla@demo-kt.example", "employee", "active");
  addPerson("30000000-0000-4000-8000-000000000104", DEMO_TENANT_IDS.kt, "1004", "Deniz Test", "deniz@demo-kt.example", "employee", "active");
  addPerson("30000000-0000-4000-8000-000000000105", DEMO_TENANT_IDS.kt, "1005", "Emil Platzhalter", "emil@demo-kt.example", "employee", "deactivated");
  addPerson("30000000-0000-4000-8000-000000000106", DEMO_TENANT_IDS.kt, "1006", "Fiona Fiktiv", "fiona@demo-kt.example", "employee", "invited");
  addPerson("30000000-0000-4000-8000-000000000107", DEMO_TENANT_IDS.kt, "1007", "Disponentin Demo", "dispo@demo-kt.example", "manager", "active");
  // Muster Pflegedienst
  addPerson("30000000-0000-4000-8000-000000000200", DEMO_TENANT_IDS.pflege, "P-01", "Petra Leitung", "leitung@muster-pflege.example", "owner", "active");
  addPerson("30000000-0000-4000-8000-000000000201", DEMO_TENANT_IDS.pflege, "P-11", "Mia Musterfrau", "mia@muster-pflege.example", "employee", "active");
  addPerson("30000000-0000-4000-8000-000000000202", DEMO_TENANT_IDS.pflege, "P-12", "Noah Normal", "noah@muster-pflege.example", "employee", "active");
  addPerson("30000000-0000-4000-8000-000000000203", DEMO_TENANT_IDS.pflege, "P-13", "Olga Ohnename", "olga@muster-pflege.example", "employee", "active");
  // Platform operators
  accounts.push({ userId: "u-admin", email: "admin@plattform.example", password: DEMO_PASSWORD, tenantId: null, employeeId: null, platformRole: "super_admin" });
  accounts.push({ userId: "u-support", email: "support@plattform.example", password: DEMO_PASSWORD, tenantId: null, employeeId: null, platformRole: "support" });

  // ---- status history (billing): everybody since `created`; Emil left on the 21st of the previous month.
  const statusHistory: DemoStatusPeriod[] = [];
  const emilLeft = new Date(`${previousMonth}-21T18:00:00`).toISOString();
  for (const e of employees) {
    if (e.id === "30000000-0000-4000-8000-000000000105") {
      statusHistory.push({ employeeId: e.id, tenantId: e.tenantId, status: "active", role: e.role, from: created, to: emilLeft });
      statusHistory.push({ employeeId: e.id, tenantId: e.tenantId, status: "deactivated", role: e.role, from: emilLeft, to: null });
    } else {
      statusHistory.push({ employeeId: e.id, tenantId: e.tenantId, status: e.status, role: e.role, from: created, to: null });
    }
  }

  // ---- time entries: previous month complete, current month up to today
  const entries: TimeEntry[] = [];
  const workers = employees.filter((e) => e.role === "employee" && e.status !== "invited");
  workers.forEach((emp, index) => {
    const rnd = mulberry32(1000 + index * 7919);
    const patterns = emp.tenantId === DEMO_TENANT_IDS.kt ? KT_PATTERNS : PFLEGE_PATTERNS;
    let day = `${previousMonth}-01`;
    const lastDay = emp.status === "deactivated" ? addDays(`${previousMonth}-01`, 20) : today;
    for (; day <= lastDay; day = addDays(day, 1)) {
      const dow = new Date(day + "T12:00:00Z").getUTCDay();
      const isToday = day === today;
      if (dow === 0) continue;
      if (dow === 6 && rnd() > 0.2) continue;
      if (!isToday && rnd() < 0.12) continue; // free days
      if (isToday && index > 1) continue; // only some people already worked today
      const pattern = patterns[Math.floor(rnd() * patterns.length)]!;
      for (const [start, end, pause] of pattern) {
        if (isToday && parseClock(start) > now.getHours() * 60 + now.getMinutes() && pattern.length > 1) break;
        const ts = new Date(`${day}T${end}:00`).toISOString();
        entries.push({
          id: uuid(), tenantId: emp.tenantId, employeeId: emp.id, date: day, start, end, pauseMinutes: pause,
          note: rnd() < 0.15 ? (emp.tenantId === DEMO_TENANT_IDS.kt ? "Schülertour" : "Frühdienst Tour 2") : "",
          version: 1, createdAt: ts, updatedAt: ts, deletedAt: null, source: "app",
        });
      }
    }
  });

  // ---- allocations, statements and audit for the previous month
  const allocations: StoredAllocation[] = [];
  const statements: MonthlyStatement[] = [];
  const audit: AuditEvent[] = [];
  const ts = new Date(now.getTime() - 3 * 86400000).toISOString();
  const tenantOf = (id: UUID) => tenants.find((t) => t.id === id)!;
  const plan: Record<string, { alloc: number; allocStatus: MonthAllocation["status"]; statement: MonthlyStatement["status"] | null; note?: string }> = {
    "30000000-0000-4000-8000-000000000101": { alloc: 20 * 60, allocStatus: "approved", statement: "approved" },
    "30000000-0000-4000-8000-000000000102": { alloc: 10 * 60, allocStatus: "proposed", statement: "submitted" },
    "30000000-0000-4000-8000-000000000103": { alloc: 0, allocStatus: "approved", statement: "returned", note: "Bitte den 12. prüfen – Einsatzende fehlt laut Fahrtenbuch." },
    "30000000-0000-4000-8000-000000000201": { alloc: 8 * 60, allocStatus: "approved", statement: "submitted" },
  };
  for (const emp of workers) {
    const p = plan[emp.id];
    if (!p) continue;
    const tenant = tenantOf(emp.tenantId);
    const mine = entries.filter((e) => e.employeeId === emp.id);
    if (p.alloc > 0) {
      let minutes = p.alloc;
      try {
        const eligible = summarizeMonth({ entries: mine, allocations: [], month: previousMonth, policy: tenant.settings.workAccount }).eligibleMinutes;
        minutes = Math.min(minutes, Math.floor(eligible / 15) * 15);
      } catch { minutes = 0; }
      if (minutes > 0) {
        allocations.push({ employeeId: emp.id, tenantId: emp.tenantId, month: previousMonth, minutes, status: p.allocStatus, reviewNote: null, updatedAt: ts });
      }
    }
    if (p.statement) {
      const mineAlloc = allocations.filter((a) => a.employeeId === emp.id);
      const s = safeSummary(mine, mineAlloc, previousMonth, tenant.settings.workAccount);
      statements.push({
        id: uuid(), tenantId: emp.tenantId, employeeId: emp.id, month: previousMonth, status: p.statement,
        submittedAt: ts, reviewedAt: p.statement === "submitted" ? null : ts,
        reviewedBy: p.statement === "submitted" ? null : (emp.tenantId === DEMO_TENANT_IDS.kt ? "30000000-0000-4000-8000-000000000100" : "30000000-0000-4000-8000-000000000200"),
        reviewNote: p.note ?? null, workedMinutes: s.worked, allocatedMinutes: s.allocated, billingMinutes: s.billing,
      });
    }
  }
  // One documented manager correction (original values kept in the audit log).
  const corrected = entries.find((e) => e.employeeId === "30000000-0000-4000-8000-000000000102" && e.date.startsWith(previousMonth) && e.pauseMinutes === 30);
  if (corrected) {
    const before = clone(corrected);
    corrected.end = corrected.end === "14:45" ? "14:30" : corrected.end;
    corrected.version = 2;
    corrected.source = "correction";
    audit.push({
      id: uuid(), tenantId: DEMO_TENANT_IDS.kt, actorId: "30000000-0000-4000-8000-000000000100", action: "time_entry.corrected",
      entity: "time_entry", entityId: corrected.id, before, after: clone(corrected), reason: "Einsatzende laut Fahrtenbuch korrigiert", createdAt: ts,
    });
  }
  audit.push({
    id: uuid(), tenantId: DEMO_TENANT_IDS.kt, actorId: "30000000-0000-4000-8000-000000000100", action: "employee.deactivated",
    entity: "employee", entityId: "30000000-0000-4000-8000-000000000105", before: { status: "active" }, after: { status: "deactivated" },
    reason: "Beschäftigung beendet (Demo)", createdAt: emilLeft,
  });
  audit.push({
    id: uuid(), tenantId: DEMO_TENANT_IDS.kt, actorId: "u-admin", action: "license.created", entity: "license",
    entityId: licenses[0]!.id, before: null, after: clone(licenses[0]), reason: "Pilotkunde angelegt", createdAt: created,
  });
  audit.push({
    id: uuid(), tenantId: DEMO_TENANT_IDS.pflege, actorId: "u-admin", action: "license.created", entity: "license",
    entityId: licenses[1]!.id, before: null, after: clone(licenses[1]), reason: "Demo-Mandant angelegt", createdAt: created,
  });

  return {
    schema: 1, seededAt: now.toISOString(), tenants, licenses, employees, accounts, entries, allocations, statements, audit, supportGrants: [],
    statusHistory, defaultPriceCents: DEFAULT_EMPLOYEE_PRICE_CENTS, billingPeriods: [],
  };
}

function safeSummary(entries: TimeEntry[], allocations: MonthAllocation[], month: ISOMonth, policy: WorkAccountPolicy) {
  const s = summarizeMonth({ entries: activeShifts(entries), allocations, month, policy });
  return { worked: s.workedMinutes, allocated: s.allocatedMinutes, billing: s.billingMinutes };
}

// ------------------------------------------------------------------ repository

export function createDemoRepository(storage: KeyValueStorage = localStorage, options: DemoOptions = {}): DemoRepository {
  const sessionKey = options.sessionKey ?? "stundenwerk_demo_session";
  const seedNow = () => options.now ?? new Date();

  function load(): DemoDb {
    const raw = storage.getItem(DEMO_DB_KEY);
    if (raw) {
      try {
        const db = JSON.parse(raw) as DemoDb;
        if (db && db.schema === 1) return upgrade(db);
      } catch { /* re-seed below */ }
    }
    const db = seedDb(seedNow());
    save(db);
    return db;
  }
  /** Older stored demo databases (before the price model): add history, price and billing status. */
  function upgrade(db: DemoDb): DemoDb {
    db.statusHistory ??= db.employees.map((e) => ({ employeeId: e.id, tenantId: e.tenantId, status: e.status, role: e.role, from: e.createdAt, to: null }));
    db.defaultPriceCents ??= DEFAULT_EMPLOYEE_PRICE_CENTS;
    db.billingPeriods ??= [];
    for (const l of db.licenses) {
      l.employeePriceCents ??= null;
      l.freeOfCharge ??= l.plan === "pilot_free";
      l.conditionNote ??= null;
      l.conditionValidFrom ??= null;
      l.conditionValidUntil ??= null;
    }
    return db;
  }
  function save(db: DemoDb) {
    storage.setItem(DEMO_DB_KEY, JSON.stringify(db));
  }
  /** Runs a mutation on a fresh copy of the DB and persists it atomically. */
  async function tx<T>(fn: (db: DemoDb, s: Session) => T): Promise<T> {
    const db = load();
    const s = sessionFrom(db);
    const result = fn(db, s);
    save(db);
    return clone(result);
  }
  async function read<T>(fn: (db: DemoDb, s: Session) => T): Promise<T> {
    const db = load();
    return clone(fn(db, sessionFrom(db)));
  }

  // ---- two-factor helpers
  const pendingKey = `${sessionKey}_2fa_pending`;
  const factorOf = (db: DemoDb, userId: UUID) => (db.twoFactor ?? []).find((f) => f.userId === userId) ?? null;
  const enrolled = (db: DemoDb, userId: UUID) => !!factorOf(db, userId)?.enrolledAt;
  /** Demo: only the owner's requirement for managers is enforced (not the platform rule). */
  function twoFactorRequiredBy(db: DemoDb, acc: Account): "tenant" | null {
    if (!acc.tenantId || !acc.employeeId) return null;
    const emp = db.employees.find((e) => e.id === acc.employeeId);
    const tenant = db.tenants.find((t) => t.id === acc.tenantId);
    return emp && tenant && emp.status === "active" && (emp.role === "manager" || emp.role === "owner")
      && tenant.status === "active" && tenant.requireTwoFactorForManagers ? "tenant" : null;
  }
  function randomBytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
    return b;
  }
  function newRecoveryCodes(): DemoTwoFactor["recoveryCodes"] {
    const list: DemoTwoFactor["recoveryCodes"] = [];
    while (list.length < RECOVERY_CODE_COUNT) {
      const code = generateRecoveryCode(randomBytes);
      if (!list.some((x) => x.code === code)) list.push({ code, usedAt: null });
    }
    return list;
  }
  /** Checks (and consumes) a code or recovery code. */
  function checkProof(db: DemoDb, userId: UUID, proof: TwoFactorProof): { ok: boolean; remaining?: number; kind: "code" | "recovery" } {
    const f = factorOf(db, userId);
    if (!f?.enrolledAt) return { ok: false, kind: "code" };
    if ("code" in proof) {
      const code = normalizeTotpCode(proof.code);
      const step = code ? matchTotpStep(base32Decode(f.secret), code, Date.now()) : null;
      if (step === null || step <= (f.lastUsedStep ?? -1)) return { ok: false, kind: "code" };
      f.lastUsedStep = step;
      return { ok: true, kind: "code" };
    }
    const n = normalizeRecoveryCode(proof.recoveryCode);
    const hit = n ? f.recoveryCodes.find((r) => !r.usedAt && r.code.replace(/-/g, "") === n) : undefined;
    if (!hit) return { ok: false, kind: "recovery" };
    hit.usedAt = new Date().toISOString();
    return { ok: true, kind: "recovery", remaining: f.recoveryCodes.filter((r) => !r.usedAt).length };
  }
  function auditTwoFactor(db: DemoDb, acc: Account, action: string, after: unknown) {
    addAudit(db, accountSession(db, acc), { tenantId: acc.tenantId, action, entity: "user", entityId: acc.userId, before: null, after, reason: null });
  }

  function accountSession(db: DemoDb, acc: Account): Session {
    const emp = acc.employeeId ? db.employees.find((e) => e.id === acc.employeeId) : null;
    const s: Session = {
      userId: acc.userId, email: acc.email, tenantId: acc.tenantId, employeeId: acc.employeeId,
      role: emp?.role ?? null, platformRole: acc.platformRole,
    };
    if (twoFactorRequiredBy(db, acc) && !enrolled(db, acc.userId)) s.twoFactorSetupRequired = true;
    return s;
  }

  /** allowSetup: the 2FA functions stay reachable while a mandatory setup is pending. */
  function sessionFrom(db: DemoDb, allowSetup = false): Session {
    const userId = storage.getItem(sessionKey);
    const acc = userId ? db.accounts.find((a) => a.userId === userId) : null;
    if (!acc) throw new AccessDeniedError("Bitte melde dich an.");
    const s = accountSession(db, acc);
    if (s.twoFactorSetupRequired && !allowSetup) {
      throw new AccessDeniedError("Für dein Konto ist die Zwei-Faktor-Anmeldung vorgeschrieben. Bitte richte sie zuerst ein.");
    }
    if (s.tenantId) {
      const tenant = db.tenants.find((t) => t.id === s.tenantId);
      const emp = db.employees.find((e) => e.id === s.employeeId);
      if (!tenant || tenant.status !== "active") throw new AccessDeniedError(tenantBlockedText(tenant));
      if (!emp || emp.status === "deactivated") throw new AccessDeniedError("Dein Zugang wurde deaktiviert.");
      if (emp.status === "locked") throw new AccessDeniedError("Dein Zugang ist vorübergehend gesperrt.");
    }
    return s;
  }

  // ---- guards
  const isManager = (s: Session) => s.role === "manager" || s.role === "owner";
  function hasSupportGrant(db: DemoDb, tenantId: UUID): boolean {
    const g = db.supportGrants.find((x) => x.tenantId === tenantId);
    return !!g && g.grantedUntil > new Date().toISOString();
  }
  function tenantById(db: DemoDb, id: UUID): Tenant {
    const t = db.tenants.find((x) => x.id === id);
    if (!t) throw new AccessDeniedError();
    return t;
  }
  function assertMember(s: Session, tenantId: UUID) {
    if (s.tenantId !== tenantId) throw new AccessDeniedError();
  }
  function assertManager(s: Session, tenantId: UUID) {
    assertMember(s, tenantId);
    if (!isManager(s)) throw new AccessDeniedError("Diese Funktion ist nur für Vorgesetzte freigegeben.");
  }
  /** Company profile and settings: owner only, like the API (RLS tenants_update, migration 0011; QA B3). */
  function assertOwner(s: Session, tenantId: UUID, message: string) {
    assertMember(s, tenantId);
    if (s.role !== "owner") throw new AccessDeniedError(message);
  }
  /** Personal data: own record (employee), whole tenant (manager) or platform support with active grant (read only). */
  function assertEmployeeRead(db: DemoDb, s: Session, employeeId: UUID): Employee {
    const emp = db.employees.find((e) => e.id === employeeId);
    if (!emp) throw new AccessDeniedError();
    if (s.platformRole && !s.tenantId) {
      if (!hasSupportGrant(db, emp.tenantId)) throw new AccessDeniedError("Kein Supportzugriff: Der Mandant hat keine Freigabe erteilt.");
      return emp;
    }
    if (s.tenantId !== emp.tenantId) throw new AccessDeniedError();
    if (!isManager(s) && s.employeeId !== employeeId) throw new AccessDeniedError();
    return emp;
  }
  function assertEmployeeWrite(db: DemoDb, s: Session, employeeId: UUID): Employee {
    if (s.platformRole && !s.tenantId) throw new AccessDeniedError("Plattform-Konten dürfen keine Arbeitszeiten ändern.");
    return assertEmployeeRead(db, s, employeeId);
  }
  function assertPlatform(s: Session, write = false) {
    if (s.platformRole !== "super_admin" && !(s.platformRole === "support" && !write)) {
      throw new AccessDeniedError("Nur für Plattform-Administratoren.");
    }
  }

  function addAudit(db: DemoDb, s: Session | null, e: Omit<AuditEvent, "id" | "createdAt" | "actorId">) {
    db.audit.push({ ...e, id: uuid(), actorId: s?.employeeId ?? s?.userId ?? null, createdAt: new Date().toISOString() });
  }

  function statementOf(db: DemoDb, employeeId: UUID, month: ISOMonth) {
    return db.statements.find((x) => x.employeeId === employeeId && x.month === month) ?? null;
  }

  const valuesOf = (e: Pick<TimeEntry, "date" | "start" | "end" | "pauseMinutes" | "note">): EntryValues =>
    ({ date: e.date, start: e.start, end: e.end, pauseMinutes: e.pauseMinutes, note: e.note });

  /** Like the server trigger time_entries_revision: one snapshot per write. */
  function recordRevision(db: DemoDb, s: Session, entry: TimeEntry, operation: TimeEntryRevision["operation"], isCorrection: boolean, reason: string | null) {
    (db.revisions ??= []).push({
      entryId: entry.id, tenantId: entry.tenantId, employeeId: entry.employeeId, version: entry.version, operation, isCorrection,
      changedAt: new Date().toISOString(), changedBy: s.employeeId, reason, values: valuesOf(entry), deleted: !!entry.deletedAt, source: entry.source,
    });
  }

  /** Name of a person for the caller: leadership sees everybody, employees only themselves (like RLS on employees). */
  function visibleName(db: DemoDb, s: Session, employeeId: UUID | null): string | null {
    if (!employeeId) return null;
    if (!isManager(s) && s.employeeId !== employeeId) return null;
    return db.employees.find((e) => e.id === employeeId)?.displayName ?? null;
  }

  /** statement_correction_flags: corrections of an approved month after the approval (figures stay unchanged, N1). */
  function withCorrectionFlag(db: DemoDb, st: MonthlyStatement): MonthlyStatement {
    if (st.status !== "approved" || !st.reviewedAt) return { ...st, correctedAfterApproval: null };
    const revs = (db.revisions ?? []).filter((r) => r.employeeId === st.employeeId);
    const hits = revs.filter((r) => r.isCorrection && r.changedAt > st.reviewedAt! && (
      r.values.date.startsWith(st.month)
      || revs.some((p) => p.entryId === r.entryId && p.version === r.version - 1 && p.values.date.startsWith(st.month))));
    if (!hits.length) return { ...st, correctedAfterApproval: null };
    return { ...st, correctedAfterApproval: { count: hits.length, lastAt: hits.map((h) => h.changedAt).sort().at(-1)! } };
  }

  function publicCorrection(db: DemoDb, s: Session, r: StoredCorrection): CorrectionRequest {
    const { decidedBy, ...rest } = r;
    return { ...rest, decidedByName: visibleName(db, s, decidedBy) };
  }

  /** Employees cannot change months that are submitted or approved. */
  function assertMonthOpen(db: DemoDb, s: Session, employeeId: UUID, month: ISOMonth) {
    if (isManager(s) && s.employeeId !== employeeId) return; // managers correct with reason
    const st = statementOf(db, employeeId, month);
    if (st && (st.status === "submitted" || st.status === "approved")) {
      throw new Error(st.status === "approved"
        ? "Dieser Monat ist bereits freigegeben und kann nicht mehr geändert werden. Bitte wende dich an deine Vorgesetzten."
        : "Der Monatsnachweis ist eingereicht. Änderungen sind erst nach Rückgabe möglich.");
    }
  }

  function validateEntry(db: DemoDb, tenant: Tenant, employeeId: UUID, candidate: { id: string; date: string; start: string; end: string; pauseMinutes: number; note: string }) {
    if (!isRealDate(candidate.date)) throw new Error("Bitte ein gültiges Datum wählen.");
    if (!Number.isFinite(parseClock(candidate.start)) || !Number.isFinite(parseClock(candidate.end))) throw new Error("Bitte Arbeitsbeginn und Ende im Format HH:MM eintragen.");
    if (typeof candidate.note !== "string" || candidate.note.length > 200) throw new Error("Die Bemerkung darf höchstens 200 Zeichen lang sein.");
    const shift = { id: candidate.id, date: candidate.date, start: candidate.start, end: candidate.end, pause: candidate.pauseMinutes };
    if (!isValidEntry(shift)) throw new Error("Bitte Arbeitsbeginn, Ende und Pause korrigieren.");
    const others = activeShifts(db.entries.filter((e) => e.employeeId === employeeId && e.id !== candidate.id && !e.deletedAt));
    const overlap = findOverlapAcrossDays(shift, others);
    if (overlap) throw new Error(`Der Einsatz überschneidet sich mit ${overlap.start}–${overlap.end} Uhr. Bitte die Zeiten korrigieren.`);
    const policy = tenant.settings.breakPolicy;
    const problem = issueForDay(evaluateDay([...others, shift], candidate.date, policy), policy);
    if (problem) throw new Error(problem);
  }

  function overview(db: DemoDb, t: Tenant): TenantOverview {
    const emps = db.employees.filter((e) => e.tenantId === t.id);
    return {
      tenant: t,
      license: db.licenses.find((l) => l.tenantId === t.id) ?? null,
      employeeCount: emps.filter((e) => e.status !== "deactivated").length,
      activeEmployeeCount: emps.filter((e) => e.status === "active").length,
    };
  }

  // ---- billing (same rules as private.billing_lines / billing_condition in the database)
  /** Closes the open period and opens a new one when status or role changed (trigger in the database). */
  function recordStatus(db: DemoDb, emp: Employee) {
    const hist = (db.statusHistory ??= []);
    const open = hist.find((h) => h.employeeId === emp.id && h.to === null);
    if (open && open.status === emp.status && open.role === emp.role) return;
    const now = new Date().toISOString();
    if (open) {
      if (open.from >= now) hist.splice(hist.indexOf(open), 1);
      else open.to = now;
    }
    hist.push({ employeeId: emp.id, tenantId: emp.tenantId, status: emp.status, role: emp.role, from: now, to: null });
  }
  function billingLines(db: DemoDb, tenantId: UUID, month: ISOMonth): Array<{ employeeId: UUID; reason: BillableReason }> {
    const out: Array<{ employeeId: UUID; reason: BillableReason }> = [];
    for (const e of db.employees.filter((x) => x.tenantId === tenantId)) {
      const periods = (db.statusHistory ?? []).filter((h) => h.employeeId === e.id);
      const dates = db.entries.filter((t) => t.employeeId === e.id && !t.deletedAt).map((t) => t.date);
      const reason = billableReason(periods, dates, month);
      if (reason) out.push({ employeeId: e.id, reason });
    }
    return out;
  }
  function billingPeriod(db: DemoDb, tenantId: UUID, month: ISOMonth): DemoBillingPeriod | null {
    return (db.billingPeriods ?? []).find((p) => p.tenantId === tenantId && p.month === month) ?? null;
  }
  function currentBillingMonth(): ISOMonth {
    return berlinMonthOf(Date.now());
  }
  function assertBillingMonth(month: ISOMonth) {
    if (!isValidMonth(month)) throw new Error("Bitte einen gültigen Monat (JJJJ-MM) angeben.");
    if (month > currentBillingMonth()) throw new Error("Für zukünftige Monate gibt es noch keine Abrechnung.");
  }
  function firstBillingMonth(db: DemoDb, tenantId: UUID): ISOMonth {
    const froms = (db.statusHistory ?? []).filter((h) => h.tenantId === tenantId).map((h) => h.from).sort();
    return froms[0] ? berlinMonthOf(froms[0]) : currentBillingMonth();
  }
  /** Numbers of one month (snapshot when frozen, otherwise live) plus the lines. */
  function billingMonth(db: DemoDb, tenantId: UUID, month: ISOMonth): BillingMonthSummary & { plan: LicensePlan | null; note: string | null; closedAt: string | null; lines: Array<{ employeeId: UUID; reason: BillableReason }> } {
    const p = billingPeriod(db, tenantId, month);
    if (p?.snapshot && p.status !== "open") {
      const { lines, ...numbers } = p.snapshot;
      return { month, status: p.status, final: true, ...numbers, note: p.note, closedAt: p.closedAt, lines };
    }
    const lic = db.licenses.find((l) => l.tenantId === tenantId) ?? null;
    const { condition, unitPriceCents } = billingConditionFor(lic, db.defaultPriceCents ?? DEFAULT_EMPLOYEE_PRICE_CENTS, month);
    const lines = billingLines(db, tenantId, month);
    return {
      month, status: "open", final: false, condition, plan: lic?.plan ?? null, unitPriceCents,
      billableCount: lines.length, amountCents: billingAmount(lines.length, unitPriceCents), note: p?.note ?? null, closedAt: null, lines,
    };
  }
  const summaryOf = (m: BillingMonthSummary): BillingMonthSummary => ({
    month: m.month, status: m.status, final: m.final, condition: m.condition, unitPriceCents: m.unitPriceCents,
    billableCount: m.billableCount, amountCents: m.amountCents,
  });

  // ---- data protection (like migration 0016)
  function exportPerson(e: Employee): ExportPerson {
    return { id: e.id, personnelNumber: e.personnelNumber, displayName: e.displayName, email: e.email, role: e.role,
      status: e.status, createdAt: e.createdAt, anonymizedAt: e.anonymizedAt ?? null };
  }
  function exportEntry(t: TimeEntry): ExportTimeEntry {
    return { id: t.id, employeeId: t.employeeId, date: t.date, start: t.start, end: t.end, pauseMinutes: t.pauseMinutes,
      durationMinutes: grossMinutes({ start: t.start, end: t.end }), note: t.note, source: t.source, version: t.version,
      createdAt: t.createdAt, updatedAt: t.updatedAt, deletedAt: t.deletedAt };
  }
  function employeeAudit(db: DemoDb, e: Employee): AuditEvent[] {
    const ids = new Set([e.id, ...(db.correctionRequests ?? []).filter((r) => r.employeeId === e.id).map((r) => r.id)]);
    const has = (v: unknown) => !!v && typeof v === "object" && (v as { employeeId?: unknown }).employeeId === e.id;
    return db.audit.filter((a) => a.tenantId === e.tenantId
      && ((a.entityId !== null && (ids.has(a.entityId) || a.entityId.startsWith(`${e.id}/`))) || has(a.before) || has(a.after)));
  }
  function employeeRecords(db: DemoDb, e: Employee): ExportRecords {
    const nameOf = (id: UUID | null) => (id ? db.employees.find((x) => x.id === id && x.tenantId === e.tenantId)?.displayName ?? null : null);
    return {
      statusHistory: (db.statusHistory ?? []).filter((h) => h.employeeId === e.id)
        .map((h) => ({ status: h.status, role: h.role, validFrom: h.from, validTo: h.to })),
      timeEntries: db.entries.filter((t) => t.employeeId === e.id)
        .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id)).map(exportEntry),
      revisions: (db.revisions ?? []).filter((r) => r.employeeId === e.id).map((r) => ({
        entryId: r.entryId, version: r.version, operation: r.operation, isCorrection: r.isCorrection, changedAt: r.changedAt,
        changedBy: r.changedBy, changedByName: nameOf(r.changedBy), reason: r.reason, snapshot: { ...r.values, deleted: r.deleted, source: r.source },
      })),
      allocations: db.allocations.filter((a) => a.employeeId === e.id).sort((a, b) => a.month.localeCompare(b.month))
        .map((a) => ({ month: a.month, minutes: a.minutes, status: a.status, reviewedAt: null, reviewNote: a.reviewNote })),
      statements: db.statements.filter((x) => x.employeeId === e.id).sort((a, b) => a.month.localeCompare(b.month))
        .map((x) => ({ month: x.month, status: x.status, submittedAt: x.submittedAt, reviewedAt: x.reviewedAt, reviewNote: x.reviewNote,
          workedMinutes: x.workedMinutes, allocatedMinutes: x.allocatedMinutes, billingMinutes: x.billingMinutes })),
      correctionRequests: (db.correctionRequests ?? []).filter((r) => r.employeeId === e.id).map((r) => ({
        id: r.id, kind: r.kind, entryId: r.entryId, before: r.before, proposed: r.proposed, reason: r.reason, status: r.status,
        createdAt: r.createdAt, decidedAt: r.decidedAt, decisionNote: r.decisionNote,
      })),
      invitations: [],
      billingMonths: [],
    };
  }
  const REDACT_KEYS = new Set(["displayName", "display_name", "email", "personnelNumber", "personnel_number", "note", "reason", "reviewNote", "decisionNote"]);
  function redact(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(redact);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REDACT_KEYS.has(k) && typeof x === "string" && x !== "" ? "[anonymisiert]" : redact(x)]));
    }
    return v;
  }

  const repo: DemoRepository = {
    // ------------------------------------------------ auth
    async signIn(email, password) {
      const db = load();
      const acc = db.accounts.find((a) => a.email === normEmail(email));
      if (!acc || acc.password !== password) throw new Error("E-Mail-Adresse oder Passwort ist falsch.");
      if (acc.tenantId) {
        const tenant = db.tenants.find((t) => t.id === acc.tenantId);
        const emp = db.employees.find((e) => e.id === acc.employeeId);
        if (!tenant || tenant.status !== "active") throw new AccessDeniedError(`${tenantBlockedText(tenant)} Bitte wende dich an deinen Arbeitgeber.`);
        if (!emp || emp.status === "deactivated") throw new AccessDeniedError("Dein Zugang wurde deaktiviert. Bitte wende dich an deinen Arbeitgeber.");
        if (emp.status === "locked") throw new AccessDeniedError("Dein Zugang ist vorübergehend gesperrt. Bitte wende dich an deinen Arbeitgeber.");
        if (emp.status === "invited") {
          emp.status = "active";
          recordStatus(db, emp);
          addAudit(db, accountSession(db, acc), { tenantId: emp.tenantId, action: "employee.activated_by_login", entity: "employee", entityId: emp.id, before: { status: "invited" }, after: { status: "active" }, reason: null });
          save(db);
        }
      }
      if (enrolled(db, acc.userId)) {
        storage.removeItem(sessionKey);
        storage.setItem(pendingKey, JSON.stringify({ userId: acc.userId, expiresAt: Date.now() + 5 * 60_000, attempts: 0 }));
        throw new TwoFactorRequiredError();
      }
      storage.setItem(sessionKey, acc.userId);
      return accountSession(db, acc);
    },
    async verifyTwoFactor(proof) {
      let pending: { userId: string; expiresAt: number; attempts: number } | null = null;
      try { pending = JSON.parse(storage.getItem(pendingKey) ?? "null"); } catch { pending = null; }
      if (!pending || pending.expiresAt < Date.now() || pending.attempts >= 5) {
        storage.removeItem(pendingKey);
        throw new AccessDeniedError("Die Anmeldung ist abgelaufen. Bitte melde dich erneut mit E-Mail-Adresse und Passwort an.");
      }
      pending.attempts++;
      storage.setItem(pendingKey, JSON.stringify(pending));
      const db = load();
      const acc = db.accounts.find((a) => a.userId === pending!.userId);
      if (!acc) throw new AccessDeniedError("Bitte melde dich an.");
      const r = checkProof(db, acc.userId, proof);
      if (!r.ok) {
        throw new Error(r.kind === "recovery"
          ? "Der Wiederherstellungscode ist ungültig oder wurde bereits verwendet."
          : "Der Code ist ungültig oder abgelaufen. Bitte den aktuellen Code aus der Authenticator-App eingeben.");
      }
      if (r.kind === "recovery") auditTwoFactor(db, acc, "two_factor.recovery_code_used", { remaining: r.remaining });
      save(db);
      storage.removeItem(pendingKey);
      storage.setItem(sessionKey, acc.userId);
      const s = accountSession(db, acc);
      return r.remaining !== undefined ? { ...s, recoveryCodesRemaining: r.remaining } : s;
    },
    async demoTwoFactorCode() {
      const db = load();
      let userId = storage.getItem(sessionKey);
      try { userId = (JSON.parse(storage.getItem(pendingKey) ?? "null") as { userId?: string } | null)?.userId ?? userId; } catch { /* ignore */ }
      const f = userId ? factorOf(db, userId) : null;
      if (!f) return null;
      // The next code that is not yet used (replay protection), within the ±1 step window.
      const now = timeStep(Date.now());
      const step = Math.max(now, (f.lastUsedStep ?? -1) + 1);
      return step <= now + 1 ? hotp(base32Decode(f.secret), step) : null;
    },
    async getTwoFactorStatus() {
      const db = load();
      const s = sessionFrom(db, true);
      const acc = db.accounts.find((a) => a.userId === s.userId)!;
      const f = factorOf(db, s.userId);
      const requiredBy = twoFactorRequiredBy(db, acc);
      return {
        enabled: !!f?.enrolledAt, enrolledAt: f?.enrolledAt ?? null, pending: !!f && !f.enrolledAt,
        required: requiredBy !== null, requiredBy, recoveryCodesRemaining: f?.enrolledAt ? f.recoveryCodes.filter((r) => !r.usedAt).length : 0,
      };
    },
    async startTwoFactorSetup() {
      const db = load();
      const s = sessionFrom(db, true);
      db.twoFactor ??= [];
      const existing = factorOf(db, s.userId);
      if (existing?.enrolledAt) throw new Error("Die Zwei-Faktor-Anmeldung ist bereits eingerichtet.");
      const secret = base32Encode(randomBytes(TOTP_SECRET_BYTES));
      db.twoFactor = db.twoFactor.filter((f) => f.userId !== s.userId);
      db.twoFactor.push({ userId: s.userId, secret, createdAt: new Date().toISOString(), enrolledAt: null, lastUsedStep: null, recoveryCodes: [] });
      save(db);
      const issuer = "Stundenwerk Demo";
      return { secret, otpauthUri: otpauthUri({ issuer, account: s.email, secret }), issuer, account: s.email };
    },
    async confirmTwoFactorSetup(code) {
      const db = load();
      const s = sessionFrom(db, true);
      const f = factorOf(db, s.userId);
      if (!f || f.enrolledAt) throw new Error("Bitte die Einrichtung neu starten.");
      const c = normalizeTotpCode(code);
      const step = c ? matchTotpStep(base32Decode(f.secret), c, Date.now()) : null;
      if (step === null) throw new Error("Der Code stimmt nicht. Bitte prüfe die Uhrzeit des Smartphones und gib den aktuellen Code ein.");
      f.enrolledAt = new Date().toISOString();
      f.lastUsedStep = step;
      f.recoveryCodes = newRecoveryCodes();
      auditTwoFactor(db, db.accounts.find((a) => a.userId === s.userId)!, "two_factor.enabled", { enrolledAt: f.enrolledAt });
      save(db);
      return { recoveryCodes: f.recoveryCodes.map((r) => r.code) };
    },
    async disableTwoFactor(password, proof) {
      const db = load();
      const s = sessionFrom(db, true);
      const acc = db.accounts.find((a) => a.userId === s.userId)!;
      if (!enrolled(db, s.userId)) throw new Error("Die Zwei-Faktor-Anmeldung ist nicht eingerichtet.");
      if (acc.password !== password || !checkProof(db, s.userId, proof).ok) throw new Error("Passwort oder Code ist falsch.");
      db.twoFactor = (db.twoFactor ?? []).filter((f) => f.userId !== s.userId);
      auditTwoFactor(db, acc, "two_factor.disabled", null);
      save(db);
      return { setupRequired: twoFactorRequiredBy(db, acc) !== null };
    },
    async regenerateRecoveryCodes(password, proof) {
      const db = load();
      const s = sessionFrom(db, true);
      const acc = db.accounts.find((a) => a.userId === s.userId)!;
      const f = factorOf(db, s.userId);
      if (!f?.enrolledAt) throw new Error("Die Zwei-Faktor-Anmeldung ist nicht eingerichtet.");
      if (acc.password !== password || !checkProof(db, s.userId, proof).ok) throw new Error("Passwort oder Code ist falsch.");
      f.recoveryCodes = newRecoveryCodes();
      auditTwoFactor(db, acc, "two_factor.recovery_codes_created", { count: f.recoveryCodes.length });
      save(db);
      return { recoveryCodes: f.recoveryCodes.map((r) => r.code) };
    },
    async setTwoFactorRequirement(tenantId, required) {
      return tx((db, s) => {
        assertManager(s, tenantId);
        if (s.role !== "owner") throw new AccessDeniedError("Die Zwei-Faktor-Pflicht kann nur der Inhaber ändern.");
        if (required && !enrolled(db, s.userId)) throw new Error("Bitte richte zuerst für dein eigenes Konto die Zwei-Faktor-Anmeldung ein.");
        const t = tenantById(db, tenantId);
        const before = { requireTwoFactorForManagers: !!t.requireTwoFactorForManagers };
        t.requireTwoFactorForManagers = required;
        addAudit(db, s, { tenantId, action: "tenant.two_factor_policy_updated", entity: "tenant", entityId: tenantId, before, after: { requireTwoFactorForManagers: required }, reason: null });
        return t;
      });
    },
    async signOut() {
      storage.removeItem(sessionKey);
      storage.removeItem(pendingKey);
    },
    async currentSession() {
      try {
        return sessionFrom(load(), true);
      } catch {
        return null;
      }
    },
    async requestPasswordReset(email) {
      // Same answer for known and unknown addresses (no account enumeration). Demo: nothing is sent.
      if (!/^\S+@\S+\.\S+$/.test(email.trim())) throw new Error("Bitte eine gültige E-Mail-Adresse eingeben.");
    },

    // ------------------------------------------------ tenant
    async getTenant(tenantId) {
      return read((db, s) => {
        if (!(s.platformRole && !s.tenantId)) assertMember(s, tenantId);
        return tenantById(db, tenantId);
      });
    },
    async updateBranding(tenantId, branding: Partial<Branding>) {
      return tx((db, s) => {
        assertOwner(s, tenantId, "Firmendaten darf nur der Inhaber ändern.");
        const t = tenantById(db, tenantId);
        for (const key of ["primaryColor", "secondaryColor", "accentColor"] as const) {
          const v = branding[key];
          if (v !== undefined && !HEX.test(v)) throw new Error("Farben bitte im Format #RRGGBB angeben.");
        }
        if (branding.logoUrl && branding.logoUrl.startsWith("data:")) validateLogoDataUrl(branding.logoUrl);
        if (branding.slogan !== undefined && branding.slogan !== null && branding.slogan.length > 80) throw new Error("Der Slogan darf höchstens 80 Zeichen lang sein.");
        const before = clone(t.branding);
        t.branding = { ...t.branding, ...branding };
        addAudit(db, s, { tenantId, action: "tenant.branding_updated", entity: "tenant", entityId: tenantId, before: { ...before, logoUrl: before.logoUrl?.slice(0, 60) ?? null }, after: { ...t.branding, logoUrl: t.branding.logoUrl?.slice(0, 60) ?? null }, reason: null });
        return t;
      });
    },
    async renameTenant(tenantId, name) {
      return tx((db, s) => {
        assertOwner(s, tenantId, "Firmendaten darf nur der Inhaber ändern.");
        const t = tenantById(db, tenantId);
        const next = name.trim();
        if (next.length < 2 || next.length > 200) throw new Error("Bitte den Firmennamen angeben (2–200 Zeichen).");
        const before = { name: t.name };
        t.name = next;
        addAudit(db, s, { tenantId, action: "tenant.renamed", entity: "tenant", entityId: tenantId, before, after: { name: next }, reason: null });
        return t;
      });
    },
    async updateContact(tenantId, contact: Partial<CompanyContact>) {
      return tx((db, s) => {
        assertOwner(s, tenantId, "Firmendaten darf nur der Inhaber ändern.");
        const t = tenantById(db, tenantId);
        if (contact.whatsapp && !/^\d{8,15}$/.test(contact.whatsapp)) throw new Error("WhatsApp-Nummer bitte nur als Ziffern mit Ländervorwahl angeben, z. B. 492411234567.");
        if (contact.email && !/^\S+@\S+\.\S+$/.test(contact.email)) throw new Error("Bitte eine gültige E-Mail-Adresse angeben.");
        if (contact.website && !/^https:\/\/\S+$/.test(contact.website)) throw new Error("Die Website muss mit https:// beginnen.");
        if (contact.postalCode && !/^\d{5}$/.test(contact.postalCode)) throw new Error("Die Postleitzahl muss fünfstellig sein.");
        const before = clone(t.contact);
        t.contact = { ...t.contact, ...contact };
        addAudit(db, s, { tenantId, action: "tenant.contact_updated", entity: "tenant", entityId: tenantId, before, after: t.contact, reason: null });
        return t;
      });
    },
    async updateSettings(tenantId, settings: Partial<TenantSettings>) {
      return tx((db, s) => {
        assertOwner(s, tenantId, "Einstellungen darf nur der Inhaber ändern.");
        const t = tenantById(db, tenantId);
        const before = clone(t.settings);
        if (settings.breakPolicy) {
          const bp = { ...t.settings.breakPolicy, ...settings.breakPolicy };
          const problems = validateBreakPolicy(bp);
          if (problems.length) throw new Error(problems[0]);
          t.settings.breakPolicy = clone(bp);
        }
        if (settings.workAccount) {
          const w = { ...t.settings.workAccount, ...settings.workAccount };
          if (!Number.isSafeInteger(w.openingMinutes) || Math.abs(w.openingMinutes) > 60000) throw new Error("Ungültiger Startsaldo.");
          if (!isValidMonth(w.startMonth)) throw new Error("Ungültiger Startmonat.");
          t.settings.workAccount = w;
        }
        addAudit(db, s, { tenantId, action: "tenant.settings_updated", entity: "tenant", entityId: tenantId, before, after: t.settings, reason: null });
        return t;
      });
    },

    // ------------------------------------------------ employees
    async listEmployees(tenantId) {
      return read((db, s) => {
        if (s.platformRole && !s.tenantId) {
          if (!hasSupportGrant(db, tenantId)) throw new AccessDeniedError("Kein Supportzugriff: Der Mandant hat keine Freigabe erteilt.");
        } else {
          assertMember(s, tenantId);
        }
        const list = db.employees.filter((e) => e.tenantId === tenantId);
        const visible = isManager(s) || (s.platformRole && !s.tenantId) ? list : list.filter((e) => e.id === s.employeeId);
        return visible.sort((a, b) => a.displayName.localeCompare(b.displayName, "de"));
      });
    },
    async inviteEmployee(tenantId, input) {
      return tx((db, s) => {
        assertManager(s, tenantId);
        const name = input.displayName.trim();
        const nr = input.personnelNumber.trim();
        const email = input.email ? normEmail(input.email) : null;
        if (name.length < 2) throw new Error("Bitte den Namen angeben.");
        if (!/^[A-Za-z0-9_-]{1,30}$/.test(nr)) throw new Error("Personalnummer: 1–30 Zeichen, nur Buchstaben, Ziffern, - und _.");
        if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Bitte eine gültige E-Mail-Adresse angeben.");
        if (db.employees.some((e) => e.tenantId === tenantId && e.personnelNumber === nr)) throw new Error("Diese Personalnummer ist bereits vergeben.");
        if (email && db.accounts.some((a) => a.email === email)) throw new Error("Diese E-Mail-Adresse wird bereits verwendet.");
        if (input.role !== "employee" && s.role !== "owner") throw new AccessDeniedError("Nur der Inhaber kann weitere Vorgesetzte anlegen.");
        const lic = db.licenses.find((l) => l.tenantId === tenantId);
        const count = db.employees.filter((e) => e.tenantId === tenantId && e.status !== "deactivated").length;
        if (lic?.maxEmployees != null && count >= lic.maxEmployees) throw new Error(`Die Lizenz erlaubt höchstens ${lic.maxEmployees} aktive Mitarbeitende.`);
        const emp: Employee = { id: uuid(), tenantId, personnelNumber: nr, displayName: name, email, role: input.role, status: "invited", createdAt: new Date().toISOString() };
        db.employees.push(emp);
        recordStatus(db, emp);
        if (email) db.accounts.push({ userId: `u-${emp.id}`, email, password: DEMO_PASSWORD, tenantId, employeeId: emp.id, platformRole: null });
        addAudit(db, s, { tenantId, action: "employee.invited", entity: "employee", entityId: emp.id, before: null, after: emp, reason: null });
        const result: InvitedEmployee = email ? { ...emp, invitation: demoInvitation(input.invitation ?? "email") } : emp;
        return result;
      });
    },
    async createInvitation(employeeId, channel) {
      return tx((db, s) => {
        const emp = db.employees.find((e) => e.id === employeeId);
        if (!emp) throw new AccessDeniedError();
        assertManager(s, emp.tenantId);
        if (emp.role !== "employee" && s.role !== "owner") throw new AccessDeniedError("Nur Inhaber dürfen Leitungspersonen einladen.");
        if (emp.status !== "invited") throw new Error("Dieser Mitarbeiter hat bereits ein Benutzerkonto.");
        if (!emp.email) throw new Error("Für die Einladung wird eine E-Mail-Adresse benötigt.");
        const info = demoInvitation(channel);
        addAudit(db, s, { tenantId: emp.tenantId, action: "invitation.created", entity: "invitation", entityId: emp.id, before: null, after: { channel, expiresAt: info.expiresAt }, reason: null });
        return info;
      });
    },
    async updateEmployee(employeeId, patch) {
      return tx((db, s) => {
        const emp = db.employees.find((e) => e.id === employeeId);
        if (!emp) throw new AccessDeniedError();
        assertManager(s, emp.tenantId);
        if (emp.anonymizedAt) throw new AccessDeniedError(ANONYMIZED_FINAL);
        if (patch.role && patch.role !== emp.role && s.role !== "owner") throw new AccessDeniedError("Rollen darf nur der Inhaber ändern.");
        if (patch.role && emp.id === s.employeeId && patch.role !== emp.role) throw new Error("Die eigene Rolle kann nicht geändert werden.");
        if (patch.personnelNumber !== undefined) {
          const nr = patch.personnelNumber.trim();
          if (!/^[A-Za-z0-9_-]{1,30}$/.test(nr)) throw new Error("Personalnummer: 1–30 Zeichen, nur Buchstaben, Ziffern, - und _.");
          if (db.employees.some((e) => e.tenantId === emp.tenantId && e.personnelNumber === nr && e.id !== emp.id)) throw new Error("Diese Personalnummer ist bereits vergeben.");
          patch = { ...patch, personnelNumber: nr };
        }
        if (patch.displayName !== undefined && patch.displayName.trim().length < 2) throw new Error("Bitte den Namen angeben.");
        if (patch.email) {
          const email = normEmail(patch.email);
          if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Bitte eine gültige E-Mail-Adresse angeben.");
          if (db.accounts.some((a) => a.email === email && a.employeeId !== emp.id)) throw new Error("Diese E-Mail-Adresse wird bereits verwendet.");
          const acc = db.accounts.find((a) => a.employeeId === emp.id);
          if (acc) acc.email = email;
          else db.accounts.push({ userId: `u-${emp.id}`, email, password: DEMO_PASSWORD, tenantId: emp.tenantId, employeeId: emp.id, platformRole: null });
          patch = { ...patch, email };
        }
        const before = clone(emp);
        Object.assign(emp, patch);
        recordStatus(db, emp);
        addAudit(db, s, { tenantId: emp.tenantId, action: "employee.updated", entity: "employee", entityId: emp.id, before, after: clone(emp), reason: null });
        return emp;
      });
    },
    async setEmployeeStatus(employeeId, status, reason) {
      return tx((db, s) => {
        const emp = db.employees.find((e) => e.id === employeeId);
        if (!emp) throw new AccessDeniedError();
        assertManager(s, emp.tenantId);
        if (emp.anonymizedAt) throw new AccessDeniedError(ANONYMIZED_FINAL);
        const r = requireReason(reason);
        if (emp.id === s.employeeId) throw new Error(status === "locked" ? "Du kannst dich nicht selbst sperren." : "Du kannst dich nicht selbst deaktivieren.");
        if (emp.role !== "employee" && s.role !== "owner") throw new AccessDeniedError("Leitungspersonen kann nur der Inhaber sperren oder deaktivieren.");
        if (status === "locked" && emp.status !== "active") throw new Error("Nur aktive Mitarbeitende können gesperrt werden.");
        if (status === "active") {
          const lic = db.licenses.find((l) => l.tenantId === emp.tenantId);
          const count = db.employees.filter((e) => e.tenantId === emp.tenantId && e.status !== "deactivated").length;
          if (emp.status === "deactivated" && lic?.maxEmployees != null && count >= lic.maxEmployees) throw new Error(`Die Lizenz erlaubt höchstens ${lic.maxEmployees} aktive Mitarbeitende.`);
        }
        const before = { status: emp.status };
        emp.status = status;
        recordStatus(db, emp);
        const action = status === "locked" ? "employee.locked"
          : status === "deactivated" ? "employee.deactivated"
          : before.status === "locked" ? "employee.unlocked" : "employee.activated";
        addAudit(db, s, { tenantId: emp.tenantId, action, entity: "employee", entityId: emp.id, before, after: { status }, reason: r });
        return emp;
      });
    },

    // ------------------------------------------------ time entries
    async listTimeEntries(employeeId, month) {
      return read((db, s) => {
        assertEmployeeRead(db, s, employeeId);
        return db.entries
          .filter((e) => e.employeeId === employeeId && !e.deletedAt && e.date.startsWith(month))
          .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
      });
    },
    async listTenantTimeEntries(tenantId, fromDate, toDate) {
      return read((db, s) => {
        if (s.platformRole && !s.tenantId) {
          if (!hasSupportGrant(db, tenantId)) throw new AccessDeniedError("Kein Supportzugriff: Der Mandant hat keine Freigabe erteilt.");
        } else {
          assertManager(s, tenantId);
        }
        return db.entries
          .filter((e) => e.tenantId === tenantId && !e.deletedAt && e.date >= fromDate && e.date <= toDate)
          .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
      });
    },
    async createTimeEntry(employeeId, entry: NewTimeEntry) {
      return tx((db, s) => {
        const emp = assertEmployeeWrite(db, s, employeeId);
        const existing = db.entries.find((e) => e.id === entry.id);
        if (existing) {
          if (existing.employeeId !== employeeId) throw new ConflictError("Diese Eintrags-ID ist bereits vergeben.");
          return existing; // idempotent (offline sync retry)
        }
        if (!entry.id || entry.id.length > 64) throw new Error("Ungültige Eintrags-ID.");
        const tenant = tenantById(db, emp.tenantId);
        assertMonthOpen(db, s, employeeId, monthOf(entry.date));
        const note = (entry.note ?? "").trim();
        validateEntry(db, tenant, employeeId, { ...entry, note });
        const now = new Date().toISOString();
        const byManager = s.employeeId !== employeeId;
        const created: TimeEntry = {
          id: entry.id, tenantId: emp.tenantId, employeeId, date: entry.date, start: entry.start, end: entry.end,
          pauseMinutes: entry.pauseMinutes, note, version: 1, createdAt: now, updatedAt: now, deletedAt: null,
          source: byManager ? "correction" : entry.source === "migration" ? "migration" : "app",
        };
        db.entries.push(created);
        recordRevision(db, s, created, "insert", byManager, null);
        if (byManager) addAudit(db, s, { tenantId: emp.tenantId, action: "time_entry.created_by_manager", entity: "time_entry", entityId: created.id, before: null, after: created, reason: null });
        return created;
      });
    },
    async updateTimeEntry(entryId, patch, expectedVersion, reason) {
      return tx((db, s) => {
        const entry = db.entries.find((e) => e.id === entryId && !e.deletedAt);
        if (!entry) throw new Error("Der Eintrag wurde nicht gefunden oder bereits gelöscht.");
        assertEmployeeWrite(db, s, entry.employeeId);
        if (entry.version !== expectedVersion) throw new ConflictError();
        const byManager = s.employeeId !== entry.employeeId;
        const r = byManager ? requireReason(reason, "Korrekturen durch Vorgesetzte benötigen eine Begründung.") : (reason?.trim() || null);
        assertMonthOpen(db, s, entry.employeeId, monthOf(entry.date));
        if (patch.date) assertMonthOpen(db, s, entry.employeeId, monthOf(patch.date));
        const next = {
          id: entry.id, date: patch.date ?? entry.date, start: patch.start ?? entry.start, end: patch.end ?? entry.end,
          pauseMinutes: patch.pauseMinutes ?? entry.pauseMinutes, note: (patch.note ?? entry.note).trim(),
        };
        validateEntry(db, tenantById(db, entry.tenantId), entry.employeeId, next);
        const before = clone(entry);
        Object.assign(entry, next, { version: entry.version + 1, updatedAt: new Date().toISOString(), source: byManager ? "correction" : entry.source });
        recordRevision(db, s, entry, "update", byManager, r);
        addAudit(db, s, { tenantId: entry.tenantId, action: byManager ? "time_entry.corrected" : "time_entry.updated", entity: "time_entry", entityId: entry.id, before, after: clone(entry), reason: r });
        return entry;
      });
    },
    async deleteTimeEntry(entryId, expectedVersion, reason) {
      await tx((db, s) => {
        const entry = db.entries.find((e) => e.id === entryId && !e.deletedAt);
        if (!entry) throw new Error("Der Eintrag wurde nicht gefunden oder bereits gelöscht.");
        assertEmployeeWrite(db, s, entry.employeeId);
        if (entry.version !== expectedVersion) throw new ConflictError();
        const byManager = s.employeeId !== entry.employeeId;
        const r = byManager ? requireReason(reason, "Löschungen durch Vorgesetzte benötigen eine Begründung.") : (reason?.trim() || null);
        assertMonthOpen(db, s, entry.employeeId, monthOf(entry.date));
        const before = clone(entry);
        entry.deletedAt = new Date().toISOString();
        entry.version += 1;
        if (byManager) entry.source = "correction";
        recordRevision(db, s, entry, "delete", byManager, r);
        addAudit(db, s, { tenantId: entry.tenantId, action: "time_entry.deleted", entity: "time_entry", entityId: entry.id, before, after: { deletedAt: entry.deletedAt }, reason: r });
        return null;
      });
    },

    // ------------------------------------------------ work account
    async listAllocations(employeeId) {
      return read((db, s) => {
        assertEmployeeRead(db, s, employeeId);
        return db.allocations
          .filter((a) => a.employeeId === employeeId)
          .map(({ employeeId: e, month, minutes, status }) => ({ employeeId: e, month, minutes, status }))
          .sort((a, b) => a.month.localeCompare(b.month));
      });
    },
    async setAllocation(employeeId, month, minutes) {
      return tx((db, s) => {
        const emp = assertEmployeeWrite(db, s, employeeId);
        if (s.employeeId !== employeeId) throw new AccessDeniedError("Die Aufteilung trifft der Mitarbeitende selbst.");
        if (!isValidMonth(month)) throw new Error("Bitte gültigen Monat wählen.");
        const st = statementOf(db, employeeId, month);
        if (st && st.status === "approved") throw new Error("Der Monat ist bereits freigegeben. Die Aufteilung kann nicht mehr geändert werden.");
        const tenant = tenantById(db, emp.tenantId);
        const entries = activeShifts(db.entries.filter((e) => e.employeeId === employeeId));
        const others = db.allocations.filter((a) => a.employeeId === employeeId && a.month !== month);
        validateAllocation({ entries, allocations: others, month, minutes, policy: tenant.settings.workAccount });
        const status: MonthAllocation["status"] = tenant.settings.workAccount.approvalRequired ? "proposed" : "approved";
        let alloc = db.allocations.find((a) => a.employeeId === employeeId && a.month === month);
        const before = alloc ? clone(alloc) : null;
        if (!alloc) {
          alloc = { employeeId, tenantId: emp.tenantId, month, minutes, status, reviewNote: null, updatedAt: new Date().toISOString() };
          db.allocations.push(alloc);
        } else {
          Object.assign(alloc, { minutes, status, reviewNote: null, updatedAt: new Date().toISOString() });
        }
        addAudit(db, s, { tenantId: emp.tenantId, action: "allocation.set", entity: "allocation", entityId: `${employeeId}:${month}`, before, after: clone(alloc), reason: null });
        return { employeeId, month, minutes: alloc.minutes, status: alloc.status };
      });
    },
    async reviewAllocation(employeeId, month, decision, reason) {
      return tx((db, s) => {
        const emp = db.employees.find((e) => e.id === employeeId);
        if (!emp) throw new AccessDeniedError();
        assertManager(s, emp.tenantId);
        const alloc = db.allocations.find((a) => a.employeeId === employeeId && a.month === month);
        if (!alloc) throw new Error("Für diesen Monat liegt keine Aufteilung vor.");
        const r = decision === "rejected" ? requireReason(reason, "Bitte begründen, warum die Aufteilung abgelehnt wird.") : (reason?.trim() || null);
        const before = clone(alloc);
        alloc.status = decision;
        alloc.reviewNote = r;
        alloc.updatedAt = new Date().toISOString();
        addAudit(db, s, { tenantId: emp.tenantId, action: `allocation.${decision}`, entity: "allocation", entityId: `${employeeId}:${month}`, before, after: clone(alloc), reason: r });
        return { employeeId, month, minutes: alloc.minutes, status: alloc.status };
      });
    },

    // ------------------------------------------------ statements
    async listStatements(tenantId, month) {
      return read((db, s) => {
        assertManager(s, tenantId);
        return db.statements.filter((x) => x.tenantId === tenantId && x.month === month).map((x) => withCorrectionFlag(db, x));
      });
    },
    async getStatement(employeeId, month) {
      return read((db, s) => {
        assertEmployeeRead(db, s, employeeId);
        const st = statementOf(db, employeeId, month);
        return st ? withCorrectionFlag(db, st) : null;
      });
    },
    async submitStatement(employeeId, month) {
      return tx((db, s) => {
        const emp = assertEmployeeWrite(db, s, employeeId);
        if (s.employeeId !== employeeId) throw new AccessDeniedError("Den Monatsnachweis reicht der Mitarbeitende selbst ein.");
        if (!isValidMonth(month)) throw new Error("Bitte gültigen Monat wählen.");
        const tenant = tenantById(db, emp.tenantId);
        const mine = db.entries.filter((e) => e.employeeId === employeeId && !e.deletedAt);
        if (!mine.some((e) => e.date.startsWith(month))) throw new Error("Für diesen Monat sind noch keine Arbeitszeiten erfasst.");
        const shifts = activeShifts(mine);
        const dates = [...new Set(shifts.filter((x) => x.date.startsWith(month)).map((x) => x.date))];
        for (const d of dates) {
          const problem = issueForDay(evaluateDay(shifts, d, tenant.settings.breakPolicy), tenant.settings.breakPolicy);
          if (problem) throw new Error(`Bitte zunächst die Pause korrigieren. ${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}: ${problem}`);
        }
        const allocs = db.allocations.filter((a) => a.employeeId === employeeId);
        const sum = safeSummary(mine, allocs, month, tenant.settings.workAccount);
        let st = statementOf(db, employeeId, month);
        if (st && (st.status === "submitted" || st.status === "approved")) throw new Error("Der Monatsnachweis wurde bereits eingereicht.");
        const now = new Date().toISOString();
        const before = st ? clone(st) : null;
        if (!st) {
          st = { id: uuid(), tenantId: emp.tenantId, employeeId, month, status: "submitted", submittedAt: now, reviewedAt: null, reviewedBy: null, reviewNote: null, workedMinutes: 0, allocatedMinutes: 0, billingMinutes: 0 };
          db.statements.push(st);
        }
        Object.assign(st, { status: "submitted", submittedAt: now, reviewedAt: null, reviewedBy: null, workedMinutes: sum.worked, allocatedMinutes: sum.allocated, billingMinutes: sum.billing });
        addAudit(db, s, { tenantId: emp.tenantId, action: "statement.submitted", entity: "statement", entityId: st.id, before, after: clone(st), reason: null });
        return st;
      });
    },
    async approveStatement(statementId) {
      return tx((db, s) => {
        const st = db.statements.find((x) => x.id === statementId);
        if (!st) throw new AccessDeniedError();
        assertManager(s, st.tenantId);
        if (st.status !== "submitted") throw new Error("Nur eingereichte Monatsnachweise können freigegeben werden.");
        const before = clone(st);
        Object.assign(st, { status: "approved", reviewedAt: new Date().toISOString(), reviewedBy: s.employeeId, reviewNote: null });
        addAudit(db, s, { tenantId: st.tenantId, action: "statement.approved", entity: "statement", entityId: st.id, before, after: clone(st), reason: null });
        return st;
      });
    },
    async returnStatement(statementId, reason) {
      return tx((db, s) => {
        const st = db.statements.find((x) => x.id === statementId);
        if (!st) throw new AccessDeniedError();
        assertManager(s, st.tenantId);
        const r = requireReason(reason, "Bitte begründen, warum der Monatsnachweis zurückgegeben wird.");
        if (st.status !== "submitted" && st.status !== "approved") throw new Error("Dieser Monatsnachweis ist nicht eingereicht.");
        const before = clone(st);
        Object.assign(st, { status: "returned", reviewedAt: new Date().toISOString(), reviewedBy: s.employeeId, reviewNote: r });
        addAudit(db, s, { tenantId: st.tenantId, action: "statement.returned", entity: "statement", entityId: st.id, before, after: clone(st), reason: r });
        return st;
      });
    },

    // ------------------------------------------------ correction requests (like migration 0013)
    async listCorrectionRequests(tenantId, filter = {}) {
      return read((db, s) => {
        const platform = !!s.platformRole && !s.tenantId;
        if (platform) {
          if (!hasSupportGrant(db, tenantId)) throw new AccessDeniedError("Kein Supportzugriff: Der Mandant hat keine Freigabe erteilt.");
        } else {
          assertMember(s, tenantId);
        }
        return (db.correctionRequests ?? [])
          .filter((r) => r.tenantId === tenantId && (platform || isManager(s) || r.employeeId === s.employeeId))
          .filter((r) => (!filter.employeeId || r.employeeId === filter.employeeId) && (!filter.status || r.status === filter.status))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((r) => publicCorrection(db, s, r));
      });
    },
    async createCorrectionRequest(employeeId, input) {
      return tx((db, s) => {
        const emp = assertEmployeeWrite(db, s, employeeId);
        if (s.employeeId !== employeeId) throw new AccessDeniedError("Korrekturanfragen können nur für eigene Einträge gestellt werden.");
        const reason = (input.reason ?? "").trim();
        if (reason.length < 5) throw new Error("Bitte begründe die Korrekturanfrage (mind. 5 Zeichen).");
        if (reason.length > 1000) throw new Error("Die Begründung ist zu lang (max. 1000 Zeichen).");
        const tenant = tenantById(db, emp.tenantId);
        const list = (db.correctionRequests ??= []);
        let before: EntryValues | null = null;
        let proposed: EntryValues | null = null;
        let entry: TimeEntry | undefined;
        if (input.kind === "change" || input.kind === "delete") {
          entry = db.entries.find((e) => e.id === input.entryId && e.employeeId === employeeId && !e.deletedAt);
          if (!entry) throw new Error("Der Eintrag wurde nicht gefunden oder bereits gelöscht.");
          if (list.some((r) => r.employeeId === employeeId && r.entryId === entry!.id && r.status === "open")) {
            throw new Error("Für diesen Eintrag gibt es bereits eine offene Korrekturanfrage.");
          }
          before = valuesOf(entry);
        }
        if (input.kind === "change") {
          proposed = { ...before!, ...input.proposed, note: (input.proposed.note ?? before!.note).trim() };
          if (JSON.stringify(proposed) === JSON.stringify(before)) throw new Error("Die gewünschten Werte entsprechen dem aktuellen Eintrag.");
          validateEntry(db, tenant, employeeId, { id: entry!.id, ...proposed });
        } else if (input.kind === "add") {
          proposed = { ...input.proposed, note: (input.proposed.note ?? "").trim() };
          validateEntry(db, tenant, employeeId, { id: "neu", ...proposed });
        }
        const req: StoredCorrection = {
          id: uuid(), tenantId: emp.tenantId, employeeId, kind: input.kind, entryId: entry?.id ?? null, entryVersion: entry?.version ?? null,
          before, proposed, reason, status: "open", createdAt: new Date().toISOString(),
          decidedAt: null, decidedBy: null, decidedByName: null, decisionNote: null, appliedEntryId: null,
        };
        list.push(req);
        addAudit(db, s, { tenantId: emp.tenantId, action: "correction_request.created", entity: "correction_request", entityId: req.id, before: null, after: clone(req), reason });
        return publicCorrection(db, s, req);
      });
    },
    async withdrawCorrectionRequest(requestId) {
      return tx((db, s) => {
        const req = (db.correctionRequests ?? []).find((r) => r.id === requestId);
        if (!req || req.employeeId !== s.employeeId || s.tenantId !== req.tenantId) throw new AccessDeniedError("Korrekturanfrage nicht gefunden oder kein Zugriff.");
        if (req.status !== "open") throw new Error("Nur offene Korrekturanfragen können zurückgezogen werden.");
        const before = clone(req);
        Object.assign(req, { status: "withdrawn", decidedAt: new Date().toISOString(), decidedBy: s.employeeId });
        addAudit(db, s, { tenantId: req.tenantId, action: "correction_request.withdrawn", entity: "correction_request", entityId: req.id, before, after: clone(req), reason: null });
        return publicCorrection(db, s, req);
      });
    },
    async decideCorrectionRequest(requestId, decision, note) {
      return tx((db, s) => {
        const req = (db.correctionRequests ?? []).find((r) => r.id === requestId);
        if (!req) throw new AccessDeniedError("Korrekturanfrage nicht gefunden oder kein Zugriff.");
        assertManager(s, req.tenantId);
        if (req.employeeId === s.employeeId && s.role !== "owner") throw new AccessDeniedError("Über die eigene Korrekturanfrage entscheidet eine andere Leitungsperson.");
        if (req.status !== "open") throw new Error("Über diese Korrekturanfrage wurde bereits entschieden.");
        const before = clone(req);
        const now = new Date().toISOString();
        if (decision === "rejected") {
          const r = requireReason(note, "Bitte begründe die Ablehnung.");
          Object.assign(req, { status: "rejected", decidedAt: now, decidedBy: s.employeeId, decisionNote: r });
          addAudit(db, s, { tenantId: req.tenantId, action: "correction_request.rejected", entity: "correction_request", entityId: req.id, before, after: clone(req), reason: r });
          return publicCorrection(db, s, req);
        }
        const answer = note?.trim() || null;
        const reason = `Korrekturanfrage: ${req.reason}${answer ? ` – Leitung: ${answer}` : ""}`.slice(0, 1000);
        const tenant = tenantById(db, req.tenantId);
        let applied: TimeEntry;
        if (req.kind === "add") {
          const id = `kr-${req.id.replace(/-/g, "")}`;
          validateEntry(db, tenant, req.employeeId, { id, ...req.proposed! });
          applied = { id, tenantId: req.tenantId, employeeId: req.employeeId, ...req.proposed!, version: 1, createdAt: now, updatedAt: now, deletedAt: null, source: "correction" };
          db.entries.push(applied);
          recordRevision(db, s, applied, "insert", true, reason);
          addAudit(db, s, { tenantId: req.tenantId, action: "time_entry.created_by_manager", entity: "time_entry", entityId: id, before: null, after: clone(applied), reason });
        } else {
          const entry = db.entries.find((e) => e.id === req.entryId && e.employeeId === req.employeeId);
          if (!entry || entry.deletedAt || entry.version !== req.entryVersion) {
            throw new ConflictError("Der Eintrag wurde seit der Anfrage geändert oder gelöscht. Bitte die Anfrage ablehnen und neu stellen lassen.");
          }
          const old = clone(entry);
          if (req.kind === "change") {
            validateEntry(db, tenant, req.employeeId, { id: entry.id, ...req.proposed! });
            Object.assign(entry, req.proposed!);
          } else {
            entry.deletedAt = now;
          }
          Object.assign(entry, { version: entry.version + 1, updatedAt: now, source: "correction" });
          recordRevision(db, s, entry, req.kind === "delete" ? "delete" : "update", true, reason);
          addAudit(db, s, { tenantId: req.tenantId, action: req.kind === "delete" ? "time_entry.deleted" : "time_entry.corrected", entity: "time_entry", entityId: entry.id, before: old, after: clone(entry), reason });
          applied = entry;
        }
        Object.assign(req, { status: "accepted", decidedAt: now, decidedBy: s.employeeId, decisionNote: answer, appliedEntryId: applied.id });
        addAudit(db, s, { tenantId: req.tenantId, action: "correction_request.accepted", entity: "correction_request", entityId: req.id, before, after: clone(req), reason: answer });
        return publicCorrection(db, s, req);
      });
    },
    async listTimeEntryRevisions(employeeId, entryId) {
      return read((db, s) => {
        assertEmployeeRead(db, s, employeeId);
        const entry = db.entries.find((e) => e.id === entryId && e.employeeId === employeeId);
        if (!entry) throw new AccessDeniedError("Eintrag nicht gefunden oder kein Zugriff.");
        const list: TimeEntryRevision[] = (db.revisions ?? [])
          .filter((r) => r.employeeId === employeeId && r.entryId === entryId)
          .sort((a, b) => a.version - b.version || a.changedAt.localeCompare(b.changedAt))
          .map((r) => ({
            entryId: r.entryId, version: r.version, operation: r.operation, isCorrection: r.isCorrection, changedAt: r.changedAt,
            changedByName: visibleName(db, s, r.changedBy), reason: r.reason, values: r.values, deleted: r.deleted, source: r.source,
          }));
        if (!list.length) {
          // Demo data from before the history was recorded: show the current state.
          list.push({
            entryId, version: entry.version, operation: entry.deletedAt ? "delete" : entry.version === 1 ? "insert" : "update",
            isCorrection: entry.source === "correction", changedAt: entry.updatedAt, changedByName: null, reason: null,
            values: valuesOf(entry), deleted: !!entry.deletedAt, source: entry.source,
          });
        }
        return list;
      });
    },

    // ------------------------------------------------ data protection
    async exportPersonalData(employeeId) {
      return tx((db, s) => {
        const emp = db.employees.find((e) => e.id === employeeId);
        const self = !!emp && s.tenantId === emp.tenantId && s.employeeId === emp.id;
        if (!emp || (!self && !(s.tenantId === emp.tenantId && s.role === "owner"))) {
          throw new AccessDeniedError("Die Datenauskunft erhalten nur die Person selbst und der Inhaber.");
        }
        const tenant = tenantById(db, emp.tenantId);
        const acc = db.accounts.find((a) => a.employeeId === emp.id) ?? null;
        addAudit(db, s, { tenantId: emp.tenantId, action: "employee.data_export", entity: "employee", entityId: emp.id, before: null,
          after: { requestedBy: self ? "self" : "owner" }, reason: null });
        const out: PersonalDataExport = {
          format: "stundenwerk.personal-data.v1", generatedAt: new Date().toISOString(), requestedBy: self ? "self" : "owner",
          tenant: { id: tenant.id, name: tenant.name, legalName: tenant.contact.legalName || null },
          person: exportPerson(emp),
          account: self && acc ? { email: acc.email, createdAt: emp.createdAt, twoFactorEnabled: enrolled(db, acc.userId), sessions: [] } : null,
          ...employeeRecords(db, emp),
          auditLog: employeeAudit(db, emp).map((a) => ({ ...a, entityId: a.entityId })),
        };
        return out;
      });
    },
    async exportTenantData(tenantId) {
      return tx((db, s) => {
        assertOwner(s, tenantId, "Den Datenexport der Firma erhält nur der Inhaber.");
        const t = tenantById(db, tenantId);
        addAudit(db, s, { tenantId, action: "tenant.data_export", entity: "tenant", entityId: tenantId, before: null, after: null, reason: null });
        const out: TenantDataExport = {
          format: "stundenwerk.tenant-data.v1", generatedAt: new Date().toISOString(),
          tenant: { ...t },
          licenses: db.licenses.filter((l) => l.tenantId === tenantId),
          billingPeriods: (db.billingPeriods ?? []).filter((b) => b.tenantId === tenantId),
          supportGrants: db.supportGrants.filter((g) => g.tenantId === tenantId),
          employees: db.employees.filter((e) => e.tenantId === tenantId)
            .sort((a, b) => a.personnelNumber.localeCompare(b.personnelNumber))
            .map((e) => ({ ...exportPerson(e), ...employeeRecords(db, e) })),
          auditLog: db.audit.filter((a) => a.tenantId === tenantId),
        };
        return out;
      });
    },
    async setRetentionPolicy(tenantId, months) {
      return tx((db, s) => {
        assertOwner(s, tenantId, "Die Aufbewahrungsfrist legt nur der Inhaber fest.");
        if (months !== null && (!Number.isInteger(months) || months < 1 || months > 600)) {
          throw new Error("Aufbewahrungsfrist (Monate): bitte eine ganze Zahl von 1 bis 600 angeben.");
        }
        const t = tenantById(db, tenantId);
        const before = { retentionMonthsAfterExit: t.retentionMonthsAfterExit ?? null };
        t.retentionMonthsAfterExit = months;
        addAudit(db, s, { tenantId, action: "tenant.update", entity: "tenant", entityId: tenantId, before, after: { retentionMonthsAfterExit: months }, reason: null });
        return t;
      });
    },
    async anonymizeEmployee(employeeId, confirmPersonnelNumber) {
      return tx((db, s) => {
        const emp = db.employees.find((e) => e.id === employeeId);
        if (!emp || s.tenantId !== emp.tenantId || s.role !== "owner") throw new AccessDeniedError("Anonymisieren darf nur der Inhaber.");
        if (emp.anonymizedAt) throw new Error("Diese Person ist bereits anonymisiert.");
        if (emp.status !== "deactivated") throw new Error("Nur deaktivierte (ausgeschiedene) Mitarbeitende können anonymisiert werden.");
        if (confirmPersonnelNumber !== emp.personnelNumber) throw new Error("Zur Bestätigung bitte die Personalnummer der Person eingeben.");
        const tenant = tenantById(db, emp.tenantId);
        const months = tenant.retentionMonthsAfterExit ?? null;
        if (months === null) throw new Error("Bitte zuerst die Aufbewahrungsfrist nach dem Austritt festlegen (Datenschutz-Einstellungen, rechtlich prüfen).");
        const exit = (db.statusHistory ?? []).find((h) => h.employeeId === emp.id && h.to === null && h.status === "deactivated")?.from ?? emp.createdAt;
        const until = retentionEndsAt(exit, months)!;
        if (Date.now() < until.getTime()) {
          throw new Error(`Die Aufbewahrungsfrist läuft noch bis zum ${until.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" })}.`);
        }
        const tag = emp.id.replace(/-/g, "").slice(0, 8).toUpperCase();
        emp.displayName = `Anonymisiert ${tag}`;
        emp.personnelNumber = `ANON-${emp.id.replace(/-/g, "").slice(-24).toUpperCase()}`;
        emp.email = null;
        emp.anonymizedAt = new Date().toISOString();
        db.accounts = db.accounts.filter((a) => a.employeeId !== emp.id);
        for (const t of db.entries) if (t.employeeId === emp.id) t.note = "";
        for (const r of db.revisions ?? []) {
          if (r.employeeId !== emp.id) continue;
          r.values = { ...r.values, note: r.values.note ? "[anonymisiert]" : "" };
          if (r.reason) r.reason = "[anonymisiert]";
        }
        for (const r of db.correctionRequests ?? []) {
          if (r.employeeId !== emp.id) continue;
          r.reason = "[anonymisiert]";
          if (r.decisionNote) r.decisionNote = "[anonymisiert]";
          r.before = redact(r.before) as typeof r.before;
          r.proposed = redact(r.proposed) as typeof r.proposed;
        }
        for (const x of db.statements) if (x.employeeId === emp.id && x.reviewNote) x.reviewNote = "[anonymisiert]";
        for (const a of db.allocations) if (a.employeeId === emp.id && a.reviewNote) a.reviewNote = "[anonymisiert]";
        let redacted = 0;
        for (const a of employeeAudit(db, emp)) {
          a.before = redact(a.before);
          a.after = redact(a.after);
          if (a.reason) a.reason = "[anonymisiert]";
          redacted++;
        }
        addAudit(db, s, { tenantId: emp.tenantId, action: "employee.anonymize", entity: "employee", entityId: emp.id, before: null,
          after: { exitAt: exit, retentionMonths: months, auditEntriesRedacted: redacted }, reason: "Anonymisierung nach Ablauf der Aufbewahrungsfrist" });
        return emp;
      });
    },

    // ------------------------------------------------ audit
    async listAudit(tenantId, limit = 200) {
      return read((db, s) => {
        let events = db.audit.filter((e) => e.tenantId === tenantId);
        if (s.platformRole && !s.tenantId) {
          // Operators only see platform-level events (tenant/licence), never personal time data.
          events = events.filter((e) => e.entity === "license" || e.action.startsWith("tenant.status") || e.entity === "billing_period");
        } else {
          assertManager(s, tenantId);
        }
        return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      });
    },
    async listPlatformAudit(limit = 100) {
      return read((db, s) => {
        assertPlatform(s);
        return db.audit
          .filter((e) => e.entity === "license" || e.action.startsWith("tenant.status") || e.action === "tenant.created" || e.entity === "support_grant"
            || e.entity === "billing_period" || e.entity === "billing_settings")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit);
      });
    },

    // ------------------------------------------------ platform
    async listTenants() {
      return read((db, s) => {
        assertPlatform(s);
        return db.tenants.map((t) => overview(db, t)).sort((a, b) => a.tenant.name.localeCompare(b.tenant.name, "de"));
      });
    },
    async createTenant(input) {
      return tx((db, s) => {
        assertPlatform(s, true);
        const name = input.name.trim();
        const slug = input.slug.trim().toLowerCase();
        const ownerEmail = normEmail(input.ownerEmail);
        if (name.length < 2) throw new Error("Bitte den Firmennamen angeben.");
        if (!/^[a-z0-9](?:[a-z0-9-]{1,40})[a-z0-9]$/.test(slug)) throw new Error("Kurzname: 3–42 Zeichen, nur Kleinbuchstaben, Ziffern und Bindestriche.");
        if (db.tenants.some((t) => t.slug === slug)) throw new Error("Dieser Kurzname ist bereits vergeben.");
        if (!/^\S+@\S+\.\S+$/.test(ownerEmail)) throw new Error("Bitte eine gültige E-Mail-Adresse für den Inhaber angeben.");
        if (db.accounts.some((a) => a.email === ownerEmail)) throw new Error("Diese E-Mail-Adresse wird bereits verwendet.");
        const tenant: Tenant = {
          id: uuid(), slug, name, status: "active", isDemo: input.isDemo,
          branding: { logoUrl: null, markUrl: null, primaryColor: "#2d4f73", secondaryColor: "#4a6a8a", accentColor: "#3b82c4", slogan: null },
          contact: { legalName: name, street: "", postalCode: "", city: "", phone: null, whatsapp: null, email: null, website: null, contactPerson: null },
          settings: defaultSettings(),
        };
        db.tenants.push(tenant);
        const license = licenseFor(tenant.id, input.plan);
        if (input.freeOfCharge && input.plan !== "pilot_free") {
          // Free test customer in one step (special condition "free", optionally limited).
          if (input.conditionValidUntil && !isRealDate(input.conditionValidUntil)) throw new Error("Bitte ein gültiges Datum für die Gültigkeit angeben.");
          if (input.conditionNote && input.conditionNote.length > 500) throw new Error("Die Notiz zur Kondition darf höchstens 500 Zeichen lang sein.");
          license.freeOfCharge = true;
          license.conditionNote = input.conditionNote?.trim() || null;
          license.conditionValidUntil = input.conditionValidUntil || null;
        }
        db.licenses.push(license);
        const owner: Employee = { id: uuid(), tenantId: tenant.id, personnelNumber: "1", displayName: "Inhaber/in", email: ownerEmail, role: "owner", status: "invited", createdAt: new Date().toISOString() };
        db.employees.push(owner);
        recordStatus(db, owner);
        db.accounts.push({ userId: `u-${owner.id}`, email: ownerEmail, password: DEMO_PASSWORD, tenantId: tenant.id, employeeId: owner.id, platformRole: null });
        addAudit(db, s, { tenantId: tenant.id, action: "tenant.created", entity: "tenant", entityId: tenant.id, before: null, after: { name, slug, isDemo: input.isDemo }, reason: null });
        addAudit(db, s, { tenantId: tenant.id, action: "license.created", entity: "license", entityId: license.id, before: null, after: license, reason: null });
        return overview(db, tenant);
      });
    },
    async getSystemOverview() {
      return read((db, s) => {
        assertPlatform(s);
        const tenants: Record<string, number> = {};
        for (const t of db.tenants) tenants[t.status] = (tenants[t.status] ?? 0) + 1;
        const now = new Date().toISOString();
        const overview: SystemOverview = {
          version: null, commit: null, serverTime: now, uptimeSeconds: 0, nodeVersion: "—", production: false,
          database: { reachable: false, time: null }, migrations: null, activeSessions: null, tenants,
          mail: { configured: false, delivery: "none" }, paymentProvider: "none", lastBackupAt: null,
        };
        return overview;
      });
    },
    async setTenantStatus(tenantId, status, reason) {
      return tx((db, s) => {
        assertPlatform(s, true);
        if (!["active", "suspended", "pending", "deactivated"].includes(status)) throw new Error("Ungültiger Status.");
        const r = requireReason(reason);
        const t = tenantById(db, tenantId);
        const before = { status: t.status };
        t.status = status;
        addAudit(db, s, { tenantId, action: `tenant.status_${status}`, entity: "tenant", entityId: tenantId, before, after: { status }, reason: r });
        return t;
      });
    },
    async setLicense(tenantId, plan: LicensePlan, patch = {}) {
      return tx((db, s) => {
        assertPlatform(s, true);
        tenantById(db, tenantId);
        let lic = db.licenses.find((l) => l.tenantId === tenantId);
        const before = lic ? clone(lic) : null;
        const fresh = licenseFor(tenantId, plan);
        if (!lic) {
          lic = fresh;
          db.licenses.push(lic);
        } else if (lic.plan !== plan) {
          Object.assign(lic, { ...fresh, id: lic.id, validFrom: lic.validFrom });
        }
        if (plan === "pilot_free") {
          // Pilot: always free, unlimited, no payment data – patch cannot change that.
          Object.assign(lic, { priceCents: 0, billing: "none", validUntil: null, maxEmployees: null });
          if (patch.note !== undefined) lic.note = patch.note;
          if (patch.features) lic.features = patch.features;
        } else {
          if (patch.maxEmployees !== undefined) {
            if (patch.maxEmployees !== null && (!Number.isInteger(patch.maxEmployees) || patch.maxEmployees < 1)) throw new Error("Maximale Mitarbeiterzahl muss mindestens 1 sein.");
            lic.maxEmployees = patch.maxEmployees;
          }
          if (patch.validUntil !== undefined) {
            if (patch.validUntil !== null && !isRealDate(patch.validUntil)) throw new Error("Bitte ein gültiges Enddatum angeben.");
            lic.validUntil = patch.validUntil;
          }
          if (patch.note !== undefined) lic.note = patch.note;
          if (patch.features) lic.features = patch.features;
        }
        // Special billing condition (price model 2026-10-28).
        if (patch.employeePriceCents !== undefined) {
          if (patch.employeePriceCents !== null && (!Number.isInteger(patch.employeePriceCents) || patch.employeePriceCents < 0 || patch.employeePriceCents > 100000)) {
            throw new Error("Sonderpreis: ganze Cent zwischen 0 und 1.000,00 €.");
          }
          lic.employeePriceCents = patch.employeePriceCents;
        }
        if (patch.freeOfCharge !== undefined) lic.freeOfCharge = patch.freeOfCharge;
        else if (before?.plan === "pilot_free" && plan !== "pilot_free") lic.freeOfCharge = false;
        if (plan === "pilot_free") lic.freeOfCharge = true;
        if (patch.conditionNote !== undefined) {
          if (patch.conditionNote && patch.conditionNote.length > 500) throw new Error("Die Notiz zur Kondition darf höchstens 500 Zeichen lang sein.");
          lic.conditionNote = patch.conditionNote || null;
        }
        for (const k of ["conditionValidFrom", "conditionValidUntil"] as const) {
          const val = patch[k];
          if (val === undefined) continue;
          if (val && !isRealDate(val)) throw new Error("Bitte ein gültiges Datum für die Gültigkeit angeben.");
          lic[k] = val || null;
        }
        if (lic.conditionValidFrom && lic.conditionValidUntil && lic.conditionValidUntil < lic.conditionValidFrom) {
          throw new Error("Die Kondition endet vor ihrem Beginn.");
        }
        addAudit(db, s, { tenantId, action: "license.updated", entity: "license", entityId: lic.id, before, after: clone(lic), reason: patch.reason?.trim() || null });
        return lic;
      });
    },

    // ------------------------------------------------ support access
    async getSupportGrant(tenantId) {
      return read((db, s) => {
        if (!(s.platformRole && !s.tenantId)) assertMember(s, tenantId);
        const g = db.supportGrants.find((x) => x.tenantId === tenantId);
        return g && g.grantedUntil > new Date().toISOString() ? g : null;
      });
    },
    async setSupportGrant(tenantId, hours) {
      return tx((db, s) => {
        assertManager(s, tenantId);
        if (s.role !== "owner") throw new AccessDeniedError("Supportzugriff kann nur der Inhaber freigeben.");
        const before = db.supportGrants.find((x) => x.tenantId === tenantId) ?? null;
        db.supportGrants = db.supportGrants.filter((x) => x.tenantId !== tenantId);
        let grant: SupportGrant | null = null;
        if (hours > 0) {
          if (hours > 72) throw new Error("Supportzugriff höchstens 72 Stunden.");
          grant = { tenantId, grantedUntil: new Date(Date.now() + hours * 3600000).toISOString(), grantedBy: s.employeeId! };
          db.supportGrants.push(grant);
        }
        addAudit(db, s, { tenantId, action: grant ? "support_grant.granted" : "support_grant.revoked", entity: "support_grant", entityId: tenantId, before, after: grant, reason: null });
        return grant;
      });
    },

    // ------------------------------------------------ billing (price model 2026-10-28)
    async getTenantBilling(tenantId, month) {
      return read((db, s) => {
        assertManager(s, tenantId);
        assertBillingMonth(month);
        const m = billingMonth(db, tenantId, month);
        const result: TenantBillingMonth = {
          ...summaryOf(m), tenantId, isCurrentMonth: month === currentBillingMonth(), plan: m.plan, currency: "EUR", closedAt: m.closedAt,
          lines: m.lines.flatMap((l) => {
            const e = db.employees.find((x) => x.id === l.employeeId);
            return e ? [{ employeeId: e.id, displayName: e.displayName, personnelNumber: e.personnelNumber, role: e.role, status: e.status, reason: l.reason }] : [];
          }).sort((a, b) => a.displayName.localeCompare(b.displayName, "de")),
        };
        return result;
      });
    },
    async listTenantBillingHistory(tenantId, limit = 12) {
      return read((db, s) => {
        assertManager(s, tenantId);
        return monthsBack(currentBillingMonth(), firstBillingMonth(db, tenantId), Math.min(Math.max(limit, 1), 36))
          .map((m) => summaryOf(billingMonth(db, tenantId, m)));
      });
    },
    async getPlatformRevenue(month) {
      return read((db, s) => {
        assertPlatform(s);
        assertBillingMonth(month);
        const rows: PlatformRevenueRow[] = db.tenants
          .filter((t) => firstBillingMonth(db, t.id) <= month)
          .sort((a, b) => a.name.localeCompare(b.name, "de"))
          .map((t) => {
            const m = billingMonth(db, t.id, month);
            // Numbers only – never names or billable persons.
            return { ...summaryOf(m), tenantId: t.id, tenantName: t.name, slug: t.slug, isDemo: t.isDemo, tenantStatus: t.status, plan: m.plan, note: m.note, closedAt: m.closedAt };
          });
        return { month, defaultPriceCents: db.defaultPriceCents ?? DEFAULT_EMPLOYEE_PRICE_CENTS, rows, totals: revenueTotals(rows), paymentProvider: "none" as const };
      });
    },
    async getBillingSettings() {
      return read((db, s) => {
        assertPlatform(s);
        return { defaultPriceCents: db.defaultPriceCents ?? DEFAULT_EMPLOYEE_PRICE_CENTS, currency: "EUR" as const };
      });
    },
    async setDefaultPrice(cents, reason) {
      return tx((db, s) => {
        assertPlatform(s, true);
        if (!Number.isInteger(cents) || cents < 0 || cents > 100000) throw new Error("Der Standardpreis muss zwischen 0 und 1.000,00 € liegen.");
        const r = requireReason(reason, "Bitte einen Grund für die Preisänderung angeben.");
        const before = { defaultPriceCents: db.defaultPriceCents ?? DEFAULT_EMPLOYEE_PRICE_CENTS };
        db.defaultPriceCents = cents;
        addAudit(db, s, { tenantId: null, action: "billing_settings.default_price", entity: "billing_settings", entityId: "default", before, after: { defaultPriceCents: cents }, reason: r });
        return { defaultPriceCents: cents, currency: "EUR" as const };
      });
    },
    async setBillingStatus(tenantId, month, status, note) {
      return tx((db, s) => {
        assertPlatform(s, true);
        tenantById(db, tenantId);
        if (!isValidMonth(month)) throw new Error("Bitte einen gültigen Monat (JJJJ-MM) angeben.");
        if (month >= currentBillingMonth()) throw new Error("Abrechnungsstatus erst nach Monatsende: Der laufende Monat ist eine Vorschau.");
        if (!["open", "invoiced", "paid", "waived"].includes(status)) throw new Error("Ungültiger Abrechnungsstatus.");
        let n = note?.trim() || null;
        if (n && n.length > 500) throw new Error("Die Notiz ist zu lang (max. 500 Zeichen).");
        const periods = (db.billingPeriods ??= []);
        let p = billingPeriod(db, tenantId, month);
        const before = p ? clone(p) : null;
        const frozen = !!p && p.status !== "open" && !!p.snapshot;
        if (status === "waived" || (status === "open" && frozen)) {
          n = requireReason(n, status === "waived" ? "Bitte einen Grund für den Erlass angeben." : "Bitte einen Grund für das Wiederöffnen angeben.");
        }
        if (!p) {
          p = { tenantId, month, status: "open", note: null, closedAt: null, snapshot: null };
          periods.push(p);
        }
        if (status === "open") {
          Object.assign(p, { status, snapshot: null, closedAt: null, note: n });
        } else if (frozen) {
          Object.assign(p, { status, note: n ?? p.note });
        } else {
          const m = billingMonth(db, tenantId, month);
          Object.assign(p, {
            status, note: n ?? p.note, closedAt: new Date().toISOString(),
            snapshot: { condition: m.condition, plan: m.plan, unitPriceCents: m.unitPriceCents, billableCount: m.billableCount, amountCents: m.amountCents, lines: m.lines },
          });
        }
        const numbers = (x: DemoBillingPeriod | null) => x && { status: x.status, note: x.note, billableCount: x.snapshot?.billableCount ?? null, amountCents: x.snapshot?.amountCents ?? null };
        addAudit(db, s, { tenantId, action: "billing_period.status", entity: "billing_period", entityId: `${tenantId}:${month}`, before: numbers(before), after: numbers(p), reason: n });
        return summaryOf(billingMonth(db, tenantId, month));
      });
    },

    resetDemoData() {
      save(seedDb(new Date()));
    },
  };
  return repo;
}

function licenseFor(tenantId: UUID, plan: LicensePlan): License {
  const today = localISODate(new Date());
  if (plan === "pilot_free") {
    return { id: uuid(), tenantId, plan, status: "active", priceCents: 0, billing: "none", validFrom: today, validUntil: null, maxEmployees: null, features: ["work_account", "pdf_statements", "chef_portal"], note: "Pilotkunde – kostenlos, unbefristet, keine Zahlungsdaten.", ...NO_CONDITION, freeOfCharge: true };
  }
  const max: Record<Exclude<LicensePlan, "pilot_free">, number | null> = { standard: 25, business: 100, enterprise: null };
  // Price: platform default per billable employee (price model 2026-10-28) unless a special condition is set.
  return { id: uuid(), tenantId, plan, status: "active", priceCents: 0, billing: "manual", validFrom: today, validUntil: null, maxEmployees: max[plan], features: ["pdf_statements", "chef_portal"], note: null, ...NO_CONDITION };
}

const NO_CONDITION = { employeePriceCents: null, freeOfCharge: false, conditionNote: null, conditionValidFrom: null, conditionValidUntil: null } as const;

/** Months used by the seed (exported for tests / UI defaults). */
export function demoMonths(now = new Date()): { current: ISOMonth; previous: ISOMonth } {
  const current = monthOf(localISODate(now));
  return { current, previous: shiftMonth(current, -1) };
}

export { localISODate };

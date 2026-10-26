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
 */
import type {
  AuditEvent, Branding, CompanyContact, Employee, ISODate, ISOMonth, License, LicensePlan, MonthAllocation,
  MonthlyStatement, Tenant, TenantRole, TenantSettings, TimeEntry, UUID, WorkAccountPolicy,
} from "../core/types";
import { activeShifts, addDays, findOverlapAcrossDays, isRealDate, isValidEntry, isValidMonth, parseClock } from "../core/time";
import { UWE_BREAK_POLICY, evaluateDay, issueForDay } from "../core/breaks";
import { UWE_WORK_ACCOUNT_POLICY, summarizeMonth, validateAllocation } from "../core/workAccount";
import {
  AccessDeniedError, ConflictError,
  type NewTimeEntry, type Repository, type Session, type TenantOverview,
} from "./repository";

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
export const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];

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
}

/** Demo-only extensions used by the start page, admin portal and tests. */
export interface DemoRepository extends Repository {
  /** Discards all changes and re-seeds the demo data. */
  resetDemoData(): void;
  /** Platform-level audit (tenant / licence changes) – super_admin / support only. */
  listPlatformAudit(limit?: number): Promise<AuditEvent[]>;
  /** Support access granted by the tenant owner (time-limited). */
  getSupportGrant(tenantId: UUID): Promise<SupportGrant | null>;
  /** Owner/manager grants (hours > 0) or revokes (0) platform support access. */
  setSupportGrant(tenantId: UUID, hours: number): Promise<SupportGrant | null>;
}

export interface DemoOptions {
  /** Storage key for the session – each app area keeps its own login. */
  sessionKey?: string;
  /** Reference date for seeding (tests). */
  now?: Date;
}

// ------------------------------------------------------------------ helpers

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
  if (!ALLOWED_LOGO_TYPES.includes(m[1]!)) throw new Error("Erlaubte Formate: PNG, JPG, SVG oder WebP.");
  const bytes = Math.floor(((url.length - m[0].length) * 3) / 4);
  if (bytes > MAX_LOGO_BYTES) throw new Error(`Das Logo ist zu groß (max. ${Math.round(MAX_LOGO_BYTES / 1024)} KB).`);
}

// ------------------------------------------------------------------ seed

const GENERIC_BREAK_POLICY = UWE_BREAK_POLICY;

function defaultSettings(): TenantSettings {
  return {
    breakPolicy: clone(GENERIC_BREAK_POLICY),
    workAccount: { enabled: false, model: "calendar-year", openingMinutes: 0, federalState: null, startMonth: "2026-01", approvalRequired: true },
  };
}

type Pattern = Array<[string, string, number]>;
// All patterns satisfy the UWE break rules (≥ 6 h → 30 min, ≥ 9 h → 45 min, gaps ≥ 15 min count).
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
        breakPolicy: clone(GENERIC_BREAK_POLICY),
        workAccount: { enabled: true, model: "calendar-year", openingMinutes: 0, federalState: "BE", startMonth: "2026-01", approvalRequired: false },
      },
    },
  ];

  const licenses: License[] = [
    {
      id: "20000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_IDS.kt, plan: "pilot_free", status: "active",
      priceCents: 0, billing: "none", validFrom: "2026-09-01", validUntil: null, maxEmployees: null,
      features: ["work_account", "pdf_statements", "chef_portal"], note: "Pilotkunde – kostenlos, unbefristet, keine Zahlungsdaten.",
    },
    {
      id: "20000000-0000-4000-8000-000000000002", tenantId: DEMO_TENANT_IDS.pflege, plan: "standard", status: "active",
      priceCents: 0, billing: "manual", validFrom: "2026-10-01", validUntil: null, maxEmployees: 25,
      features: ["pdf_statements", "chef_portal"], note: "Demo-Lizenz – Preis noch nicht festgelegt.",
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
    reason: "Beschäftigung beendet (Demo)", createdAt: created,
  });
  audit.push({
    id: uuid(), tenantId: DEMO_TENANT_IDS.kt, actorId: "u-admin", action: "license.created", entity: "license",
    entityId: licenses[0]!.id, before: null, after: clone(licenses[0]), reason: "Pilotkunde angelegt", createdAt: created,
  });
  audit.push({
    id: uuid(), tenantId: DEMO_TENANT_IDS.pflege, actorId: "u-admin", action: "license.created", entity: "license",
    entityId: licenses[1]!.id, before: null, after: clone(licenses[1]), reason: "Demo-Mandant angelegt", createdAt: created,
  });

  return { schema: 1, seededAt: now.toISOString(), tenants, licenses, employees, accounts, entries, allocations, statements, audit, supportGrants: [] };
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
        if (db && db.schema === 1) return db;
      } catch { /* re-seed below */ }
    }
    const db = seedDb(seedNow());
    save(db);
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

  function accountSession(db: DemoDb, acc: Account): Session {
    const emp = acc.employeeId ? db.employees.find((e) => e.id === acc.employeeId) : null;
    return {
      userId: acc.userId, email: acc.email, tenantId: acc.tenantId, employeeId: acc.employeeId,
      role: emp?.role ?? null, platformRole: acc.platformRole,
    };
  }

  function sessionFrom(db: DemoDb): Session {
    const userId = storage.getItem(sessionKey);
    const acc = userId ? db.accounts.find((a) => a.userId === userId) : null;
    if (!acc) throw new AccessDeniedError("Bitte melde dich an.");
    const s = accountSession(db, acc);
    if (s.tenantId) {
      const tenant = db.tenants.find((t) => t.id === s.tenantId);
      const emp = db.employees.find((e) => e.id === s.employeeId);
      if (!tenant || tenant.status === "suspended") throw new AccessDeniedError("Der Firmenzugang ist derzeit gesperrt.");
      if (!emp || emp.status === "deactivated") throw new AccessDeniedError("Dein Zugang wurde deaktiviert.");
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

  const repo: DemoRepository = {
    // ------------------------------------------------ auth
    async signIn(email, password) {
      const db = load();
      const acc = db.accounts.find((a) => a.email === normEmail(email));
      if (!acc || acc.password !== password) throw new Error("E-Mail-Adresse oder Passwort ist falsch.");
      if (acc.tenantId) {
        const tenant = db.tenants.find((t) => t.id === acc.tenantId);
        const emp = db.employees.find((e) => e.id === acc.employeeId);
        if (!tenant || tenant.status === "suspended") throw new AccessDeniedError("Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber.");
        if (!emp || emp.status === "deactivated") throw new AccessDeniedError("Dein Zugang wurde deaktiviert. Bitte wende dich an deinen Arbeitgeber.");
        if (emp.status === "invited") {
          emp.status = "active";
          addAudit(db, accountSession(db, acc), { tenantId: emp.tenantId, action: "employee.activated_by_login", entity: "employee", entityId: emp.id, before: { status: "invited" }, after: { status: "active" }, reason: null });
          save(db);
        }
      }
      storage.setItem(sessionKey, acc.userId);
      return accountSession(db, acc);
    },
    async signOut() {
      storage.removeItem(sessionKey);
    },
    async currentSession() {
      try {
        return sessionFrom(load());
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
        assertManager(s, tenantId);
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
    async updateContact(tenantId, contact: Partial<CompanyContact>) {
      return tx((db, s) => {
        assertManager(s, tenantId);
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
        assertManager(s, tenantId);
        const t = tenantById(db, tenantId);
        const before = clone(t.settings);
        if (settings.breakPolicy) {
          if (s.role !== "owner") throw new AccessDeniedError("Pausenregeln darf nur der Inhaber ändern.");
          t.settings.breakPolicy = settings.breakPolicy;
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
        if (email) db.accounts.push({ userId: `u-${emp.id}`, email, password: DEMO_PASSWORD, tenantId, employeeId: emp.id, platformRole: null });
        addAudit(db, s, { tenantId, action: "employee.invited", entity: "employee", entityId: emp.id, before: null, after: emp, reason: null });
        return emp;
      });
    },
    async updateEmployee(employeeId, patch) {
      return tx((db, s) => {
        const emp = db.employees.find((e) => e.id === employeeId);
        if (!emp) throw new AccessDeniedError();
        assertManager(s, emp.tenantId);
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
        addAudit(db, s, { tenantId: emp.tenantId, action: "employee.updated", entity: "employee", entityId: emp.id, before, after: clone(emp), reason: null });
        return emp;
      });
    },
    async setEmployeeStatus(employeeId, status, reason) {
      return tx((db, s) => {
        const emp = db.employees.find((e) => e.id === employeeId);
        if (!emp) throw new AccessDeniedError();
        assertManager(s, emp.tenantId);
        const r = requireReason(reason);
        if (emp.id === s.employeeId) throw new Error("Du kannst dich nicht selbst deaktivieren.");
        if (emp.role === "owner" && s.role !== "owner") throw new AccessDeniedError();
        if (status === "active") {
          const lic = db.licenses.find((l) => l.tenantId === emp.tenantId);
          const count = db.employees.filter((e) => e.tenantId === emp.tenantId && e.status !== "deactivated").length;
          if (emp.status === "deactivated" && lic?.maxEmployees != null && count >= lic.maxEmployees) throw new Error(`Die Lizenz erlaubt höchstens ${lic.maxEmployees} aktive Mitarbeitende.`);
        }
        const before = { status: emp.status };
        emp.status = status;
        addAudit(db, s, { tenantId: emp.tenantId, action: status === "active" ? "employee.activated" : "employee.deactivated", entity: "employee", entityId: emp.id, before, after: { status }, reason: r });
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
          source: byManager ? "correction" : "app",
        };
        db.entries.push(created);
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
        return db.statements.filter((x) => x.tenantId === tenantId && x.month === month);
      });
    },
    async getStatement(employeeId, month) {
      return read((db, s) => {
        assertEmployeeRead(db, s, employeeId);
        return statementOf(db, employeeId, month);
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

    // ------------------------------------------------ audit
    async listAudit(tenantId, limit = 200) {
      return read((db, s) => {
        let events = db.audit.filter((e) => e.tenantId === tenantId);
        if (s.platformRole && !s.tenantId) {
          // Operators only see platform-level events (tenant/licence), never personal time data.
          events = events.filter((e) => e.entity === "license" || e.action.startsWith("tenant.status"));
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
          .filter((e) => e.entity === "license" || e.action.startsWith("tenant.status") || e.action === "tenant.created" || e.entity === "support_grant")
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
        db.licenses.push(license);
        const owner: Employee = { id: uuid(), tenantId: tenant.id, personnelNumber: "1", displayName: "Inhaber/in", email: ownerEmail, role: "owner", status: "invited", createdAt: new Date().toISOString() };
        db.employees.push(owner);
        db.accounts.push({ userId: `u-${owner.id}`, email: ownerEmail, password: DEMO_PASSWORD, tenantId: tenant.id, employeeId: owner.id, platformRole: null });
        addAudit(db, s, { tenantId: tenant.id, action: "tenant.created", entity: "tenant", entityId: tenant.id, before: null, after: { name, slug, isDemo: input.isDemo }, reason: null });
        addAudit(db, s, { tenantId: tenant.id, action: "license.created", entity: "license", entityId: license.id, before: null, after: license, reason: null });
        return overview(db, tenant);
      });
    },
    async setTenantStatus(tenantId, status, reason) {
      return tx((db, s) => {
        assertPlatform(s, true);
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
        addAudit(db, s, { tenantId, action: "license.updated", entity: "license", entityId: lic.id, before, after: clone(lic), reason: null });
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

    resetDemoData() {
      save(seedDb(new Date()));
    },
  };
  return repo;
}

function licenseFor(tenantId: UUID, plan: LicensePlan): License {
  const today = localISODate(new Date());
  if (plan === "pilot_free") {
    return { id: uuid(), tenantId, plan, status: "active", priceCents: 0, billing: "none", validFrom: today, validUntil: null, maxEmployees: null, features: ["work_account", "pdf_statements", "chef_portal"], note: "Pilotkunde – kostenlos, unbefristet, keine Zahlungsdaten." };
  }
  const max: Record<Exclude<LicensePlan, "pilot_free">, number | null> = { standard: 25, business: 100, enterprise: null };
  // Prices are a business decision and intentionally not set (priceCents 0 + note).
  return { id: uuid(), tenantId, plan, status: "active", priceCents: 0, billing: "manual", validFrom: today, validUntil: null, maxEmployees: max[plan], features: ["pdf_statements", "chef_portal"], note: "Preis noch nicht festgelegt." };
}

/** Months used by the seed (exported for tests / UI defaults). */
export function demoMonths(now = new Date()): { current: ISOMonth; previous: ISOMonth } {
  const current = monthOf(localISODate(now));
  return { current, previous: shiftMonth(current, -1) };
}

export { localISODate };

/**
 * Systematic tenant-isolation test over the HTTP API.
 *
 * The list of routes is read from the router itself (createApp → routes), so
 * every new route is covered automatically: a route without an entry in
 * ROUTE_RULES fails the test "every route has a rule" until someone decides
 * who may call it.
 *
 * Victim: tenant A (resources of employee "Sam Probe", emp1A). Attackers:
 *   ownerB / empB   – owner and employee of another tenant
 *   emp2A           – colleague in the same tenant (plain employee)
 *   managerA        – leadership of tenant A (no owner rights)
 *   support         – platform support WITHOUT a support grant
 *
 * For every route and attacker that is not explicitly allowed the request
 * must be refused (403/404) and the response must not contain any personal
 * marker of tenant A. Allowed GET routes are called too and checked for
 * markers the attacker must not see (e.g. a colleague's name). Finally the
 * data of tenant A must be unchanged (hash over all tenant tables).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

type Attacker = "ownerB" | "empB" | "emp2A" | "managerA" | "support";
const ATTACKERS: Attacker[] = ["ownerB", "empB", "emp2A", "managerA", "support"];

type Scope = "public" | "self" | "tenant";
interface Rule {
  scope: Scope;
  /** Attackers that may legitimately call this route on tenant A's resource (not checked for 403). */
  allowed?: Attacker[];
  query?: string;
  body?: unknown;
  /** Path parameter overrides for this route. */
  params?: Record<string, string>;
}

const A = IDS.tenantA;
const E = IDS.employees;
const ENTRY = "demo-a03-20261001";
const SECRET_REASON = "Vertraulicher Grund Sam-Probe-4711";

/**
 * Who may call which route (besides owner of tenant A, the person themself and super-admins, which are
 * not attackers here). Key: "METHOD pattern" exactly as registered.
 */
const ROUTE_RULES: Record<string, Rule> = {
  // ---------------------------------------------------------------- public / own account
  "GET /api/health": { scope: "public" },
  "GET /api/public/tenants/:slug/branding": { scope: "public" },
  "POST /api/auth/login": { scope: "self" },
  "POST /api/auth/2fa/verify": { scope: "self" },
  "GET /api/auth/2fa": { scope: "self" },
  "POST /api/auth/2fa/setup": { scope: "self" },
  "POST /api/auth/2fa/setup/confirm": { scope: "self" },
  "POST /api/auth/2fa/disable": { scope: "self" },
  "POST /api/auth/2fa/recovery-codes": { scope: "self" },
  "POST /api/auth/logout": { scope: "self" },
  "GET /api/auth/session": { scope: "self" },
  "POST /api/auth/password-reset": { scope: "self" },
  "POST /api/auth/password-reset/confirm": { scope: "self" },
  "POST /api/auth/invitation/accept": { scope: "self" },

  // ---------------------------------------------------------------- tenant profile
  "GET /api/tenants/:tenantId": { scope: "tenant", allowed: ["emp2A", "managerA", "support"] },
  "PATCH /api/tenants/:tenantId/branding": { scope: "tenant", body: { slogan: "Fremdzugriff" } },
  "PATCH /api/tenants/:tenantId/contact": { scope: "tenant", body: { city: "Fremdstadt" } },
  "PATCH /api/tenants/:tenantId/name": { scope: "tenant", body: { name: "Fremdfirma GmbH" } },
  "PATCH /api/tenants/:tenantId/settings": { scope: "tenant", body: { breakPolicy: { maxShiftMinutes: 600 } } },
  "PUT /api/tenants/:tenantId/two-factor-policy": { scope: "tenant", body: { requireTwoFactorForManagers: false } },
  "GET /api/tenants/:tenantId/support-grant": { scope: "tenant", allowed: ["managerA", "support"] },
  "PUT /api/tenants/:tenantId/support-grant": { scope: "tenant", body: { hours: 2, reason: "Fremdzugriff Test" } },

  // ---------------------------------------------------------------- employees
  "GET /api/tenants/:tenantId/employees": { scope: "tenant", allowed: ["emp2A", "managerA"] },
  "POST /api/tenants/:tenantId/employees": {
    scope: "tenant", allowed: ["managerA"], body: { displayName: "Fremd", personnelNumber: "X-1", email: null, role: "employee" },
  },
  "POST /api/employees/:employeeId/invitation": { scope: "tenant", allowed: ["managerA"], body: {} },
  "PATCH /api/employees/:employeeId": { scope: "tenant", allowed: ["managerA"], body: { displayName: "Fremd" } },
  "POST /api/employees/:employeeId/status": { scope: "tenant", allowed: ["managerA"], body: { status: "deactivated", reason: "Fremdzugriff" } },

  // ---------------------------------------------------------------- time entries
  "GET /api/employees/:employeeId/time-entries": { scope: "tenant", allowed: ["managerA"], query: "month=2026-10" },
  "GET /api/tenants/:tenantId/time-entries": { scope: "tenant", allowed: ["managerA"], query: "from=2026-09-01&to=2026-10-31" },
  "POST /api/employees/:employeeId/time-entries": {
    scope: "tenant", allowed: ["managerA"], body: { id: "fremd-0001", date: "2026-10-20", start: "08:00", end: "12:00", pauseMinutes: 0, note: "" },
  },
  "PATCH /api/employees/:employeeId/time-entries/:entryId": {
    scope: "tenant", allowed: ["managerA"], body: { patch: { note: "Fremd" }, expectedVersion: 1, reason: "Fremdzugriff" },
  },
  "DELETE /api/employees/:employeeId/time-entries/:entryId": { scope: "tenant", allowed: ["managerA"], body: { expectedVersion: 1, reason: "Fremdzugriff" } },
  "PATCH /api/time-entries/:entryId": { scope: "tenant", allowed: ["managerA"], body: { patch: { note: "Fremd" }, expectedVersion: 1, reason: "Fremdzugriff" } },
  "DELETE /api/time-entries/:entryId": { scope: "tenant", allowed: ["managerA"], body: { expectedVersion: 1, reason: "Fremdzugriff" } },
  "GET /api/employees/:employeeId/time-entries/:entryId/revisions": { scope: "tenant", allowed: ["managerA"] },

  // ---------------------------------------------------------------- work account and statements
  "GET /api/employees/:employeeId/allocations": { scope: "tenant", allowed: ["managerA"] },
  "PUT /api/employees/:employeeId/allocations/:month": { scope: "tenant", allowed: ["managerA"], body: { minutes: 60 } },
  "POST /api/employees/:employeeId/allocations/:month/review": { scope: "tenant", allowed: ["managerA"], body: { decision: "approved" } },
  "GET /api/tenants/:tenantId/statements": { scope: "tenant", allowed: ["managerA"], query: "month=2026-09" },
  "GET /api/employees/:employeeId/statements/:month": { scope: "tenant", allowed: ["managerA"], params: { month: "2026-09" } },
  "POST /api/employees/:employeeId/statements/:month/submit": { scope: "tenant", allowed: ["managerA"], body: {} },
  "POST /api/statements/:statementId/approve": { scope: "tenant", allowed: ["managerA"], body: {} },
  "POST /api/statements/:statementId/return": { scope: "tenant", allowed: ["managerA"], body: { reason: "Fremdzugriff" } },

  // ---------------------------------------------------------------- correction requests (0013)
  "GET /api/tenants/:tenantId/correction-requests": { scope: "tenant", allowed: ["emp2A", "managerA"] },
  // Only the person themself asks for a correction or withdraws it – not even the leadership.
  "POST /api/employees/:employeeId/correction-requests": {
    scope: "tenant", body: { kind: "change", entryId: ENTRY, proposed: { note: "Fremd" }, reason: "Fremdzugriff Test" },
  },
  "POST /api/correction-requests/:requestId/withdraw": { scope: "tenant", body: {} },
  "POST /api/correction-requests/:requestId/decide": { scope: "tenant", allowed: ["managerA"], body: { decision: "rejected", note: "Fremdzugriff" } },

  // ---------------------------------------------------------------- audit
  "GET /api/tenants/:tenantId/audit": { scope: "tenant", allowed: ["managerA", "support"] },
  "GET /api/platform/audit": { scope: "tenant", allowed: ["support"] },

  // ---------------------------------------------------------------- platform administration
  "GET /api/platform/tenants": { scope: "tenant", allowed: ["support"] },
  // Technical status (0015): platform staff only, contains no personal data (checked by the leak markers).
  "GET /api/platform/system": { scope: "tenant", allowed: ["support"] },
  "POST /api/platform/tenants": {
    scope: "tenant", body: { name: "Firma X", slug: "firma-x", plan: "standard", isDemo: true, ownerEmail: "x@firma-x.example" },
  },
  "POST /api/platform/tenants/:tenantId/status": { scope: "tenant", body: { status: "suspended", reason: "Fremdzugriff" } },
  "PUT /api/platform/tenants/:tenantId/license": { scope: "tenant", body: { plan: "enterprise" } },

  // ---------------------------------------------------------------- billing (0012)
  "GET /api/tenants/:tenantId/billing": { scope: "tenant", allowed: ["managerA"], query: "month=2026-10" },
  "GET /api/tenants/:tenantId/billing/history": { scope: "tenant", allowed: ["managerA"] },
  "GET /api/platform/billing/settings": { scope: "tenant", allowed: ["support"] },
  "PUT /api/platform/billing/settings": { scope: "tenant", body: { defaultPriceCents: 1, reason: "Fremdzugriff" } },
  "GET /api/platform/billing": { scope: "tenant", allowed: ["support"], query: "month=2026-10" },
  "PUT /api/platform/tenants/:tenantId/billing/:month": { scope: "tenant", body: { status: "paid" }, params: { month: "2026-09" } },

  // ---------------------------------------------------------------- privacy (0016): only the person or the owner
  "GET /api/employees/:employeeId/data-export": { scope: "tenant" },
  "POST /api/employees/:employeeId/anonymize": { scope: "tenant", body: { confirmPersonnelNumber: "A-101" } },
  "GET /api/tenants/:tenantId/data-export": { scope: "tenant" },
  "PUT /api/tenants/:tenantId/privacy": { scope: "tenant", body: { retentionMonthsAfterExit: 1 } },
};

let t: TestServer;
const cookies: Partial<Record<Attacker, string>> = {};
const values: Record<string, string> = {};

/**
 * Strings of tenant A that an attacker must never receive. Foreign tenants see nothing of A; the
 * colleague nothing of Sam Probe; support (no grant) no personal data – company metadata (name,
 * contact person of the company profile) is visible to platform staff by design.
 */
const SAM = ["Sam Probe", "fahrer1@demo-krankentransporte.example", E.emp1A, "Frühdienst", SECRET_REASON];
const PERSONAL_A = [...SAM, "Jo Demo", "Robin Leitung", "fahrer2@", "leitung@demo-krankentransporte", "Disposition", "Nachtdienst", E.emp2A, E.managerA];
const MARKERS: Record<Attacker, string[]> = {
  ownerB: [...PERSONAL_A, "Alex Beispiel", "Demo Krankentransporte", "@demo-krankentransporte.example", A],
  empB: [...PERSONAL_A, "Alex Beispiel", "Demo Krankentransporte", "@demo-krankentransporte.example", A],
  emp2A: SAM,
  managerA: [],
  support: PERSONAL_A,
};

function leaks(who: Attacker, body: unknown): string[] {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
  return MARKERS[who].filter((m) => text.includes(m));
}

function buildPath(pattern: string, rule: Rule): string {
  const path = pattern.replace(/:([A-Za-z]+)/g, (_m, key: string) => {
    const v = rule.params?.[key] ?? values[key];
    if (v === undefined) throw new Error(`Kein Testwert für den Pfadparameter :${key} (${pattern}) – bitte in values ergänzen.`);
    return encodeURIComponent(v);
  });
  return rule.query ? `${path}?${rule.query}` : path;
}

/** Hash over every row of tenant A (all tables with tenant_id) plus the platform-wide tables. */
async function snapshot(): Promise<Record<string, string>> {
  const tables = (await t.db.admin.query<{ t: string; tenant: boolean }>(
    `select format('%I.%I', c.table_schema, c.table_name) as t,
            bool_or(c.column_name = 'tenant_id') as tenant
       from information_schema.columns c
       join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
      where c.table_schema in ('public', 'auth')
      group by 1 order by 1`)).rows;
  const out: Record<string, string> = {};
  for (const { t: name, tenant } of tables) {
    // Sessions and 2FA state of the attackers change by signing in – not tenant data.
    if (["auth.sessions", "auth.two_factor_challenges", "auth.totp_factors", "auth.totp_recovery_codes"].includes(name)) continue;
    const where = tenant ? `where x.tenant_id = '${A}'` : "";
    const r = await t.db.admin.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h, count(*)::int as n from ${name} x ${where}`);
    out[name] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}

beforeAll(async () => {
  t = await startTestServer();
  values.tenantId = A;
  values.employeeId = E.emp1A;
  values.entryId = ENTRY;
  values.month = "2026-10";
  values.slug = "demo-krankentransporte";
  values.statementId = (await t.db.admin.query("select id from public.monthly_statements where employee_id = $1 and month = '2026-09'", [E.emp1A])).rows[0].id;
  const sam = await t.login("emp1A");
  const req = await t.call("POST", `/api/employees/${E.emp1A}/correction-requests`, {
    cookie: sam, body: { kind: "change", entryId: "demo-a03-20261005", proposed: { note: "Nachtdienst korrigiert" }, reason: SECRET_REASON },
  });
  expect(req.status).toBe(201);
  values.requestId = req.body.id;
  for (const who of ATTACKERS) cookies[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
});

describe("route table", () => {
  it("every registered route has a rule (new routes must be classified here)", () => {
    const missing = t.routes.map((r) => `${r.method} ${r.pattern}`).filter((k) => !ROUTE_RULES[k]);
    expect(missing).toEqual([]);
  });

  it("no stale rules (every rule belongs to a registered route)", () => {
    const registered = new Set(t.routes.map((r) => `${r.method} ${r.pattern}`));
    expect(Object.keys(ROUTE_RULES).filter((k) => !registered.has(k))).toEqual([]);
  });

  it("covers a meaningful number of tenant routes", () => {
    expect(t.routes.filter((r) => ROUTE_RULES[`${r.method} ${r.pattern}`]?.scope === "tenant").length).toBeGreaterThanOrEqual(48);
  });
});

describe("every route, every attacker", () => {
  it("allowed read routes and own-account routes leak nothing the caller must not see", async () => {
    const problems: string[] = [];
    for (const route of t.routes) {
      const rule = ROUTE_RULES[`${route.method} ${route.pattern}`];
      if (!rule || route.method !== "GET" || rule.scope === "public") continue;
      for (const who of ATTACKERS) {
        if (rule.scope === "tenant" && !rule.allowed?.includes(who)) continue;
        const r = await t.call("GET", buildPath(route.pattern, rule), { cookie: cookies[who] });
        if (r.status >= 500) problems.push(`${who}: GET ${route.pattern} → ${r.status}`);
        const l = leaks(who, r.body);
        if (l.length) problems.push(`${who}: GET ${route.pattern} enthält ${l.join(", ")}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("all other tenant routes are refused (403/404) without data of tenant A, and nothing changes", async () => {
    const before = await snapshot();
    const problems: string[] = [];
    let calls = 0;
    for (const route of t.routes) {
      const rule = ROUTE_RULES[`${route.method} ${route.pattern}`];
      if (!rule || rule.scope !== "tenant") continue;
      for (const who of ATTACKERS) {
        if (rule.allowed?.includes(who)) continue;
        const r = await t.call(route.method, buildPath(route.pattern, rule), { cookie: cookies[who], body: rule.body });
        calls++;
        if (r.status !== 403 && r.status !== 404) problems.push(`${who}: ${route.method} ${route.pattern} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
        const l = leaks(who, r.body);
        if (l.length) problems.push(`${who}: ${route.method} ${route.pattern} enthält ${l.join(", ")}`);
      }
    }
    expect(problems).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(150);
    expect(await snapshot()).toEqual(before);
  });

  it("the attackers' sessions are still valid (refusals are not caused by a lost session)", async () => {
    for (const who of ATTACKERS) {
      const s = await t.call("GET", "/api/auth/session", { cookie: cookies[who] });
      expect(s.status).toBe(200);
      expect(s.body?.userId).toBeTruthy();
    }
  });

  it("without a session every tenant route answers 401", async () => {
    const problems: string[] = [];
    for (const route of t.routes) {
      const rule = ROUTE_RULES[`${route.method} ${route.pattern}`];
      if (!rule || rule.scope !== "tenant") continue;
      const r = await t.call(route.method, buildPath(route.pattern, rule), { body: rule.body });
      if (r.status !== 401) problems.push(`${route.method} ${route.pattern} → ${r.status}`);
    }
    expect(problems).toEqual([]);
  });
});

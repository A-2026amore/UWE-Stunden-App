/**
 * Operator command invite-link (QA 2026-10-28, finding B1): invitation link
 * without e-mail, printed only on the console. Runs the CLI exactly as
 * documented (node + type stripping + resolve hook) against the test database
 * and accepts the link through the real API.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOperatorInvitation, inviteLinkBase, oneTimeLink } from "../../server/src/operator.ts";
import { pgError } from "../db/support/harness.ts";
import { EMAILS, IDS, ORIGIN, startTestServer, type TestServer } from "./support/server.ts";

const ROOT = resolve(__dirname, "../..");
const SLUG_A = "demo-krankentransporte";
const SLUG_B = "muster-pflegedienst";
const LINK_RE = new RegExp(`^${ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/einladung#token=([0-9a-f]{64})$`, "m");

let t: TestServer;
let dbUrl = "";

beforeAll(async () => {
  t = await startTestServer();
  const a = t.db.admin as unknown as { host: string; port: number; database: string };
  dbUrl = `postgres://app_api:nur-fuer-tests@${a.host}:${a.port}/${a.database}`;
});
afterAll(async () => {
  await t?.close();
});

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", "./server/register.mjs",
    "server/src/cli.ts", ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, DATABASE_URL: dbUrl, PUBLIC_ORIGIN: ORIGIN, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tokenOf(stdout: string): string {
  const m = LINK_RE.exec(stdout);
  if (!m) throw new Error(`no invitation link in: ${stdout}`);
  return m[1]!;
}

describe("cli.ts invite-link", () => {
  it("creates an owner invitation for a new address; the printed link activates the account via the API", async () => {
    const r = cli(["invite-link", SLUG_A, "Neue.Chefin@Demo-Krankentransporte.example", "owner", "--name=Nora Neu"]);
    expect(r.stderr).not.toMatch(/token=/);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Rolle: owner (neuer Zugang angelegt)");
    const token = tokenOf(r.stdout);
    // Only the hash is stored; no mail was sent.
    const tok = (await t.db.admin.query("select token_hash from auth.one_time_tokens where email = 'neue.chefin@demo-krankentransporte.example'")).rows;
    expect(tok).toHaveLength(1);
    expect(JSON.stringify(tok)).not.toContain(token);
    expect(t.mails.some((m) => m.to.includes("neue.chefin"))).toBe(false);
    const emp = (await t.db.admin.query("select display_name, role, status, personnel_number from public.employees where email = 'neue.chefin@demo-krankentransporte.example'")).rows[0];
    expect(emp).toMatchObject({ display_name: "Nora Neu", role: "owner", status: "invited" });
    expect(emp.personnel_number).toMatch(/^CLI-[0-9A-F]{10}$/);

    const accept = await t.call("POST", "/api/auth/invitation/accept", { body: { token, password: "Cli-Einladung-Passwort-1" } });
    expect(accept.status).toBe(200);
    expect(accept.body.existingAccount).toBe(false);
    const login = await t.call("POST", "/api/auth/login", { body: { email: "neue.chefin@demo-krankentransporte.example", password: "Cli-Einladung-Passwort-1" } });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ tenantId: IDS.tenantA, role: "owner" });

    // The rows written by the CLI (insert of employee and invitation) carry the operator reason.
    // Select them explicitly: accepting the invitation above writes a later "invitation.update"
    // row (accepted_at) without a reason, so "latest invitation row" would be the wrong one.
    const audit = (await t.db.admin.query(
      `select action, actor_id, reason from public.audit_log
        where tenant_id = $1 and action in ('employee.insert', 'invitation.insert')
          and after ->> 'email' = 'neue.chefin@demo-krankentransporte.example'
        order by action`, [IDS.tenantA])).rows;
    expect(audit).toEqual([
      { action: "employee.insert", actor_id: null, reason: "Einladung über Betreiberbefehl (CLI)" },
      { action: "invitation.insert", actor_id: null, reason: "Einladung über Betreiberbefehl (CLI)" },
    ]);
  });

  it("renews an existing open invitation (seeded invitedB): the old link stops working", async () => {
    const r = cli(["invite-link", SLUG_B, EMAILS.invitedB, "employee", "--days=2"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("bestehende Einladung erneuert");
    const token = tokenOf(r.stdout);
    const old = await t.call("POST", "/api/auth/invitation/accept", { body: { token: IDS.invitationTokenB, password: "Altes-Link-Passwort-1" } });
    expect(old.status).toBe(400);
    const ok = await t.call("POST", "/api/auth/invitation/accept", { body: { token, password: "Neues-Link-Passwort-1" } });
    expect(ok.status).toBe(200);
    const emp = (await t.db.admin.query("select status, user_id is not null as linked from public.employees where id = $1", [IDS.employees.invitedB])).rows[0];
    expect(emp).toEqual({ status: "active", linked: true });
    const inv = (await t.db.admin.query("select expires_at - created_at < interval '3 days' as short from public.invitations where employee_id = $1 and accepted_at is not null", [IDS.employees.invitedB])).rows[0];
    expect(inv.short).toBe(true);
  });

  it("refuses already linked accounts, a different role, unknown tenants and invalid input – without printing a link", async () => {
    const cases: Array<[string[], number, RegExp]> = [
      [["invite-link", SLUG_A, EMAILS.emp1A, "employee"], 1, /bereits einen aktiven oder deaktivierten Zugang/],
      [["invite-link", "gibt-es-nicht", "x@beispiel.example", "employee"], 1, /Mandant nicht gefunden/],
      [["invite-link", SLUG_A, "keine-adresse", "employee"], 1, /Ungültige E-Mail-Adresse/],
      [["invite-link", SLUG_A, "x@beispiel.example", "super_admin"], 2, /Unbekannte Rolle/],
      [["invite-link", SLUG_A, "x@beispiel.example", "employee", "--days=31"], 2, /zwischen 1 und 30/],
      [["invite-link", SLUG_A, "x@beispiel.example"], 2, /Aufruf/],
    ];
    for (const [args, status, message] of cases) {
      const r = cli(args);
      expect(`${args.join(" ")} → ${r.status}`).toBe(`${args.join(" ")} → ${status}`);
      expect(r.stderr).toMatch(message);
      expect(r.stdout).not.toMatch(/#token=/);
    }
    // Open invitation with another role → refused (no silent role change).
    expect(cli(["invite-link", SLUG_A, "rolle@beispiel.example", "employee"]).status).toBe(0);
    const other = cli(["invite-link", SLUG_A, "rolle@beispiel.example", "manager"]);
    expect(other.status).toBe(1);
    expect(other.stderr).toMatch(/bereits eine Einladung mit der Rolle employee/);
  });

  it("production without PUBLIC_ORIGIN or with http:// refuses before touching the database", () => {
    const missing = cli(["invite-link", SLUG_A, "y@beispiel.example", "employee"], { NODE_ENV: "production", PUBLIC_ORIGIN: "" });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/PUBLIC_ORIGIN fehlt/);
    expect(() => inviteLinkBase({ NODE_ENV: "production", PUBLIC_ORIGIN: "http://zeit.example" })).toThrow(/https/);
    expect(inviteLinkBase({ PUBLIC_ORIGIN: "https://a.example/pfad, https://b.example", INVITE_LINK_PATH: "/app/einladung" }))
      .toEqual({ origin: "https://a.example", path: "/app/einladung" });
    expect(oneTimeLink("https://a.example", "/einladung", "ab/c")).toBe("https://a.example/einladung#token=ab%2Fc");
  });
});

describe("auth.operator_create_invitation (database boundary)", () => {
  it("is executable only by app_auth – not by signed-in users or anonymous requests", async () => {
    for (const [user, role] of [[IDS.users.superAdmin, "app_user"], [IDS.users.ownerA, "app_user"], [null, "app_anon"]] as const) {
      const e = await pgError(t.db.as(user, (q) => q.query(
        "select auth.operator_create_invitation('demo-krankentransporte', 'z@beispiel.example', 'owner', null, 7)"), { role }));
      expect(e.code).toBe("42501");
    }
  });

  it("the helper returns the invitation data (used by the CLI)", async () => {
    const inv = await createOperatorInvitation(t.pool, { tenantSlug: SLUG_A, email: "helfer@beispiel.example", role: "manager" });
    expect(inv).toMatchObject({ tenantStatus: "active", role: "manager", createdEmployee: true });
    expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

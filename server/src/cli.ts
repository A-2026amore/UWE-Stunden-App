/**
 * Operator commands (run on the server, never exposed via HTTP):
 *
 *   node --import ./server/register.mjs server/src/cli.ts set-password <email>
 *
 * Reads the new password from stdin (one line) and sets it through the
 * regular reset functions (auth.create_password_reset + auth.reset_password).
 * All sessions of that user are ended. Uses DATABASE_URL (role app_api).
 *
 *   node --import ./server/register.mjs server/src/cli.ts invite-link <tenant-slug> <email> <role> [--days=N] [--name=…]
 *
 * Creates (or renews) an invitation without e-mail and prints the link ONLY on
 * this console (stdout) – for operation without SMTP. The link is not logged
 * and no API route returns it. Uses DATABASE_URL and PUBLIC_ORIGIN /
 * INVITE_LINK_PATH like the API.
 *
 *   node --import ./server/register.mjs server/src/cli.ts seed-test-env --confirm-test-environment [--domain=…] [--admin-email=…]
 *
 * Test environment only: fictitious test companies with random passwords, printed
 * ONLY on this console (server/src/testenv.ts). Uses MIGRATION_DATABASE_URL (owner).
 *
 *   node --import ./server/register.mjs server/src/cli.ts export-tenant <tenant-slug> --out <directory>
 *   node --import ./server/register.mjs server/src/cli.ts delete-tenant <tenant-slug> --confirm <tenant-slug> (--after-export <directory> | --without-export)
 *
 * End of contract (migration 0020, server/src/offboarding.ts): complete export of
 * a tenant in any status (JSON + CSV + checksums) and deletion of a deactivated
 * tenant in one transaction. Both are audited. Uses MIGRATION_DATABASE_URL (owner).
 */
import { createInterface } from "node:readline";
import { passwordProblem, setPasswordViaReset } from "./auth.ts";
import { createPool } from "./db.ts";
import { TestEnvRefused, formatAccounts, seedTestEnvironment } from "./testenv.ts";
import { OffboardingRefused, deleteTenant, exportTenant } from "./offboarding.ts";
import { INVITE_ROLES, createOperatorInvitation, inviteLinkBase, oneTimeLink, type InviteRole } from "./operator.ts";
import { loadConfig } from "./config.ts";
import { createMailer, type Mail } from "./mailer.ts";
import { runBillingJobs } from "./subscription.ts";

const USAGE = [
  "Aufruf:",
  "  cli.ts set-password <email>                                   (Passwort über stdin)",
  "  cli.ts invite-link <mandant-kurzname> <email> <employee|manager|owner> [--days=1..30] [--name=Anzeigename]",
  "  cli.ts seed-test-env --confirm-test-environment [--domain=stunden-test.example] [--admin-email=…]   (nur Testumgebung)",
  "  cli.ts export-tenant <mandant-kurzname> --out <verzeichnis>                     (Vertragsende: Gesamtexport)",
  "  cli.ts delete-tenant <mandant-kurzname> --confirm <mandant-kurzname> (--after-export <verzeichnis> | --without-export)",
  "  cli.ts billing-jobs                                            (Tarif-Erinnerungen und Monatsrechnungen einmal ausführen)",
].join("\n");

async function readLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return "";
}

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL fehlt.");
    process.exit(2);
  }
  return url;
}

async function setPassword(args: string[]) {
  const [email] = args;
  if (!email || args.length !== 1) usage();
  const url = databaseUrl();
  const password = await readLine();
  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  const pool = createPool(url, 1);
  try {
    const ok = await setPasswordViaReset(pool, email.trim().toLowerCase(), password);
    console.log(ok ? "Passwort gesetzt, alle Sitzungen beendet." : "Kein aktives Konto mit dieser E-Mail-Adresse.");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

async function inviteLink(args: string[]) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const options = args.filter((a) => a.startsWith("--"));
  const [slug, email, role] = positional;
  if (!slug || !email || !role || positional.length !== 3) usage();
  if (!(INVITE_ROLES as readonly string[]).includes(role)) {
    console.error(`Unbekannte Rolle "${role}". Erlaubt: ${INVITE_ROLES.join(", ")}.`);
    process.exit(2);
  }
  let validDays = 7;
  let displayName: string | null = null;
  for (const o of options) {
    const days = /^--days=(\d{1,2})$/.exec(o);
    const name = /^--name=(.{1,120})$/s.exec(o);
    if (days) validDays = Number(days[1]);
    else if (name) displayName = name[1]!;
    else usage();
  }
  if (validDays < 1 || validDays > 30) {
    console.error("--days muss zwischen 1 und 30 liegen.");
    process.exit(2);
  }
  let base: { origin: string; path: string };
  try {
    base = inviteLinkBase(process.env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const pool = createPool(databaseUrl(), 1);
  try {
    const inv = await createOperatorInvitation(pool, { tenantSlug: slug, email, role: role as InviteRole, displayName, validDays });
    console.log(`Mandant: ${inv.tenantName}${inv.tenantStatus === "active" ? "" : ` (Status: ${inv.tenantStatus} – Anmeldung erst nach Freischaltung möglich)`}`);
    console.log(`Rolle: ${inv.role}${inv.createdEmployee ? " (neuer Zugang angelegt)" : " (bestehende Einladung erneuert)"}`);
    console.log(`Gültig bis: ${new Date(inv.expiresAt).toISOString()}`);
    console.log("Einladungslink (nur persönlich weitergeben, nicht speichern; ältere Links dieser Person sind ungültig):");
    console.log(oneTimeLink(base.origin, base.path, inv.token));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    // Expected business errors (German text from the database) – never contains a token.
    if (err.code && ["22023", "55000", "P0002", "23514", "23505"].includes(err.code)) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      throw e;
    }
  } finally {
    await pool.end();
  }
}

async function seedTestEnv(args: string[]) {
  let confirmed = false;
  let domain: string | undefined;
  let adminEmail: string | undefined;
  for (const a of args) {
    const d = /^--domain=(.+)$/.exec(a);
    const m = /^--admin-email=(.+)$/.exec(a);
    if (a === "--confirm-test-environment") confirmed = true;
    else if (d) domain = d[1];
    else if (m) adminEmail = m[1];
    else usage();
  }
  if (!confirmed) {
    console.error("Nur für die Testumgebung: bitte mit --confirm-test-environment bestätigen.");
    process.exit(2);
  }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error("MIGRATION_DATABASE_URL fehlt (Eigentümer der Datenbank, wie beim Migrationsjob).");
    process.exit(2);
  }
  try {
    const accounts = await seedTestEnvironment({ url, domain, adminEmail });
    console.log("Testzugänge angelegt. Passwörter erscheinen nur hier – jetzt sicher übergeben (z. B. Passwort-Manager), nicht in Dateien speichern.");
    console.log("Der Super-Admin muss bei der ersten Anmeldung die Zwei-Faktor-Anmeldung einrichten.\n");
    console.log(formatAccounts(accounts));
  } catch (e) {
    if (e instanceof TestEnvRefused) {
      console.error(e.message);
      process.exitCode = 1;
    } else {
      throw e;
    }
  }
}

function ownerUrl(): string {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error("MIGRATION_DATABASE_URL fehlt (Eigentümer der Datenbank, wie beim Migrationsjob).");
    process.exit(2);
  }
  return url;
}

/** "--name value" options; every option must be known and appear at most once. */
function parseOptions(args: string[], withValue: string[], flags: string[]): { positional: string[]; opts: Map<string, string | true> } {
  const positional: string[] = [];
  const opts = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (opts.has(name)) usage();
    if (flags.includes(name) && eq < 0) opts.set(name, true);
    else if (withValue.includes(name)) {
      const value = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (!value || value.startsWith("--")) usage();
      opts.set(name, value);
    } else usage();
  }
  return { positional, opts };
}

async function runRefusable(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof OffboardingRefused) {
      console.error(e.message);
      process.exitCode = 1;
    } else {
      throw e;
    }
  }
}

async function exportTenantCmd(args: string[]) {
  const { positional, opts } = parseOptions(args, ["--out"], []);
  const out = opts.get("--out");
  if (positional.length !== 1 || typeof out !== "string") usage();
  const url = ownerUrl();
  await runRefusable(async () => {
    const r = await exportTenant(url, positional[0]!, out);
    console.log(`Mandant: ${r.tenantName} (Status: ${r.tenantStatus})`);
    console.log(`Exportiert: ${r.employees} Personen, ${r.timeEntries} Zeiteinträge`);
    console.log(`Verzeichnis: ${r.dir} (firmendaten.json, arbeitszeiten.csv, SHA256SUMS)`);
    console.log(`SHA-256 firmendaten.json: ${r.sha256}`);
    console.log("Enthält personenbezogene Daten: nur verschlüsselt übergeben und nach der Übergabe vom Server löschen.");
  });
}

async function deleteTenantCmd(args: string[]) {
  const { positional, opts } = parseOptions(args, ["--confirm", "--after-export"], ["--without-export"]);
  const confirm = opts.get("--confirm");
  const after = opts.get("--after-export");
  if (positional.length !== 1 || typeof confirm !== "string") usage();
  const url = ownerUrl();
  await runRefusable(async () => {
    const r = await deleteTenant(url, {
      slug: positional[0]!, confirm,
      afterExport: typeof after === "string" ? after : null,
      withoutExport: opts.get("--without-export") === true,
    });
    console.log(`Mandant ${r.tenantId} gelöscht.`);
    for (const [table, n] of Object.entries(r.deletedRows).sort()) console.log(`  gelöscht ${table}: ${n}`);
    for (const [table, n] of Object.entries(r.retainedRows).sort()) console.log(`  aufbewahrt ${table}: ${n}`);
    console.log(r.tenantRow === "tombstone"
      ? "Mandantenzeile bleibt anonymisiert für aufbewahrte Rechnungsunterlagen der Plattform."
      : "Mandantenzeile gelöscht.");
  });
}

/** Runs the hourly billing job once (reminders, monthly invoices) with the server configuration. */
async function billingJobsCmd(args: string[]) {
  if (args.length) usage();
  const config = loadConfig();
  const mailer = createMailer(config.smtp, config.production);
  const pool = createPool(config.databaseUrl, 1);
  const pending: Promise<void>[] = [];
  try {
    const r = await runBillingJobs(pool, (mails: Mail[]) => { for (const m of mails) pending.push(mailer.send(m)); });
    await Promise.allSettled(pending);
    console.log(`Erinnerungen versendet: ${r.reminders}`);
    console.log(`Rechnungen erzeugt: ${r.invoices.issued.length}${r.invoices.issued.length ? ` (${r.invoices.issued.map((i) => i.number).join(", ")})` : ""}`);
    for (const p of r.invoices.problems) console.log(`Nicht erzeugt (${p.month}, Mandant ${p.tenantId}): ${p.problem}`);
  } finally {
    await pool.end();
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "set-password") await setPassword(args);
  else if (cmd === "invite-link") await inviteLink(args);
  else if (cmd === "seed-test-env") await seedTestEnv(args);
  else if (cmd === "export-tenant") await exportTenantCmd(args);
  else if (cmd === "delete-tenant") await deleteTenantCmd(args);
  else if (cmd === "billing-jobs") await billingJobsCmd(args);
  else usage();
}

void main();

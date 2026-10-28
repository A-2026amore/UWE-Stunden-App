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
 */
import { createInterface } from "node:readline";
import { passwordProblem, setPasswordViaReset } from "./auth.ts";
import { createPool } from "./db.ts";
import { INVITE_ROLES, createOperatorInvitation, inviteLinkBase, oneTimeLink, type InviteRole } from "./operator.ts";

const USAGE = [
  "Aufruf:",
  "  cli.ts set-password <email>                                   (Passwort über stdin)",
  "  cli.ts invite-link <mandant-kurzname> <email> <employee|manager|owner> [--days=1..30] [--name=Anzeigename]",
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

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "set-password") await setPassword(args);
  else if (cmd === "invite-link") await inviteLink(args);
  else usage();
}

void main();

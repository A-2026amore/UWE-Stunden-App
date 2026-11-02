/**
 * Operator command create-super-admin (cli.ts): the first platform account of a fresh installation.
 * Creates the user with the given password and the platform role super_admin in one transaction
 * (owner connection, MIGRATION_DATABASE_URL). Refuses when the e-mail address already has an account.
 * Two-factor sign-in is mandatory for platform accounts and is set up at the first sign-in.
 */
import pg from "pg";
import { hashPassword, passwordProblem } from "./auth.ts";

export class SuperAdminRefused extends Error {}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createSuperAdmin(ownerUrl: string, rawEmail: string, password: string): Promise<{ userId: string; email: string }> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new SuperAdminRefused("Bitte eine gültige E-Mail-Adresse angeben.");
  const problem = passwordProblem(password);
  if (problem) throw new SuperAdminRefused(problem);
  const hash = await hashPassword(password);
  const c = new pg.Client({ connectionString: ownerUrl, application_name: "zeiterfassung-cli" });
  await c.connect();
  try {
    await c.query("begin");
    const taken = await c.query("select 1 from auth.users where email = $1", [email]);
    if (taken.rowCount) throw new SuperAdminRefused(`Für ${email} gibt es schon ein Konto – nichts verändert.`);
    const u = await c.query<{ id: string }>("insert into auth.users (email, password_hash) values ($1, $2) returning id", [email, hash]);
    const userId = String(u.rows[0]!.id);
    await c.query("insert into public.platform_admins (user_id, role) values ($1, 'super_admin')", [userId]);
    await c.query("commit");
    return { userId, email };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

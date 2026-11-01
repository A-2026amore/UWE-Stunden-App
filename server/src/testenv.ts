/**
 * Test environment accounts (stunden-test.appzentrale24.de, deploy/README.md):
 *
 *   node --import ./server/register.mjs server/src/cli.ts seed-test-env --confirm-test-environment
 *        [--domain=stunden-test.example] [--admin-email=…]
 *
 * Creates fictitious test companies – one free (pilot_free) and one paying (standard,
 * default price per billable employee) – each with owner, manager and three employees,
 * plus a super-admin (2FA is mandatory for platform staff: set up at the first login).
 * Random passwords are returned to the caller, which prints them ONLY on the console;
 * they are never written to files, logs or the repository.
 *
 * Safety: connects as database owner (MIGRATION_DATABASE_URL), runs in one transaction
 * and refuses
 *  - without --confirm-test-environment,
 *  - when any tenant that is not marked as demo/test exists (real customer data),
 *  - when the test companies or the admin address already exist (no overwriting;
 *    renew a password with `cli.ts set-password`).
 * All created tenants are marked is_demo (shown as test/demo in the admin area).
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { hashPassword } from "./auth.ts";

export interface TestAccount {
  company: string;
  role: "super_admin" | "owner" | "manager" | "employee";
  name: string;
  email: string;
  password: string;
}

export interface SeedTestEnvOptions {
  url: string;
  domain?: string;
  adminEmail?: string;
}

export const TEST_COMPANIES = [
  { slug: "test-gratis", key: "gratis", name: "Testfirma Gratis (Test)", plan: "pilot_free", prefix: "G" },
  { slug: "test-zahlend", key: "zahlend", name: "Testfirma Zahlend (Test)", plan: "standard", prefix: "Z" },
] as const;

const PEOPLE = [
  { role: "owner", local: "inhaber", name: "Inhaber/in", nr: "001" },
  { role: "manager", local: "leitung", name: "Leitung", nr: "002" },
  { role: "employee", local: "mitarbeiter1", name: "Mitarbeiter/in 1", nr: "101" },
  { role: "employee", local: "mitarbeiter2", name: "Mitarbeiter/in 2", nr: "102" },
  { role: "employee", local: "mitarbeiter3", name: "Mitarbeiter/in 3", nr: "103" },
] as const;

export class TestEnvRefused extends Error {}

/** 24 characters from 18 random bytes (base64url, ~144 bit). */
export function randomPassword(): string {
  return randomBytes(18).toString("base64url");
}

export async function seedTestEnvironment(opts: SeedTestEnvOptions): Promise<TestAccount[]> {
  const domain = (opts.domain ?? "stunden-test.example").toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) throw new TestEnvRefused(`Ungültige Domain: ${domain}`);
  const adminEmail = (opts.adminEmail ?? `superadmin@${domain}`).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) throw new TestEnvRefused(`Ungültige E-Mail-Adresse: ${adminEmail}`);

  const client = new pg.Client({ connectionString: opts.url, application_name: "stunden-seed-test-env" });
  await client.connect();
  const accounts: TestAccount[] = [];
  try {
    await client.query("begin");
    const real = await client.query("select count(*)::int as n from public.tenants where not is_demo");
    if (real.rows[0].n > 0) {
      throw new TestEnvRefused(`Abbruch: ${real.rows[0].n} Mandant(en) ohne Test-/Demo-Kennzeichen vorhanden – diese Datenbank ist keine reine Testumgebung.`);
    }
    const slugs = TEST_COMPANIES.map((c) => c.slug);
    const existing = await client.query("select slug from public.tenants where slug = any($1)", [slugs]);
    if (existing.rows.length) {
      throw new TestEnvRefused(`Abbruch: Testfirmen bereits angelegt (${existing.rows.map((r) => r.slug).join(", ")}). Passwörter mit "cli.ts set-password <email>" erneuern.`);
    }
    const emails = [adminEmail, ...TEST_COMPANIES.flatMap((c) => PEOPLE.map((p) => `${p.local}.${c.key}@${domain}`))];
    const taken = await client.query("select email from auth.users where email = any($1)", [emails]);
    if (taken.rows.length) throw new TestEnvRefused(`Abbruch: Konten bereits vorhanden (${taken.rows.map((r) => r.email).join(", ")}).`);

    const createUser = async (email: string): Promise<{ id: string; password: string }> => {
      const password = randomPassword();
      const r = await client.query("insert into auth.users (email, password_hash) values ($1, $2) returning id", [email, await hashPassword(password)]);
      return { id: String(r.rows[0].id), password };
    };

    const admin = await createUser(adminEmail);
    await client.query("insert into public.platform_admins (user_id, role) values ($1, 'super_admin')", [admin.id]);
    accounts.push({ company: "Plattform", role: "super_admin", name: "Super-Admin (Test)", email: adminEmail, password: admin.password });

    for (const c of TEST_COMPANIES) {
      const t = await client.query(
        `insert into public.tenants (slug, name, status, is_demo, contact)
         values ($1, $2, 'active', true, jsonb_build_object('legalName', $2::text, 'street', 'Teststraße 1', 'postalCode', '00000',
                 'city', 'Teststadt', 'email', $3::text))
         returning id`, [c.slug, c.name, `kontakt.${c.key}@${domain}`]);
      const tenantId = String(t.rows[0].id);
      await client.query(
        `insert into public.licenses (tenant_id, plan, status, price_cents, billing, note)
         values ($1, $2, 'active', 0, $3, $4)`,
        [tenantId, c.plan, c.plan === "pilot_free" ? "none" : "manual",
          c.plan === "pilot_free" ? "Testumgebung: kostenlose Testfirma." : "Testumgebung: zahlende Testfirma (Standardpreis je abrechenbarem Mitarbeiter)."]);
      for (const p of PEOPLE) {
        const email = `${p.local}.${c.key}@${domain}`;
        const user = await createUser(email);
        const name = `${p.name} ${c.key === "gratis" ? "Gratis" : "Zahlend"}`;
        await client.query(
          `insert into public.employees (tenant_id, user_id, personnel_number, display_name, email, role, status)
           values ($1, $2, $3, $4, $5, $6, 'active')`,
          [tenantId, user.id, `${c.prefix}-${p.nr}`, name, email, p.role]);
        accounts.push({ company: c.name, role: p.role, name, email, password: user.password });
      }
    }
    await client.query("commit");
    return accounts;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

const ROLE_LABEL: Record<TestAccount["role"], string> = {
  super_admin: "Super-Admin", owner: "Inhaber", manager: "Leitung", employee: "Mitarbeiter",
};

/** Console table (German). Contains the passwords – print to stdout only. */
export function formatAccounts(accounts: TestAccount[]): string {
  const rows = accounts.map((a) => [a.company, ROLE_LABEL[a.role], a.email, a.password]);
  const head = ["Firma", "Rolle", "E-Mail", "Passwort"];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((x, i) => x.padEnd(width[i]!)).join("  ").trimEnd();
  return [line(head), line(width.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

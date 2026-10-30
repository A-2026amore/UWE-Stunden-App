/**
 * Subscription (decision 30.10.2026, migration 0023, docs/api.md):
 *
 *   GET  /api/tenants/:tenantId/subscription            leadership of the tenant, platform staff → TenantSubscription
 *   POST /api/tenants/:tenantId/subscription/accept     owner, once: contract conclusion {entrepreneur, termsAccepted, interval}
 *   POST /api/tenants/:tenantId/subscription/choose     owner: {interval}
 *   POST /api/tenants/:tenantId/subscription/cancel     owner: {thenMonthly, reason} → confirmation mail to all owners
 *   POST /api/tenants/:tenantId/subscription/withdraw   owner: withdraw a cancellation
 *
 * Rules, access checks and audit live in the database (SECURITY DEFINER functions).
 * Billing job (runBillingJobs, periodically via startBillingJobs – started in main.ts only):
 *  - runSubscriptionReminders claims the due reminders in the database
 *    (auth.claim_subscription_reminders, each reminder only once) and sends the mails;
 *  - runMonthlyInvoices issues the invoices of the previous month from the 2nd
 *    (auth.issue_monthly_invoices) and mails the owners.
 */
import type pg from "pg";
import type { SubscriptionInterval, TenantSubscription } from "../../platform/src/core/types.ts";
import { formatEuro, VAT_NOTE } from "../../platform/src/core/billing.ts";
import { DPA_VERSION, INTERVAL_LABEL, PROMO_TERMS_NOTE, TERMS_VERSION } from "../../platform/src/core/subscription.ts";
import type { AppContext } from "./app.ts";
import { withTx, type Queryable } from "./db.ts";
import { badRequest } from "./errors.ts";
import type { Router } from "./http.ts";
import type { Mail } from "./mailer.ts";
import * as v from "./validate.ts";

const INTERVALS = ["monthly", "annual"] as const;

/** "2026-11-30" → "30.11.2026" */
export function germanDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/** Paragraph of the invitation mail of a new tenant with the welcome code (always with PROMO_TERMS_NOTE). */
export function welcomeCodeText(code: string, discountPercent: number): string {
  return `Als Willkommensangebot erhält deine Firma den Aktionscode ${code} (−${discountPercent} %). `
    + `Einlösen: nach der Anmeldung im Chef-Portal unter „Abrechnung“ den Code eingeben. ${PROMO_TERMS_NOTE}`;
}

/** Active owners of the tenant (account address, else the employee record) – same as the jobs. */
async function ownerEmails(q: Queryable, tenantId: string): Promise<string[]> {
  const r = await q.query<{ e: string[] }>("select public.tenant_subscription_mail_recipients($1) as e", [tenantId]);
  return r.rows[0]?.e ?? [];
}

/** Cancelling a planned switch that has not started: the previous plan runs on. */
export function switchUndoneMail(to: string, tenantName: string, continues: SubscriptionInterval): Mail {
  return {
    to,
    subject: `Tarifwechsel zurückgenommen – ${tenantName}`,
    text: `Guten Tag,\n\nder geplante Tarifwechsel Ihrer Firma ${tenantName} in der Zeiterfassung wurde zurückgenommen. `
      + `Tarifwechsel zurückgenommen, ${INTERVAL_LABEL[continues]} läuft weiter.\n\n`
      + "Den Tarif sehen Sie im Chef-Portal unter „Abrechnung“.\n",
  };
}

function cancellationMail(to: string, tenantName: string, s: TenantSubscription, endsOn: string, thenMonthly: boolean): Mail {
  const after = thenMonthly
    ? `Danach läuft der Vertrag im Monatstarif (${formatEuro(s.monthlyPriceCents)} je abrechenbarem Mitarbeiter und Monat, ${VAT_NOTE}) weiter und ist monatlich kündbar.`
    : "Danach endet der Vertrag; ab dem Folgemonat wird nichts mehr berechnet.";
  return {
    to,
    subject: `Kündigungsbestätigung – ${tenantName}`,
    text: `Guten Tag,\n\nwir bestätigen die Kündigung des Tarifs Ihrer Firma ${tenantName} in der Zeiterfassung. `
      + `Der Vertrag läuft bis einschließlich ${germanDate(endsOn)}.\n${after}\n\n`
      + "Bis zum Ende der Laufzeit können Sie die Kündigung im Chef-Portal unter „Abrechnung“ zurücknehmen.\n",
  };
}

export function registerSubscriptionRoutes(router: Router, app: AppContext): void {
  const json = (status: number, body: unknown) => ({ status, body });
  const read = async (q: Queryable, sql: string, params: unknown[]) => (await q.query(sql, params)).rows[0].s as TenantSubscription;

  router.add("GET", "/api/tenants/:tenantId/subscription", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    return app.asUser(ctx, async (q) => json(200, await read(q, "select public.tenant_subscription($1) as s", [id])));
  });

  router.add("POST", "/api/tenants/:tenantId/subscription/accept", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["entrepreneur", "termsAccepted", "interval"]);
    if (b.entrepreneur !== true || b.termsAccepted !== true) {
      throw badRequest("Bitte bestätigen Sie, dass Ihre Firma als Unternehmer handelt, und stimmen Sie den Nutzungsbedingungen und dem Auftragsverarbeitungsvertrag zu.");
    }
    const interval = v.oneOf(b.interval, INTERVALS, "Tarif");
    return app.asUser(ctx, async (q) =>
      json(200, await read(q, "select public.tenant_accept_contract($1, true, true, $2, $3, $4) as s", [id, interval, TERMS_VERSION, DPA_VERSION])));
  });

  router.add("POST", "/api/tenants/:tenantId/subscription/choose", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["interval"]);
    const interval: SubscriptionInterval = v.oneOf(b.interval, INTERVALS, "Tarif");
    return app.asUser(ctx, async (q) => json(200, await read(q, "select public.tenant_choose_subscription($1, $2) as s", [id, interval])));
  });

  router.add("POST", "/api/tenants/:tenantId/subscription/cancel", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["thenMonthly", "reason"]);
    const thenMonthly = b.thenMonthly === undefined || b.thenMonthly === null ? false : v.bool(b.thenMonthly, "Danach monatlich weiter");
    const reason = v.optStr(b.reason, { label: "Die Begründung", max: 1000 });
    const mails: Mail[] = [];
    const result = await app.asUser(ctx, async (q) => {
      const s = await read(q, "select public.tenant_cancel_subscription($1, $2, $3) as s", [id, thenMonthly, reason]);
      const r = await q.query<{ ends_on: string | null; undone: boolean | null; continues: SubscriptionInterval | null; name: string }>(
        `select (a.after ->> 'cancelledTermEndsOn') as ends_on, (a.after ->> 'undoneSwitch')::boolean as undone,
                (a.after ->> 'continuesInterval') as continues, t.name
           from public.audit_log a join public.tenants t on t.id = a.tenant_id
          where a.tenant_id = $1 and a.action = 'subscription.cancel' order by a.created_at desc, a.id desc limit 1`, [id]);
      const row = r.rows[0];
      if (row?.undone) {
        for (const to of await ownerEmails(q, id)) mails.push(switchUndoneMail(to, row.name, row.continues ?? "monthly"));
      } else if (row?.ends_on) {
        for (const to of await ownerEmails(q, id)) mails.push(cancellationMail(to, row.name, s, row.ends_on, thenMonthly));
      }
      return json(200, s);
    });
    app.sendLater(mails);
    return result;
  });

  router.add("POST", "/api/tenants/:tenantId/subscription/withdraw", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    v.object(ctx.body ?? {}, []);
    return app.asUser(ctx, async (q) => json(200, await read(q, "select public.tenant_withdraw_cancellation($1) as s", [id])));
  });
}

// ---------------------------------------------------------------- reminder job

interface ReminderRow {
  tenant_id: string;
  tenant_name: string;
  kind: "trial_end" | "annual_renewal";
  ref_date: string;
  cancel_by: string;
  next_interval: SubscriptionInterval | null;
  annual_price_cents: number;
  monthly_price_cents: number;
  emails: string[];
}

export function reminderMail(to: string, r: ReminderRow): Mail {
  if (r.kind === "trial_end") {
    const plan = r.next_interval === "annual"
      ? `Ab dem Folgemonat wird das ${INTERVAL_LABEL.annual} (${formatEuro(r.annual_price_cents)} je abrechenbarem Mitarbeiter und Monat, ${VAT_NOTE}) berechnet.`
      : `Ab dem Folgemonat wird der ${INTERVAL_LABEL.monthly} (${formatEuro(r.monthly_price_cents)} je abrechenbarem Mitarbeiter und Monat, ${VAT_NOTE}) berechnet. `
        + `Im ${INTERVAL_LABEL.annual} kostet es ${formatEuro(r.annual_price_cents)}.`;
    return {
      to,
      subject: `Ihre kostenlose Testphase endet am ${germanDate(r.ref_date)} – ${r.tenant_name}`,
      text: `Guten Tag,\n\ndie kostenlose Testphase Ihrer Firma ${r.tenant_name} in der Zeiterfassung endet am ${germanDate(r.ref_date)}. `
        + `${plan}\n\n`
        + "Tarif wählen oder kündigen: im Chef-Portal unter „Abrechnung“.\n",
    };
  }
  return {
    to,
    subject: `Ihr 12-Monats-Abo verlängert sich – ${r.tenant_name}`,
    text: `Guten Tag,\n\ndie aktuelle Laufzeit des ${INTERVAL_LABEL.annual}s Ihrer Firma ${r.tenant_name} endet am ${germanDate(r.ref_date)}. `
      + `Das Abo verlängert sich um 6 Monate, wenn Sie nicht bis ${germanDate(r.cancel_by)} kündigen.\n\n`
      + "Kündigen (auch mit „danach monatlich weiter“): im Chef-Portal unter „Abrechnung“.\n",
  };
}

/**
 * Claims the reminders due today (each only once, also across several server instances) and
 * sends them. Returns the number of mails handed to the mailer. Always today (Berlin): a
 * different day is only accepted from maintenance (role app_service), not from the server.
 */
export async function runSubscriptionReminders(
  pool: pg.Pool, send: (mails: Mail[]) => void,
): Promise<number> {
  const rows = await withTx(pool, "app_auth", null, async (q) =>
    (await q.query<ReminderRow>("select * from auth.claim_subscription_reminders()")).rows);
  const mails = rows.flatMap((r) => r.emails.map((to) => reminderMail(to, r)));
  send(mails);
  return mails.length;
}

// ---------------------------------------------------------------- automatic monthly invoices

const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** "2026-10" → "Oktober 2026" */
export function germanMonth(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

interface InvoiceRunRow {
  tenant_id: string;
  tenant_name: string;
  month: string;
  invoice_id: string | null;
  number: string | null;
  gross_cents: number | null;
  problem: string | null;
  emails: string[];
}

export function invoiceMail(to: string, r: { tenant_name: string; month: string; number: string; gross_cents: number }): Mail {
  return {
    to,
    subject: `Neue Rechnung ${r.number} für ${germanMonth(r.month)}`,
    text: `Guten Tag,\n\nfür ${r.tenant_name} steht die Rechnung ${r.number} für ${germanMonth(r.month)} bereit. `
      + `Rechnungsbetrag: ${formatEuro(r.gross_cents)} (${VAT_NOTE}).\n\n`
      + "Die Rechnung als PDF finden Sie im Chef-Portal unter „Abrechnung“.\n",
  };
}

export interface InvoiceRunResult {
  issued: Array<{ tenantId: string; month: string; number: string; grossCents: number }>;
  problems: Array<{ tenantId: string; month: string; problem: string }>;
  mails: number;
}

/**
 * From the 2nd of a month: issues the invoices of the previous month (auth.issue_monthly_invoices,
 * same issue path as the super admin, idempotent) and mails all owners.
 */
export async function runMonthlyInvoices(
  pool: pg.Pool, send: (mails: Mail[]) => void,
): Promise<InvoiceRunResult> {
  const rows = await withTx(pool, "app_auth", null, async (q) =>
    (await q.query<InvoiceRunRow>("select * from auth.issue_monthly_invoices()")).rows);
  const result: InvoiceRunResult = { issued: [], problems: [], mails: 0 };
  const mails: Mail[] = [];
  for (const r of rows) {
    if (r.number && r.gross_cents !== null) {
      result.issued.push({ tenantId: r.tenant_id, month: r.month, number: r.number, grossCents: Number(r.gross_cents) });
      for (const to of r.emails) mails.push(invoiceMail(to, { tenant_name: r.tenant_name, month: r.month, number: r.number, gross_cents: Number(r.gross_cents) }));
    } else if (r.problem) {
      result.problems.push({ tenantId: r.tenant_id, month: r.month, problem: r.problem });
    }
  }
  result.mails = mails.length;
  send(mails);
  return result;
}

/** One run of the periodic billing job: reminders and monthly invoices (callable once from tests and the CLI). */
export async function runBillingJobs(
  pool: pg.Pool, send: (mails: Mail[]) => void,
): Promise<{ reminders: number; invoices: InvoiceRunResult }> {
  const reminders = await runSubscriptionReminders(pool, send);
  const invoices = await runMonthlyInvoices(pool, send);
  return { reminders, invoices };
}

/** Periodic billing job (hourly by default); returns a stop function. Started in main.ts only. */
export function startBillingJobs(
  pool: pg.Pool, send: (mails: Mail[]) => void, log: (entry: Record<string, unknown>) => void, intervalMs = 60 * 60 * 1000,
): () => void {
  const tick = () => {
    runBillingJobs(pool, send)
      .then(({ reminders, invoices }) => {
        if (reminders) log({ level: "info", msg: "subscription reminders sent", count: reminders });
        if (invoices.issued.length) log({ level: "info", msg: "monthly invoices issued", count: invoices.issued.length, numbers: invoices.issued.map((i) => i.number) });
        // tenant ids and the German reason only (no personal data)
        for (const p of invoices.problems) log({ level: "warn", msg: "monthly invoice not issued", tenantId: p.tenantId, month: p.month, problem: p.problem });
      })
      .catch((e: unknown) => log({ level: "error", msg: "billing job failed", error: (e as Error)?.message ?? "unknown" }));
  };
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

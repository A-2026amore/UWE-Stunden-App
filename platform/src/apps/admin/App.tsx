import { useEffect, useState } from "preact/hooks";
import type { AuditEvent, BillingSettings, BillingStatus, License, LicensePlan, PlatformRevenueRow, Tenant } from "../../core/types";
import {
  BILLING_CONDITION_LABEL, BILLING_STATUS_LABEL, DEFAULT_EMPLOYEE_PRICE_CENTS, VAT_NOTE, billingConditionFor, formatEuro, monthsBack, parseEuro,
} from "../../core/billing";
import type { Session, TenantOverview } from "../../data/repository";
import {
  Alert, Badge, Button, Card, Checkbox, Dialog, Icon, InputField, LinkButton, SelectField, Sidebar, StatTile, StatusPill, Table,
  Avatar, DialogProvider, ThemeSwitch, ToastProvider, TextareaField, applyBranding, useDialogs, useToast, type NavGroup,
} from "../../design";
import { IS_DEMO, getRepository, onAuthFailure } from "../shared/repo";
import { useRoute } from "../shared/router";
import { LoginScreen, ProductMark } from "../shared/ui";
import { TwoFactorCard, TwoFactorGate } from "../shared/twoFactor";
import { PLAN_LABEL, currentMonth, dateTimeDE, formatDateDE, monthLabelDE } from "../shared/format";
import { errorText, useAsync } from "../shared/hooks";
import { auditLabel } from "../shared/audit";
import { InvoicesPage } from "./pages/Invoices";
import { PromoCodesPage, TenantPromoCard } from "./pages/PromoCodes";
import { DEFAULT_MONTHLY_PRICE_CENTS, INTERVAL_LABEL, PROMO_TERMS_NOTE } from "../../core/subscription";
import { SubscriptionFacts, berlinToday } from "../shared/subscription";

const repo = getRepository("admin");

const checkArea = (s: Session): string | null => (s.platformRole ? null : "Dieses Konto hat keinen Zugang zur Plattform-Administration.");

const NAV: NavGroup[] = [
  { label: "Kunden", items: [
    { href: "#/", label: "Mandanten", icon: "building", match: "/" },
    { href: "#/umsatz", label: "Umsatz", icon: "chart", match: "/umsatz" },
    { href: "#/rechnungen", label: "Rechnungen", icon: "receipt", match: "/rechnungen" },
    { href: "#/lizenzen", label: "Preismodell", icon: "key", match: "/lizenzen" },
    { href: "#/aktionscodes", label: "Aktionscodes", icon: "sparkles", match: "/aktionscodes" },
  ] },
  { label: "Betrieb", items: [
    { href: "#/support", label: "Supportzugriff", icon: "shield", match: "/support" },
    { href: "#/system", label: "Systemstatus", icon: "server", match: "/system" },
    { href: "#/protokoll", label: "Plattform-Protokoll", icon: "log", match: "/protokoll" },
  ] },
  { label: "Konto", items: [
    { href: "#/konto", label: "Mein Konto", icon: "user", match: "/konto" },
  ] },
];

const PLANS: Array<{ plan: LicensePlan; text: string; employees: string }> = [
  { plan: "pilot_free", text: "Nur noch für bestehende Pilotkunden: kostenlos, ohne Rechnungen. Neue Kunden zahlen immer – Rabatte gibt es über Aktionscodes.", employees: "unbegrenzt" },
  { plan: "standard", text: "Zeiterfassung, Monatsnachweise, Chef-Portal. Preis: Standardpreis je abrechenbarem Mitarbeiter.", employees: "bis 25 (Standard-Obergrenze)" },
  { plan: "business", text: "Wie Standard, höhere Mitarbeiter-Obergrenze. Gleicher Preis je Mitarbeiter.", employees: "bis 100 (Standard-Obergrenze)" },
  { plan: "enterprise", text: "Individuelle Vereinbarung, ohne Obergrenze. Gleicher Preis je Mitarbeiter, sofern keine Sonderkondition.", employees: "unbegrenzt" },
];

/** Licences that can be chosen: no free pilot any more (decision 30.10.2026), except to keep an existing one. */
const plansFor = (current: LicensePlan | null) => PLANS.filter((p) => p.plan !== "pilot_free" || current === "pilot_free");

export function LicenseBadge({ license }: { license: License | null }) {
  if (!license) return <Badge tone="danger">Keine Lizenz</Badge>;
  if (license.plan === "pilot_free") return <Badge tone="success" dot>Kostenlos – Pilot</Badge>;
  return <Badge tone="info">{PLAN_LABEL[license.plan]}</Badge>;
}

/** Price that applies in the current month (price model 2026-10-28). */
function priceText(l: License | null, defaultPriceCents: number): string {
  const c = billingConditionFor(l, defaultPriceCents, currentMonth());
  if (c.condition === "pilot_free") return "0,00 € – kostenlos (Pilot)";
  if (c.condition === "free") return "0,00 € – kostenloses Konto";
  return `${formatEuro(c.unitPriceCents)} je Mitarbeiter/Monat (${BILLING_CONDITION_LABEL[c.condition]})`;
}

/** Price of the current month from the revenue row (subscription 0023: trial, interval, end). */
function rowPriceText(r: PlatformRevenueRow | undefined, l: License | null, defaultPriceCents: number): string {
  if (!r) return priceText(l, defaultPriceCents);
  if (r.condition === "promo") return promoText(r);
  if (r.condition === "trial") return `0,00 € – Testphase${r.trialEndsOn ? ` bis ${formatDateDE(r.trialEndsOn)}` : ""}`;
  if (r.condition === "ended") return "0,00 € – kein laufender Vertrag";
  if (r.condition === "pilot_free" || r.condition === "free" || r.condition.startsWith("tenant_")) return priceText(l, defaultPriceCents);
  const label = r.condition === "standard" && r.interval ? INTERVAL_LABEL[r.interval] : BILLING_CONDITION_LABEL[r.condition];
  return `${formatEuro(r.unitPriceCents)} je Mitarbeiter/Monat (${label})`;
}

/** Condition of a revenue row incl. interval / trial end. */
function conditionText(x: PlatformRevenueRow): string {
  if (x.condition === "trial") return `${BILLING_CONDITION_LABEL.trial}${x.trialEndsOn ? ` bis ${formatDateDE(x.trialEndsOn)}` : ""}`;
  if (x.condition === "standard" && x.interval) return INTERVAL_LABEL[x.interval];
  const base = BILLING_CONDITION_LABEL[x.condition];
  return x.interval && (x.condition === "special" || x.condition === "promo") ? `${base} · ${INTERVAL_LABEL[x.interval]}` : base;
}

/** Revenue filter "Tarif": interval of the month, trial or no contract. */
type PlanFilter = "all" | "annual" | "monthly" | "trial" | "ended";
const planMatches = (x: PlatformRevenueRow, f: PlanFilter) =>
  f === "all" || (f === "trial" ? x.condition === "trial" : f === "ended" ? x.condition === "ended" : x.condition !== "trial" && x.interval === f);

/** Price of a month with a promo discount (revenue row). */
function promoText(r: PlatformRevenueRow): string {
  return `${formatEuro(r.unitPriceCents)} je Mitarbeiter/Monat (Aktionscode ${r.promoCode ?? ""}${r.promoDiscountPercent ? `, −${r.promoDiscountPercent} %` : ""})`;
}

function useBillingSettings(): BillingSettings | null {
  const q = useAsync(() => repo.getBillingSettings(), []);
  return q.data ?? null;
}

export function AdminApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useRoute();
  // Close the phone/tablet menu whenever the page changes (also on back/forward).
  useEffect(() => { setMenuOpen(false); }, [route.path]);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    applyBranding(null);
    repo.currentSession().then((s) => {
      const problem = s ? checkArea(s) : null;
      if (problem) setNotice(problem);
      setSession(problem ? null : s);
    }, (e: unknown) => { setNotice(errorText(e)); setSession(null); });
  }, []);
  useEffect(() => onAuthFailure((f) => {
    if (f.kind === "two_factor_setup") { repo.currentSession().then(setSession, () => setSession(null)); return; }
    setNotice(f.message); setSession(null);
  }), []);

  if (session === undefined) return <p class="sr-only" role="status">Wird geladen …</p>;
  if (!session) {
    return (
      <LoginScreen area="admin" title="Plattform-Administration" subtitle="Nur für den Plattformbetreiber."
        check={checkArea} notice={notice}
        onSignedIn={(s) => { setNotice(null); setSession(s); location.hash = "#/"; }} />
    );
  }
  const signOut = async () => { await repo.signOut(); setSession(null); };
  if (session.twoFactorSetupRequired) return <TwoFactorGate repo={repo} session={session} onDone={setSession} onSignOut={signOut} />;
  const readOnly = session.platformRole !== "super_admin";

  let page;
  if (route.path === "/mandant" && route.parts[0]) page = <TenantDetail id={route.parts[0]} readOnly={readOnly} />;
  else if (route.path === "/rechnungen") page = <InvoicesPage readOnly={readOnly} />;
  else if (route.path === "/lizenzen") page = <PlansPage readOnly={readOnly} />;
  else if (route.path === "/aktionscodes") page = <PromoCodesPage readOnly={readOnly} />;
  else if (route.path === "/umsatz") page = <RevenuePage readOnly={readOnly} />;
  else if (route.path === "/support") page = <SupportPage />;
  else if (route.path === "/system") page = <SystemPage />;
  else if (route.path === "/protokoll") page = <PlatformAudit />;
  else if (route.path === "/konto") page = <AccountPage session={session} />;
  else page = <TenantsPage readOnly={readOnly} />;

  return (
    <ToastProvider>
      <DialogProvider>
        <a class="skip-link" href="#main">Zum Inhalt springen</a>
        <div class="d-shell">
          <div class="d-topbar">
            <Button variant="ghost" icon="menu" aria-label="Menü öffnen" aria-expanded={menuOpen ? "true" : "false"} aria-controls="sidebar" onClick={() => setMenuOpen(true)} />
            <ProductMark compact />
            <div class="topbar-end"><Avatar name={session.email} small /></div>
          </div>
          <Sidebar groups={NAV} current={route.path === "/mandant" ? "/" : route.path} open={menuOpen} onNavigate={() => setMenuOpen(false)}
            brand={<div class="stack-sm"><ProductMark /><span class="sidebar-area">Super-Admin · Plattformbetrieb</span></div>}
            footer={<>
              <div class="user-chip">
                <Avatar name={session.email} />
                <div class="user-chip-text"><strong>{session.email}</strong><span>{session.platformRole === "super_admin" ? "Super-Admin" : "Support (nur lesen)"}</span></div>
              </div>
              <div class="sidebar-actions"><ThemeSwitch compact />
              <Button variant="secondary" size="sm" icon="logout" onClick={signOut}>Abmelden</Button></div>
            </>} />
          <main class="d-main" id="main">{page}</main>
        </div>
      </DialogProvider>
    </ToastProvider>
  );
}

// ------------------------------------------------------------------ own account

function AccountPage({ session }: { session: Session }) {
  return (
    <div class="stack">
      <h1 class="page-title">Mein Konto</h1>
      <Card title="Anmeldung">
        <dl class="kv">
          <dt>E-Mail</dt><dd>{session.email}</dd>
          <dt>Rolle</dt><dd>{session.platformRole === "super_admin" ? "Super-Admin" : "Support (nur lesen)"}</dd>
        </dl>
      </Card>
      <TwoFactorCard repo={repo} account={session.email} />
    </div>
  );
}

// ------------------------------------------------------------------ tenants

interface NewTenantForm {
  name: string; slug: string; ownerEmail: string; plan: LicensePlan; isDemo: boolean;
}
/** No free accounts for new customers (decision 30.10.2026) – discounts only via promo codes. */
const EMPTY_TENANT: NewTenantForm = { name: "", slug: "", ownerEmail: "", plan: "standard", isDemo: false };

function TenantsPage({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const now = currentMonth();
  const q = useAsync(async () => {
    const [tenants, revenue] = await Promise.all([repo.listTenants(), repo.getPlatformRevenue(now)]);
    return { tenants, revenue };
  }, [tick]);
  const settings = useBillingSettings();
  const defaultPrice = settings?.defaultPriceCents ?? DEFAULT_EMPLOYEE_PRICE_CENTS;
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState<NewTenantForm>(EMPTY_TENANT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");

  const all = q.data?.tenants ?? [];
  const revenueRow = (id: string) => q.data?.revenue.rows.find((x) => x.tenantId === id);
  const list = all.filter((t) => statusFilter === "all" || (statusFilter === "promo" ? revenueRow(t.tenant.id)?.condition === "promo" : t.tenant.status === statusFilter));
  const count = (st: string) => all.filter((t) => t.tenant.status === st).length;
  const promos = all.filter((t) => revenueRow(t.tenant.id)?.condition === "promo").length;
  const pilots = all.filter((t) => t.license?.plan === "pilot_free").length;
  const real = all.filter((t) => !t.tenant.isDemo);
  const employees = all.reduce((s, t) => s + t.employeeCount, 0);
  const activeEmployees = real.reduce((s, t) => s + t.activeEmployeeCount, 0);
  const revenue = q.data?.revenue;

  const open = () => { setCreating(true); setError(null); setF(EMPTY_TENANT); };

  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const o = await repo.createTenant({ name: f.name, slug: f.slug, plan: f.plan, isDemo: f.isDemo, ownerEmail: f.ownerEmail });
      const welcome = settings?.welcomePromoCode ? ` Willkommenscode: ${settings.welcomePromoCode}.` : "";
      toast(IS_DEMO
        ? `Mandant „${o.tenant.name}“ angelegt. Einladung an ${f.ownerEmail} (Demo: Passwort „demo“).${welcome}`
        : `Mandant „${o.tenant.name}“ angelegt. Die Einladung wurde per E-Mail an ${f.ownerEmail} gesendet.${welcome}`);
      setCreating(false);
      setF(EMPTY_TENANT);
      setTick((t) => t + 1);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  const slugify = (v: string) => v.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42);

  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <p class="page-eyebrow">Plattform</p>
          <h1 class="page-title">Mandanten</h1>
          <p class="muted page-sub">Plattform-Übersicht · {monthLabelDE(now)}</p>
        </div>
        {!readOnly && (
          <div class="btn-row">
            <LinkButton variant="secondary" icon="sparkles" href="#/aktionscodes">Aktionscodes</LinkButton>
            <Button icon="plus" onClick={open}>Mandant anlegen</Button>
          </div>
        )}
      </div>
      <div class="grid-4" data-testid="platform-kpis">
        <StatTile icon="building" label="Mandanten" value={all.length} hint={`${count("active")} aktiv · ${count("suspended")} gesperrt · ${count("deactivated")} deaktiviert${count("pending") ? ` · ${count("pending")} in Vorbereitung` : ""}`} />
        <StatTile icon="users" label="Mitarbeitende gesamt" value={employees} hint={`${activeEmployees} aktiv bei Kunden (ohne Demo) · nur Anzahl, keine Personendaten`} />
        <StatTile icon="euro" label={`Umsatz brutto ${monthLabelDE(now)}`} value={revenue ? formatEuro(revenue.totals.amountCents) : "—"} tone="brand"
          hint={revenue ? `Vorschau · ${revenue.totals.billableCount} abrechenbare Mitarbeitende · ohne Demo` : undefined} />
        <StatTile icon="sparkles" label="Mit Aktionsrabatt" value={promos} hint={pilots ? `diesen Monat · ${pilots} bestehende Pilotkunden (kostenlos)` : "diesen Monat"} />
      </div>
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      <Card>
        <div class="toolbar">
          <SelectField label="Anzeigen" value={statusFilter} onValue={setStatusFilter} options={[
            { value: "all", label: "Alle" }, { value: "active", label: "Aktiv" }, { value: "pending", label: "In Vorbereitung" },
            { value: "suspended", label: "Gesperrt" }, { value: "deactivated", label: "Deaktiviert" }, { value: "promo", label: "Mit Aktionsrabatt" },
          ]} />
          <p class="muted small mb-0">{list.length} von {all.length} Mandanten · <a href="#/umsatz">Umsatz aller Monate</a></p>
        </div>
        <Table<TenantOverview>
          caption="Mandantenliste"
          rows={list}
          rowKey={(t) => t.tenant.id}
          empty={<p class="muted">Keine Mandanten.</p>}
          columns={[
            { key: "n", header: "Mandant", render: (t) => <><a href={`#/mandant/${t.tenant.id}`}><strong>{t.tenant.name}</strong></a><div class="xsmall muted">{t.tenant.slug}{t.tenant.isDemo ? " · Demo-Daten" : ""}</div></> },
            { key: "s", header: "Status", render: (t) => <StatusPill status={t.tenant.status} /> },
            { key: "l", header: "Lizenz", render: (t) => <LicenseBadge license={t.license} /> },
            { key: "p", header: "Preis", render: (t) => {
              const r = revenueRow(t.tenant.id);
              return <span class="small">{rowPriceText(r, t.license, defaultPrice)}</span>;
            } },
            { key: "e", header: "Mitarbeitende", align: "right", render: (t) => <span class="num">{t.activeEmployeeCount} / {t.employeeCount}{t.license?.maxEmployees ? ` (max. ${t.license.maxEmployees})` : ""}</span> },
            { key: "u", header: "Umsatz (Monat)", align: "right", render: (t) => {
              const r = revenue?.rows.find((x) => x.tenantId === t.tenant.id);
              return <span class="num">{r ? formatEuro(r.amountCents) : "—"}</span>;
            } },
            { key: "a", header: "Aktionen", actions: true, render: (t) => <LinkButton size="sm" href={`#/mandant/${t.tenant.id}`} aria-label={`${t.tenant.name} verwalten`}>Verwalten</LinkButton> },
          ]}
        />
      </Card>

      <Dialog open={creating} title="Mandant anlegen" onClose={() => setCreating(false)}
        footer={<><Button variant="secondary" onClick={() => setCreating(false)}>Abbrechen</Button><Button type="submit" form="tenant-form" busy={busy}>Anlegen</Button></>}>
        <form id="tenant-form" class="stack" onSubmit={create} noValidate>
          <InputField label="Firmenname" value={f.name} onValue={(v) => setF({ ...f, name: v, slug: f.slug && f.slug !== slugify(f.name) ? f.slug : slugify(v) })} data-autofocus />
          <InputField label="Kurzname (URL)" value={f.slug} onValue={(v) => setF({ ...f, slug: v })} hint="Kleinbuchstaben, Ziffern und Bindestriche." />
          <InputField label="E-Mail des Inhabers" type="email" value={f.ownerEmail} onValue={(v) => setF({ ...f, ownerEmail: v })} hint="Erhält die Einladung zum Chef-Portal (einmaliger Link, kein Passwort)." />
          <SelectField label="Lizenz" value={f.plan} onValue={(v) => setF({ ...f, plan: v as LicensePlan })} options={plansFor(null).map((p) => ({ value: p.plan, label: PLAN_LABEL[p.plan]! }))}
            hint={`${formatEuro(defaultPrice)} im 12-Monats-Abo, ${formatEuro(settings?.monthlyPriceCents ?? DEFAULT_MONTHLY_PRICE_CENTS)} im Monatstarif (${VAT_NOTE}) je abrechenbarem Mitarbeiter und Monat. Der Inhaber schließt den Vertrag bei der ersten Anmeldung ab; ohne Wahl gilt der Monatstarif. Rabatte nur über Aktionscodes.`} />
          {settings?.trialWindowFrom && settings.trialWindowUntil && (
            <Alert tone="info"><p>Einführungsangebot: Mandanten, die vom {formatDateDE(settings.trialWindowFrom)} bis {formatDateDE(settings.trialWindowUntil)} angelegt werden, erhalten {settings.trialMonths} Monate kostenlos (bis Ende des Kalendermonats).</p></Alert>
          )}
          {settings?.welcomePromoCode && <p class="xsmall muted">Die Einladung enthält den Willkommenscode {settings.welcomePromoCode}. {PROMO_TERMS_NOTE}</p>}
          <Checkbox label="Demo-/Testmandant" hint="Nur anonymisierte Testdaten. PDFs werden als Test gekennzeichnet; zählt nicht zum Umsatz." checked={f.isDemo} onChange={(v) => setF({ ...f, isDemo: v })} />
          {error && <Alert tone="danger" live>{error}</Alert>}
        </form>
      </Dialog>
    </div>
  );
}

function TenantDetail({ id, readOnly }: { id: string; readOnly: boolean }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [tick, setTick] = useState(0);
  const q = useAsync(async () => {
    const all = await repo.listTenants();
    const o = all.find((t) => t.tenant.id === id);
    if (!o) throw new Error("Mandant nicht gefunden.");
    const [audit, grant, revenue, sub] = await Promise.all([repo.listAudit(id, 50), repo.getSupportGrant(id), repo.getPlatformRevenue(currentMonth()),
      repo.getTenantSubscription(id).catch(() => null)]);
    return { o, audit, grant, billing: revenue.rows.find((r) => r.tenantId === id) ?? null, defaultPrice: revenue.defaultPriceCents, sub };
  }, [id, tick]);
  const [lic, setLic] = useState({
    plan: "pilot_free" as LicensePlan, maxEmployees: "", validUntil: "", note: "",
    price: "", free: false, condNote: "", condFrom: "", condUntil: "", reason: "",
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const l = q.data?.o.license;
    if (l) {
      setLic({
        plan: l.plan, maxEmployees: l.maxEmployees == null ? "" : String(l.maxEmployees), validUntil: l.validUntil ?? "", note: l.note ?? "",
        price: l.employeePriceCents == null ? "" : formatEuro(l.employeePriceCents).replace(" €", "").replace(/\./g, ""),
        free: l.freeOfCharge && l.plan !== "pilot_free", condNote: l.conditionNote ?? "", condFrom: l.conditionValidFrom ?? "", condUntil: l.conditionValidUntil ?? "", reason: "",
      });
    }
  }, [q.data]);

  if (q.error) return <Alert tone="danger" live>{q.error}</Alert>;
  if (!q.data) return <h1 class="page-title">Mandant</h1>;
  const { o, audit, grant, billing, defaultPrice, sub } = q.data;
  const t: Tenant = o.tenant;

  type StatusAction = { status: Tenant["status"]; label: string; title: string; message: string; done: string; danger: boolean; icon: "lock" | "refresh" | "check" | "x" };
  const STATUS_ACTIONS: Record<string, StatusAction> = {
    unlock: { status: "active", label: "Freischalten", title: `${t.name} freischalten?`, message: "Die Benutzer des Mandanten können sich anmelden.", done: "Mandant freigeschaltet.", danger: false, icon: "check" },
    reactivate: { status: "active", label: "Reaktivieren", title: `${t.name} reaktivieren?`, message: "Die Benutzer können sich wieder anmelden. Alle Daten sind unverändert vorhanden.", done: "Mandant reaktiviert.", danger: false, icon: "refresh" },
    suspend: { status: "suspended", label: "Sperren", title: `${t.name} sperren?`, message: "Vorübergehende Sperre (z. B. offene Rechnung): Alle Benutzer dieses Mandanten können sich nicht mehr anmelden. Daten bleiben vollständig erhalten.", done: "Mandant gesperrt.", danger: true, icon: "lock" },
    deactivate: { status: "deactivated", label: "Deaktivieren", title: `${t.name} deaktivieren?`, message: "Für beendete Verträge: Der Zugang wird dauerhaft abgeschaltet, niemand kann sich mehr anmelden. Es werden keine Daten gelöscht; eine Reaktivierung ist möglich.", done: "Mandant deaktiviert.", danger: true, icon: "x" },
  };
  const actionsFor: Record<Tenant["status"], string[]> = {
    pending: ["unlock", "deactivate"], active: ["suspend", "deactivate"], suspended: ["reactivate", "deactivate"], deactivated: ["reactivate"],
  };

  const setStatus = async (key: string) => {
    const a = STATUS_ACTIONS[key]!;
    const reason = await dialogs.askReason({ title: a.title, message: a.message, confirmLabel: a.label, danger: a.danger });
    if (!reason) return;
    try { await repo.setTenantStatus(t.id, a.status, reason); toast(a.done); setTick((x) => x + 1); }
    catch (e) { toast(errorText(e), "error"); }
  };

  const saveLicense = async (e: Event) => {
    e.preventDefault();
    setError(null);
    const max = lic.maxEmployees.trim() === "" ? null : Number(lic.maxEmployees);
    if (max !== null && (!Number.isInteger(max) || max < 1)) { setError("Maximale Mitarbeiterzahl: ganze Zahl ab 1 oder leer für unbegrenzt."); return; }
    let price: number | null = null;
    try { price = lic.price.trim() === "" ? null : parseEuro(lic.price); } catch (err) { setError(errorText(err)); return; }
    const condition = {
      employeePriceCents: price, freeOfCharge: lic.free, conditionNote: lic.condNote.trim() || null,
      conditionValidFrom: lic.condFrom || null, conditionValidUntil: lic.condUntil || null,
      ...(lic.reason.trim() ? { reason: lic.reason.trim() } : {}),
    };
    try {
      await repo.setLicense(t.id, lic.plan, lic.plan === "pilot_free"
        ? { note: lic.note || null, ...(lic.reason.trim() ? { reason: lic.reason.trim() } : {}) }
        : { maxEmployees: max, validUntil: lic.validUntil || null, note: lic.note || null, ...condition });
      toast("Lizenz gespeichert.");
      setTick((x) => x + 1);
    } catch (err) { setError(errorText(err)); }
  };

  return (
    <div class="stack">
      <div class="row-between">
        <div>
          <a href="#/" class="small">← Alle Mandanten</a>
          <h1 class="page-title" style={{ marginTop: "var(--space-2)" }}>{t.name}</h1>
        </div>
        <div class="row"><StatusPill status={t.status} /><LicenseBadge license={o.license} /></div>
      </div>
      <div class="grid-2" style={{ alignItems: "start" }}>
        <Card title="Mandant">
          <dl class="kv">
            <dt>Kurzname</dt><dd>{t.slug}</dd>
            <dt>Rechtlicher Name</dt><dd>{t.contact.legalName || "—"}</dd>
            <dt>Ort</dt><dd>{[t.contact.postalCode, t.contact.city].filter(Boolean).join(" ") || "—"}</dd>
            <dt>Mitarbeitende</dt><dd>{o.activeEmployeeCount} aktiv / {o.employeeCount} gesamt</dd>
            <dt>Arbeitszeitkonto</dt><dd>{t.settings.workAccount.enabled ? (t.settings.workAccount.model === "school-year" ? "Schuljahr" : "Kalenderjahr") : "deaktiviert"}</dd>
            <dt>Demo-Daten</dt><dd>{t.isDemo ? "ja" : "nein"}</dd>
          </dl>
          {!readOnly && (
            <div class="btn-row" style={{ marginTop: "var(--space-4)" }}>
              {(actionsFor[t.status] ?? []).map((key) => {
                const a = STATUS_ACTIONS[key]!;
                return <Button key={key} variant={a.danger ? (key === "deactivate" ? "secondary" : "danger") : "primary"} icon={a.icon} onClick={() => setStatus(key)}>{a.label}</Button>;
              })}
            </div>
          )}
          <p class="xsmall muted" style={{ marginTop: "var(--space-3)" }}>Gesperrt = vorübergehend, deaktiviert = Vertrag beendet. In beiden Fällen bleiben alle Daten erhalten.</p>
        </Card>
        <Card title="Lizenz">
          <form class="stack" onSubmit={saveLicense} noValidate>
            <dl class="kv">
              <dt>Preis</dt><dd data-testid="tenant-price">{rowPriceText(billing ?? undefined, o.license, defaultPrice)}</dd>
              <dt>Abrechnung</dt><dd>{o.license?.plan === "pilot_free" ? "keine (keine Zahlungsdaten, keine Rechnungen)" : "manuell (Status je Monat unter „Umsatz“)"}</dd>
              <dt>Gültig ab</dt><dd>{o.license ? formatDateDE(o.license.validFrom) : "—"}</dd>
              <dt>Gültig bis</dt><dd>{o.license?.validUntil ? formatDateDE(o.license.validUntil) : "unbefristet"}</dd>
            </dl>
            <SelectField label="Lizenzmodell" value={lic.plan} onValue={(v) => setLic({ ...lic, plan: v as LicensePlan })} disabled={readOnly}
              options={plansFor(o.license?.plan ?? null).map((p) => ({ value: p.plan, label: PLAN_LABEL[p.plan]! }))} />
            {lic.plan === "pilot_free"
              ? <Alert tone="success" title="Kostenlos – Pilot"><p>Preis 0 €, unbegrenzte Mitarbeitende, unbefristet. Keine Zahlungsdaten, keine Rechnungen, keine automatische Umstellung.</p></Alert>
              : <>
                  <InputField label="Max. Mitarbeitende" optional inputMode="numeric" value={lic.maxEmployees} onValue={(v) => setLic({ ...lic, maxEmployees: v })} disabled={readOnly} hint="Leer = unbegrenzt" />
                  <InputField label="Gültig bis" optional type="date" value={lic.validUntil} onValue={(v) => setLic({ ...lic, validUntil: v })} disabled={readOnly} />
                  <fieldset class="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend><strong>Sonderkondition</strong></legend>
                    {(lic.free || o.license?.freeOfCharge) && (
                      <Checkbox label="Kostenloses Konto" hint="Nur noch für bestehende Konten. Haken entfernen = ab sofort kostenpflichtig; Rabatte künftig über Aktionscodes." checked={lic.free} onChange={(v) => setLic({ ...lic, free: v })} disabled={readOnly} />
                    )}
                    <InputField label="Sonderpreis je Mitarbeiter (€ brutto)" optional inputMode="decimal" value={lic.price} onValue={(v) => setLic({ ...lic, price: v })} disabled={readOnly || lic.free}
                      hint={`Leer = Standardpreis (${formatEuro(defaultPrice)}).`} />
                    <div class="grid-2">
                      <InputField label="Kondition gültig ab" optional type="date" value={lic.condFrom} onValue={(v) => setLic({ ...lic, condFrom: v })} disabled={readOnly} />
                      <InputField label="Kondition gültig bis" optional type="date" value={lic.condUntil} onValue={(v) => setLic({ ...lic, condUntil: v })} disabled={readOnly} />
                    </div>
                    <p class="xsmall muted">Gilt für jeden Monat, den der Zeitraum berührt. Leer = unbefristet. Bereits abgerechnete Monate bleiben unverändert.</p>
                    <InputField label="Notiz zur Kondition" optional value={lic.condNote} onValue={(v) => setLic({ ...lic, condNote: v })} disabled={readOnly} maxLength={500} />
                  </fieldset>
                </>}
            <TextareaField label="Notiz" optional value={lic.note} onValue={(v) => setLic({ ...lic, note: v })} disabled={readOnly} maxLength={300} />
            {!readOnly && <InputField label="Grund der Änderung (Protokoll)" optional value={lic.reason} onValue={(v) => setLic({ ...lic, reason: v })} maxLength={500} />}
            {error && <Alert tone="danger" live>{error}</Alert>}
            {!readOnly && <div><Button type="submit" icon="check">Lizenz speichern</Button></div>}
          </form>
        </Card>
      </div>
      <Card title={`Abrechnung ${monthLabelDE(currentMonth())} (Vorschau)`}>
        {billing
          ? <dl class="kv">
              <dt>Abrechenbare Mitarbeitende</dt><dd data-testid="tenant-billable">{billing.billableCount}</dd>
              <dt>Preis je Mitarbeiter</dt><dd>{formatEuro(billing.unitPriceCents)} ({conditionText(billing)}{billing.promoCode ? ` ${billing.promoCode}` : ""})</dd>
              <dt>Summe brutto</dt><dd>{formatEuro(billing.amountCents)} <span class="xsmall muted">{VAT_NOTE}</span></dd>
            </dl>
          : <p class="muted">Keine Daten.</p>}
        <p class="xsmall muted">Nur Zahlen – Namen sieht ausschließlich der Mandant selbst. <a href="#/umsatz">Alle Monate unter „Umsatz“</a></p>
      </Card>
      <Card title="Tarif und Vertrag">
        {sub ? <SubscriptionFacts sub={sub} /> : <p class="muted">Keine Daten.</p>}
        <p class="xsmall muted">Nur lesend: Tarif, Kündigung und Rücknahme ändert der Inhaber im Chef-Portal unter „Abrechnung“.</p>
      </Card>
      <TenantPromoCard tenantId={t.id} readOnly={readOnly} onChange={() => setTick((x) => x + 1)} />
      <Card title="Supportzugriff auf Personendaten">
        {grant
          ? <Alert tone="warning" title="Freigabe durch den Mandanten aktiv"><p>Bis {dateTimeDE(grant.grantedUntil)}. Lesender Zugriff auf Arbeitszeiten ist für diesen Zeitraum möglich und wird protokolliert.</p></Alert>
          : <Alert tone="success" title="Keine Freigabe"><p>Arbeitszeiten und Personendaten dieses Mandanten sind für den Plattformbetrieb nicht einsehbar. Der Inhaber kann im Chef-Portal einen zeitlich begrenzten Supportzugriff freigeben.</p></Alert>}
      </Card>
      <Card title="Protokoll (Plattform-Ereignisse)">
        <AuditTable events={audit} />
      </Card>
    </div>
  );
}

function AuditTable({ events, withTenant }: { events: AuditEvent[]; withTenant?: Map<string, string> }) {
  return (
    <Table<AuditEvent>
      caption="Protokoll"
      rows={events}
      rowKey={(e) => e.id}
      empty={<p class="muted">Keine Einträge.</p>}
      columns={[
        { key: "t", header: "Zeitpunkt", render: (e) => <span class="small nowrap">{dateTimeDE(e.createdAt)}</span> },
        ...(withTenant ? [{ key: "m", header: "Mandant", render: (e: AuditEvent) => (e.tenantId ? withTenant.get(e.tenantId) ?? "—" : "—") }] : []),
        { key: "a", header: "Aktion", render: (e) => auditLabel(e) },
        { key: "r", header: "Begründung", render: (e) => <span class="small">{e.reason ?? "—"}</span> },
      ]}
    />
  );
}

function PlatformAudit() {
  const q = useAsync(async () => {
    const [events, tenants] = await Promise.all([repo.listPlatformAudit(200), repo.listTenants()]);
    return { events, names: new Map(tenants.map((t) => [t.tenant.id, t.tenant.name])) };
  }, []);
  return (
    <div class="stack">
      <h1 class="page-title">Plattform-Protokoll</h1>
      <p class="muted">Mandanten-, Lizenz- und Supportzugriffs-Ereignisse. Arbeitszeitänderungen der Mandanten sind hier bewusst nicht sichtbar.</p>
      {q.error && <Alert tone="danger">{q.error}</Alert>}
      <Card>{q.data && <AuditTable events={q.data.events} withTenant={q.data.names} />}</Card>
    </div>
  );
}

// ------------------------------------------------------------------ static pages

interface SettingsForm { annual: string; monthly: string; from: string; until: string; months: string; notice: string; welcome: string; reason: string }

const euroInput = (cents: number) => formatEuro(cents).replace(" €", "").replace(/\./g, "");
function settingsForm(st: BillingSettings): SettingsForm {
  return { annual: euroInput(st.defaultPriceCents), monthly: euroInput(st.monthlyPriceCents), from: st.trialWindowFrom ?? "", until: st.trialWindowUntil ?? "",
    months: String(st.trialMonths), notice: String(st.cancelNoticeDays), welcome: st.welcomePromoCodeId ?? "", reason: "" };
}
const wholeNumber = (raw: string, what: string): number => {
  const n = Number(raw.trim());
  if (raw.trim() === "" || !Number.isInteger(n)) throw new Error(`${what}: bitte eine ganze Zahl angeben.`);
  return n;
};

function PlansPage({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const q = useAsync(async () => {
    const [settings, codes] = await Promise.all([repo.getBillingSettings(), repo.listPromoCodes()]);
    return { settings, codes };
  }, [tick]);
  const [f, setF] = useState<SettingsForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setF(settingsForm(q.data.settings)); }, [q.data]);
  const st = q.data?.settings;
  const current = st?.defaultPriceCents ?? DEFAULT_EMPLOYEE_PRICE_CENTS;
  const monthly = st?.monthlyPriceCents ?? DEFAULT_MONTHLY_PRICE_CENTS;
  const today = berlinToday();
  // Codes that can still be redeemed (plus the current choice, so it stays visible).
  const codes = (q.data?.codes ?? []).filter((c) => (!c.endedAt && (!c.redeemableUntil || c.redeemableUntil >= today)
    && (c.maxRedemptions === null || c.redemptionCount < c.maxRedemptions)) || c.id === st?.welcomePromoCodeId);

  const save = async (e: Event) => {
    e.preventDefault();
    if (!f) return;
    setError(null);
    try {
      const patch = {
        defaultPriceCents: parseEuro(f.annual), monthlyPriceCents: parseEuro(f.monthly),
        trialWindowFrom: f.from || null, trialWindowUntil: f.until || null,
        trialMonths: wholeNumber(f.months, "Testphase"), cancelNoticeDays: wholeNumber(f.notice, "Kündigungsfrist"),
        welcomePromoCodeId: f.welcome || null, reason: f.reason,
      };
      setBusy(true);
      await repo.updateBillingSettings(patch);
      toast("Preise und Tarifeinstellungen gespeichert.");
      setTick((x) => x + 1);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <div class="stack">
      <h1 class="page-title">Preismodell</h1>
      <div class="grid-2">
        <StatTile label="12-Monats-Abo" value={<span data-testid="default-price">{formatEuro(current)}</span>} tone="brand"
          hint={`je Mitarbeiter/Monat, ${VAT_NOTE} · 12 Monate fest, verlängert sich um 6 Monate`} />
        <StatTile label="Monatstarif" value={<span data-testid="monthly-price">{formatEuro(monthly)}</span>}
          hint={`je Mitarbeiter/Monat, ${VAT_NOTE} · zum Monatsende kündbar · gilt ohne Wahl`} />
      </div>
      <Card title="Preise und Tarife" accent>
        <ul class="stack-sm small" style={{ margin: 0, paddingLeft: "1.3em" }}>
          <li>Keine Grundgebühr, keine Mindestanzahl, keine Staffeln. Beispiel 20 Mitarbeitende: {formatEuro(20 * current)} im 12-Monats-Abo, {formatEuro(20 * monthly)} im Monatstarif.</li>
          <li>Abrechenbar: Mitarbeiter/innen, die im Monat mindestens zeitweise aktiv waren. Inhaber und Vorgesetzte nur mit eigenen Arbeitszeiten im Monat.</li>
          <li>Einführungsangebot: Mandanten, die im Zeitraum angelegt werden, sind bis zum Ende des Kalendermonats kostenlos, in dem die Testphase endet.</li>
          <li>Keine kostenlosen Konten. Rabatte nur über <a href="#/aktionscodes">Aktionscodes</a>. Sonderpreise je Mandant unter „Mandanten“ → „Verwalten“.</li>
          <li>Kein Zahlungsdienstleister angebunden: Abrechnung manuell, keine Abbuchungen, keine Kontodaten.</li>
        </ul>
        {st && (
          <dl class="kv" style={{ marginTop: "var(--space-4)" }} data-testid="billing-settings">
            <dt>Einführungsangebot</dt>
            <dd>{st.trialWindowFrom && st.trialWindowUntil ? `${formatDateDE(st.trialWindowFrom)} bis ${formatDateDE(st.trialWindowUntil)}, ${st.trialMonths} Monate kostenlos` : "keines"}</dd>
            <dt>Kündigungsfrist</dt><dd>{st.cancelNoticeDays ? `${st.cancelNoticeDays} Tage vor Laufzeitende` : "bis zum letzten Tag der Laufzeit"}</dd>
            <dt>Willkommenscode</dt><dd>{st.welcomePromoCode ?? "keiner"}</dd>
          </dl>
        )}
        {!readOnly && f && (
          <form class="stack" onSubmit={save} noValidate style={{ marginTop: "var(--space-4)" }}>
            <div class="grid-2">
              <InputField label="12-Monats-Abo (€ brutto)" inputMode="decimal" value={f.annual} onValue={(v) => setF({ ...f, annual: v })} hint="Je Mitarbeiter und Monat, inkl. USt." />
              <InputField label="Monatstarif (€ brutto)" inputMode="decimal" value={f.monthly} onValue={(v) => setF({ ...f, monthly: v })} hint="Je Mitarbeiter und Monat, inkl. USt." />
              <InputField label="Einführungsangebot von" optional type="date" value={f.from} onValue={(v) => setF({ ...f, from: v })} hint="Anlagedatum des Mandanten. Beide leer = kein Angebot." />
              <InputField label="Einführungsangebot bis" optional type="date" value={f.until} onValue={(v) => setF({ ...f, until: v })} />
              <InputField label="Testphase (Monate)" inputMode="numeric" value={f.months} onValue={(v) => setF({ ...f, months: v })} hint="Kostenlos bis zum Ende des Kalendermonats, in dem diese Monate enden." />
              <InputField label="Kündigungsfrist (Tage)" inputMode="numeric" value={f.notice} onValue={(v) => setF({ ...f, notice: v })} hint="Tage vor Ende der Abo-Laufzeit. 0 = bis zum letzten Tag." />
            </div>
            <SelectField label="Willkommenscode" value={f.welcome} onValue={(v) => setF({ ...f, welcome: v })}
              options={[{ value: "", label: "Kein Willkommenscode" }, ...codes.map((c) => ({ value: c.id, label: `${c.code} (−${c.discountPercent} %)${c.endedAt ? " – beendet" : ""}` }))]}
              hint={<>Steht in der Einladung jedes neu angelegten Mandanten, solange er einlösbar ist. Kundenhinweis: {PROMO_TERMS_NOTE}</>} />
            <InputField label="Grund (Protokoll)" value={f.reason} onValue={(v) => setF({ ...f, reason: v })} maxLength={500} />
            <p class="xsmall muted mb-0">Neue Preise gelten für alle nicht abgeschlossenen Monate. Abgeschlossene Monate und Rechnungen bleiben unverändert.</p>
            {error && <Alert tone="danger" live>{error}</Alert>}
            <div><Button type="submit" icon="check" busy={busy}>Einstellungen speichern</Button></div>
          </form>
        )}
      </Card>
      <h2>Lizenzen</h2>
      <div class="grid-2">
        {plansFor(null).map((p) => (
          <Card key={p.plan} title={PLAN_LABEL[p.plan]} accent={p.plan === "pilot_free"}>
            <p class="muted small">{p.text}</p>
            <dl class="kv">
              <dt>Preis</dt><dd>{p.plan === "pilot_free" ? "0,00 € – Kostenlos – Pilot" : `${formatEuro(current)} (12-Monats-Abo) oder ${formatEuro(monthly)} (Monatstarif) je Mitarbeiter/Monat`}</dd>
              <dt>Mitarbeitende</dt><dd>{p.employees}</dd>
              <dt>Abrechnung</dt><dd>{p.plan === "pilot_free" ? "keine" : "manuell"}</dd>
            </dl>
          </Card>
        ))}
      </div>
    </div>
  );
}

const BILLING_STATUSES: BillingStatus[] = ["open", "invoiced", "paid", "waived"];

function RevenuePage({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const now = currentMonth();
  const months = monthsBack(now, "2026-01", 24);
  const [month, setMonth] = useState(now);
  const [tick, setTick] = useState(0);
  const q = useAsync(() => repo.getPlatformRevenue(month), [month, tick]);
  const [editing, setEditing] = useState<PlatformRevenueRow | null>(null);
  const [form, setForm] = useState<{ status: BillingStatus; note: string }>({ status: "invoiced", note: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<PlanFilter>("all");
  const r = q.data;
  const rows = r ? r.rows.filter((x) => planMatches(x, plan)) : [];
  const countOf = (f: PlanFilter) => (r ? r.rows.filter((x) => planMatches(x, f)).length : 0);
  const closable = month < now;

  const open = (row: PlatformRevenueRow) => {
    setEditing(row);
    setError(null);
    setForm({ status: row.status === "open" ? "invoiced" : row.status, note: row.note ?? "" });
  };
  const save = async (e: Event) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true); setError(null);
    try {
      await repo.setBillingStatus(editing.tenantId, month, form.status, form.note.trim() || undefined);
      toast(`Abrechnungsstatus „${BILLING_STATUS_LABEL[form.status]}“ gespeichert.`);
      setEditing(null);
      setTick((x) => x + 1);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <div class="stack">
      <h1 class="page-title">Umsatz</h1>
      <p class="muted">Nur Zahlen je Mandant – keine Namen von Mitarbeitenden. Beträge brutto, {VAT_NOTE}</p>
      <Card>
        <div class="toolbar">
          <SelectField label="Monat" value={month} onValue={setMonth}
            options={months.map((m) => ({ value: m, label: m === now ? `${monthLabelDE(m)} (laufend, Vorschau)` : monthLabelDE(m) }))} />
          <SelectField label="Tarif" value={plan} onValue={(v) => setPlan(v as PlanFilter)} options={[
            { value: "all", label: "Alle" }, { value: "annual", label: "12-Monats-Abo" }, { value: "monthly", label: "Monatstarif" },
            { value: "trial", label: "Testphase" }, { value: "ended", label: "Kein laufender Vertrag" },
          ]} />
          {r && <p class="small muted mb-0">12-Monats-Abo {formatEuro(r.defaultPriceCents)} · Zahlungsdienstleister: {r.paymentProvider === "none" ? "keiner (manuelle Abrechnung)" : r.paymentProvider}</p>}
        </div>
      </Card>
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      {r && (
        <>
          <div class="grid-4">
            <StatTile label="Abrechenbare Mitarbeitende" value={r.totals.billableCount} hint="ohne Demo-Mandanten" />
            <StatTile label="Umsatz brutto" value={formatEuro(r.totals.amountCents)} hint="ohne Demo, ohne erlassene Monate" tone="brand" />
            <StatTile label="Erlassen" value={formatEuro(r.totals.waivedCents)} />
            <StatTile label="Demo-Mandanten" value={formatEuro(r.totals.demoAmountCents)} hint="kein Umsatz" />
          </div>
          <p class="small muted" data-testid="revenue-plans">{countOf("annual")} im 12-Monats-Abo · {countOf("monthly")} im Monatstarif · {countOf("trial")} in der Testphase · {countOf("ended")} ohne laufenden Vertrag</p>
          {!closable && <Alert tone="info" title="Laufender Monat"><p>Vorschau. Der Abrechnungsstatus kann erst nach Monatsende gesetzt werden; dabei werden Anzahl und Betrag festgeschrieben.</p></Alert>}
          <Card>
            <Table<PlatformRevenueRow>
              caption="Umsatz je Mandant"
              rows={rows}
              rowKey={(x) => x.tenantId}
              empty={<p class="muted">Keine Mandanten in diesem Monat{plan !== "all" ? " mit diesem Tarif" : ""}.</p>}
              columns={[
                { key: "n", header: "Mandant", render: (x) => <><a href={`#/mandant/${x.tenantId}`}><strong>{x.tenantName}</strong></a>{x.isDemo && <div class="xsmall muted">Demo-Mandant</div>}</> },
                { key: "k", header: "Kondition", render: (x) => (
                  <span class="small">
                    {conditionText(x)}
                    {x.promoCode && <> {x.promoCode}{x.promoDiscountPercent ? ` (−${x.promoDiscountPercent} %)` : ""}</>}
                    {x.blockSince && <><br />gesperrt seit {dateTimeDE(x.blockSince)}{x.blockReason ? ` – ${x.blockReason}` : ""}</>}
                  </span>
                ) },
                { key: "c", header: "Abrechenbar", align: "right", render: (x) => <span class="num">{x.billableCount}</span> },
                { key: "p", header: "Preis je MA", align: "right", render: (x) => <span class="num">{formatEuro(x.unitPriceCents)}</span> },
                { key: "a", header: "Summe brutto", align: "right", render: (x) => <span class="num">{formatEuro(x.amountCents)}</span> },
                { key: "s", header: "Status", render: (x) => <><StatusPill status={x.status} label={x.status === "open" && !closable ? "Vorschau" : undefined} />{x.final && <div class="xsmall muted">festgeschrieben</div>}{x.note && <div class="xsmall muted">{x.note}</div>}</> },
                ...(!readOnly && closable ? [{
                  key: "x", header: "Aktionen", actions: true,
                  render: (x: PlatformRevenueRow) => <Button size="sm" variant="secondary" onClick={() => open(x)} aria-label={`Abrechnungsstatus ${x.tenantName} ändern`}>Status ändern</Button>,
                }] : []),
              ]}
            />
          </Card>
        </>
      )}
      <Dialog open={editing !== null} title={editing ? `Abrechnung ${editing.tenantName}, ${monthLabelDE(month)}` : ""} onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Abbrechen</Button><Button type="submit" form="billing-form" busy={busy}>Speichern</Button></>}>
        <form id="billing-form" class="stack" onSubmit={save} noValidate>
          <SelectField label="Abrechnungsstatus" value={form.status} onValue={(v) => setForm({ ...form, status: v as BillingStatus })}
            options={BILLING_STATUSES.map((st) => ({ value: st, label: BILLING_STATUS_LABEL[st]! }))}
            hint={form.status === "open" ? "Wiederöffnen hebt die Festschreibung auf (Grund erforderlich)." : "Anzahl und Betrag werden beim ersten Abschluss festgeschrieben."} />
          <TextareaField label={form.status === "waived" || (form.status === "open" && editing?.final) ? "Grund / Notiz (Pflicht)" : "Notiz (z. B. Rechnungsnummer)"} optional={!(form.status === "waived" || (form.status === "open" && editing?.final))}
            value={form.note} onValue={(v) => setForm({ ...form, note: v })} maxLength={500} />
          {error && <Alert tone="danger" live>{error}</Alert>}
        </form>
      </Dialog>
    </div>
  );
}

function SupportPage() {
  return (
    <div class="stack">
      <h1 class="page-title">Supportzugriff – Konzept</h1>
      <Card>
        <ol class="stack-sm" style={{ margin: 0, paddingLeft: "1.3em" }}>
          <li><strong>Standard: kein Zugriff.</strong> Plattform-Administratoren sehen nur Mandanten, Lizenzen und Anzahl der Mitarbeitenden – keine Namen, keine Arbeitszeiten.</li>
          <li><strong>Freigabe durch den Mandanten.</strong> Der Inhaber gibt im Chef-Portal einen Supportzugriff für max. 72 Stunden frei und kann ihn jederzeit beenden.</li>
          <li><strong>Nur lesend.</strong> Auch mit Freigabe kann der Support keine Arbeitszeiten ändern.</li>
          <li><strong>Protokolliert.</strong> Freigabe, Ende und jeder Zugriff werden im Protokoll des Mandanten und der Plattform gespeichert.</li>
          <li><strong>Technisch abgesichert.</strong> In der Produktivversion setzt die zentrale Datenbank die Mandantentrennung durch – nicht nur die Oberfläche.</li>
        </ol>
      </Card>
    </div>
  );
}

function uptimeText(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} Tg. ${h} Std.` : h ? `${h} Std. ${m} Min.` : `${m} Min.`;
}

const TENANT_STATUS_DE: Record<string, string> = { active: "aktiv", suspended: "gesperrt", deactivated: "deaktiviert", pending: "in Vorbereitung" };

interface StatusItem { name: string; status: string; ok: boolean | null; note: string }

/** Technical overview (super_admin + support): numbers and states only, no secrets. */
function SystemPage() {
  const q = useAsync(() => repo.getSystemOverview(), []);
  const o = q.data;
  let items: StatusItem[] = [];
  if (IS_DEMO) {
    items = [
      { name: "Anwendung", status: "Demo-Build", ok: true, note: "Läuft vollständig im Browser mit erfundenen Daten." },
      { name: "Server / Datenbank", status: "Nicht verbunden", ok: null, note: "Demo-Modus – im Betrieb: eigener Server mit PostgreSQL (docs/betrieb.md)." },
      { name: "E-Mail-Versand (SMTP)", status: "Nicht eingerichtet", ok: null, note: "In der Demo werden keine E-Mails versendet." },
      { name: "Zahlungsdienst", status: "keiner", ok: true, note: "Manuelle Abrechnung, keine Abbuchungen, keine Kontodaten." },
      { name: "Letzte Sicherung", status: "nicht bekannt", ok: null, note: "Demo-Daten liegen nur in diesem Browser." },
    ];
  } else if (q.error) {
    items = [{ name: "Server / Datenbank", status: "Nicht erreichbar", ok: false, note: q.error }];
  } else if (o) {
    items = [
      { name: "Version", status: o.version ? `v${o.version}` : "nicht bekannt", ok: !!o.version, note: o.commit ? `Commit ${o.commit.slice(0, 12)}` : "Commit nicht gesetzt (APP_COMMIT)." },
      { name: "Server", status: o.production ? "Produktivbetrieb" : "Entwicklung/Test", ok: true, note: `Läuft seit ${uptimeText(o.uptimeSeconds)} · Node ${o.nodeVersion} · Serverzeit ${dateTimeDE(o.serverTime)}` },
      { name: "Datenbank", status: o.database.reachable ? "Erreichbar" : "Nicht erreichbar", ok: o.database.reachable, note: o.database.time ? `Datenbankzeit ${dateTimeDE(o.database.time)}` : "" },
      { name: "Migrationsstand", status: o.migrations ? `${o.migrations.count} Migrationen` : "nicht bekannt", ok: o.migrations ? true : null,
        note: o.migrations ? `Zuletzt: ${o.migrations.latest ?? "—"}${o.migrations.appliedAt ? `, eingespielt ${dateTimeDE(o.migrations.appliedAt)}` : ""}` : "Migrationen wurden nicht über den Server eingespielt." },
      { name: "Aktive Sitzungen", status: o.activeSessions == null ? "nicht bekannt" : String(o.activeSessions), ok: null, note: "Angemeldete Geräte (nicht abgelaufen, nicht abgemeldet)." },
      { name: "E-Mail-Versand (SMTP)", status: o.mail.configured ? "Eingerichtet" : "Nicht eingerichtet", ok: o.mail.configured,
        note: o.mail.configured ? "Einladungen und Passwort-Links werden per E-Mail versendet." : "Einladungslinks können im Chef-Portal per WhatsApp geteilt oder kopiert werden." },
      { name: "Zahlungsdienst", status: o.paymentProvider === "none" ? "keiner" : o.paymentProvider, ok: true, note: "Manuelle Abrechnung, keine Abbuchungen, keine Kontodaten." },
      { name: "Letzte Sicherung", status: o.lastBackupAt ? dateTimeDE(o.lastBackupAt) : "nicht bekannt", ok: o.lastBackupAt ? Date.now() - Date.parse(o.lastBackupAt) < 36 * 3600000 : null,
        note: o.lastBackupAt ? "Zeitstempel der letzten erfolgreichen Sicherung (BACKUP_STATUS_FILE). Wiederherstellung regelmäßig testen." : "Der Server kennt keinen Sicherungszeitpunkt (BACKUP_STATUS_FILE nicht gesetzt)." },
      { name: "Mandanten", status: String(Object.values(o.tenants).reduce((a, b) => a + b, 0)), ok: null,
        note: Object.entries(o.tenants).map(([k, v]) => `${v} ${TENANT_STATUS_DE[k] ?? k}`).join(" · ") || "keine" },
    ];
  }
  return (
    <div class="stack">
      <h1 class="page-title">Systemstatus</h1>
      <p class="muted">Technische Übersicht ohne Geheimnisse und ohne Personendaten.</p>
      {IS_DEMO && <Alert tone="info"><p>Demo-Modus: Die Werte des echten Servers erscheinen im Betrieb mit der eigenen API.</p></Alert>}
      <Card>
        {q.loading && !IS_DEMO ? <p class="muted" role="status">Wird geprüft …</p> : (
          <ul class="status-list" data-testid="system-status">
            {items.map((i) => (
              <li key={i.name}>
                <span style={{ color: i.ok === true ? "var(--color-success)" : i.ok === false ? "var(--color-danger, #b42318)" : "var(--color-text-muted)" }}>
                  <Icon name={i.ok === true ? "checkCircle" : i.ok === false ? "alert" : "info"} />
                </span>
                <div class="status-text"><strong>{i.name}</strong><div class="small muted">{i.note}</div></div>
                <Badge tone={i.ok === true ? "success" : i.ok === false ? "danger" : "neutral"}>{i.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}


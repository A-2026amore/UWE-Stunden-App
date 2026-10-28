import { useEffect, useState } from "preact/hooks";
import type { AuditEvent, BillingStatus, License, LicensePlan, PlatformRevenueRow, Tenant } from "../../core/types";
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

const repo = getRepository("admin");

const checkArea = (s: Session): string | null => (s.platformRole ? null : "Dieses Konto hat keinen Zugang zur Plattform-Administration.");

const NAV: NavGroup[] = [
  { label: "Kunden", items: [
    { href: "#/", label: "Mandanten", icon: "building", match: "/" },
    { href: "#/umsatz", label: "Umsatz", icon: "chart", match: "/umsatz" },
    { href: "#/lizenzen", label: "Preismodell", icon: "key", match: "/lizenzen" },
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
  { plan: "pilot_free", text: "Pilotkunden: dauerhaft kostenlos, ohne Zahlungsdaten, ohne Rechnungen, keine automatische Umstellung auf ein kostenpflichtiges Modell.", employees: "unbegrenzt" },
  { plan: "standard", text: "Zeiterfassung, Monatsnachweise, Chef-Portal. Preis: Standardpreis je abrechenbarem Mitarbeiter.", employees: "bis 25 (Standard-Obergrenze)" },
  { plan: "business", text: "Wie Standard, höhere Mitarbeiter-Obergrenze. Gleicher Preis je Mitarbeiter.", employees: "bis 100 (Standard-Obergrenze)" },
  { plan: "enterprise", text: "Individuelle Vereinbarung, ohne Obergrenze. Gleicher Preis je Mitarbeiter, sofern keine Sonderkondition.", employees: "unbegrenzt" },
];

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

function useDefaultPrice(): number {
  const q = useAsync(() => repo.getBillingSettings(), []);
  return q.data?.defaultPriceCents ?? DEFAULT_EMPLOYEE_PRICE_CENTS;
}

export function AdminApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useRoute();
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
  else if (route.path === "/lizenzen") page = <PlansPage readOnly={readOnly} />;
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

const TRIAL_DAYS = 30;

function addDaysISO(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface NewTenantForm {
  name: string; slug: string; ownerEmail: string; plan: LicensePlan; isDemo: boolean;
  free: boolean; freeUntil: string; freeNote: string;
}
const EMPTY_TENANT: NewTenantForm = { name: "", slug: "", ownerEmail: "", plan: "pilot_free", isDemo: false, free: false, freeUntil: "", freeNote: "" };

/** Free test customer: licence "Standard" with the special condition "kostenloses Konto", limited to 30 days (changeable). */
function trialForm(): NewTenantForm {
  return { ...EMPTY_TENANT, plan: "standard", free: true, freeUntil: addDaysISO(TRIAL_DAYS), freeNote: "Kostenloser Testzeitraum" };
}

const isTrial = (t: TenantOverview) => !!t.license && t.license.plan !== "pilot_free" && t.license.freeOfCharge;

function TenantsPage({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const now = currentMonth();
  const q = useAsync(async () => {
    const [tenants, revenue] = await Promise.all([repo.listTenants(), repo.getPlatformRevenue(now)]);
    return { tenants, revenue };
  }, [tick]);
  const defaultPrice = useDefaultPrice();
  const [creating, setCreating] = useState<"tenant" | "trial" | null>(null);
  const [f, setF] = useState<NewTenantForm>(EMPTY_TENANT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");

  const all = q.data?.tenants ?? [];
  const list = all.filter((t) => statusFilter === "all" || (statusFilter === "trial" ? isTrial(t) : t.tenant.status === statusFilter));
  const count = (st: string) => all.filter((t) => t.tenant.status === st).length;
  const pilots = all.filter((t) => t.license?.plan === "pilot_free").length;
  const trials = all.filter(isTrial).length;
  const real = all.filter((t) => !t.tenant.isDemo);
  const employees = all.reduce((s, t) => s + t.employeeCount, 0);
  const activeEmployees = real.reduce((s, t) => s + t.activeEmployeeCount, 0);
  const revenue = q.data?.revenue;

  const open = (kind: "tenant" | "trial") => { setCreating(kind); setError(null); setF(kind === "trial" ? trialForm() : EMPTY_TENANT); };

  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const free = f.free && f.plan !== "pilot_free";
      const o = await repo.createTenant({
        name: f.name, slug: f.slug, plan: f.plan, isDemo: f.isDemo, ownerEmail: f.ownerEmail,
        ...(free ? { freeOfCharge: true, conditionNote: f.freeNote.trim() || null, conditionValidUntil: f.freeUntil || null } : {}),
      });
      const what = free ? "Kostenloser Testkunde" : "Mandant";
      toast(IS_DEMO
        ? `${what} „${o.tenant.name}“ angelegt. Einladung an ${f.ownerEmail} (Demo: Passwort „demo“).`
        : `${what} „${o.tenant.name}“ angelegt. Die Einladung wurde per E-Mail an ${f.ownerEmail} gesendet.`);
      setCreating(null);
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
            <Button variant="secondary" icon="plus" onClick={() => open("trial")}>Kostenlosen Testkunden anlegen</Button>
            <Button icon="plus" onClick={() => open("tenant")}>Mandant anlegen</Button>
          </div>
        )}
      </div>
      <div class="grid-4" data-testid="platform-kpis">
        <StatTile icon="building" label="Mandanten" value={all.length} hint={`${count("active")} aktiv · ${count("suspended")} gesperrt · ${count("deactivated")} deaktiviert${count("pending") ? ` · ${count("pending")} in Vorbereitung` : ""}`} />
        <StatTile icon="users" label="Mitarbeitende gesamt" value={employees} hint={`${activeEmployees} aktiv bei Kunden (ohne Demo) · nur Anzahl, keine Personendaten`} />
        <StatTile icon="euro" label={`Umsatz netto ${monthLabelDE(now)}`} value={revenue ? formatEuro(revenue.totals.amountCents) : "—"} tone="brand"
          hint={revenue ? `Vorschau · ${revenue.totals.billableCount} abrechenbare Mitarbeitende · ohne Demo` : undefined} />
        <StatTile icon="sparkles" label="Pilotkunden (kostenlos)" value={pilots} hint={`${trials} kostenlose Testkunden`} />
      </div>
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      <Card>
        <div class="toolbar">
          <SelectField label="Anzeigen" value={statusFilter} onValue={setStatusFilter} options={[
            { value: "all", label: "Alle" }, { value: "active", label: "Aktiv" }, { value: "pending", label: "In Vorbereitung" },
            { value: "suspended", label: "Gesperrt" }, { value: "deactivated", label: "Deaktiviert" }, { value: "trial", label: "Kostenlose Testkunden" },
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
            { key: "p", header: "Preis", render: (t) => <span class="small">{priceText(t.license, defaultPrice)}</span> },
            { key: "e", header: "Mitarbeitende", align: "right", render: (t) => <span class="num">{t.activeEmployeeCount} / {t.employeeCount}{t.license?.maxEmployees ? ` (max. ${t.license.maxEmployees})` : ""}</span> },
            { key: "u", header: "Umsatz (Monat)", align: "right", render: (t) => {
              const r = revenue?.rows.find((x) => x.tenantId === t.tenant.id);
              return <span class="num">{r ? formatEuro(r.amountCents) : "—"}</span>;
            } },
            { key: "a", header: "Aktionen", actions: true, render: (t) => <LinkButton size="sm" href={`#/mandant/${t.tenant.id}`} aria-label={`${t.tenant.name} verwalten`}>Verwalten</LinkButton> },
          ]}
        />
      </Card>

      <Dialog open={creating !== null} title={creating === "trial" ? "Kostenlosen Testkunden anlegen" : "Mandant anlegen"} onClose={() => setCreating(null)}
        footer={<><Button variant="secondary" onClick={() => setCreating(null)}>Abbrechen</Button><Button type="submit" form="tenant-form" busy={busy}>Anlegen</Button></>}>
        <form id="tenant-form" class="stack" onSubmit={create} noValidate>
          <InputField label="Firmenname" value={f.name} onValue={(v) => setF({ ...f, name: v, slug: f.slug && f.slug !== slugify(f.name) ? f.slug : slugify(v) })} data-autofocus />
          <InputField label="Kurzname (URL)" value={f.slug} onValue={(v) => setF({ ...f, slug: v })} hint="Kleinbuchstaben, Ziffern und Bindestriche." />
          <InputField label="E-Mail des Inhabers" type="email" value={f.ownerEmail} onValue={(v) => setF({ ...f, ownerEmail: v })} hint="Erhält die Einladung zum Chef-Portal (einmaliger Link, kein Passwort)." />
          <SelectField label="Lizenz" value={f.plan} onValue={(v) => setF({ ...f, plan: v as LicensePlan })} options={PLANS.map((p) => ({ value: p.plan, label: PLAN_LABEL[p.plan]! }))}
            hint={f.plan === "pilot_free" ? "Kostenlos, unbefristet, keine Zahlungsdaten, keine Rechnungen." : `Standardpreis ${formatEuro(defaultPrice)} netto je abrechenbarem Mitarbeiter und Monat; Sonderkonditionen danach im Mandanten.`} />
          {f.plan !== "pilot_free" && (
            <fieldset class="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend><strong>Kostenloser Testkunde</strong></legend>
              <Checkbox label="Kostenlos testen" hint="Es wird nichts berechnet. Danach gilt automatisch der normale Preis – keine Zahlungsdaten nötig."
                checked={f.free} onChange={(v) => setF({ ...f, free: v, freeUntil: v && !f.freeUntil ? addDaysISO(TRIAL_DAYS) : f.freeUntil })} />
              {f.free && <>
                <InputField label="Kostenlos bis" optional type="date" value={f.freeUntil} onValue={(v) => setF({ ...f, freeUntil: v })} hint="Leer = unbefristet kostenlos." />
                <InputField label="Notiz zur Kondition" optional value={f.freeNote} onValue={(v) => setF({ ...f, freeNote: v })} maxLength={500} />
              </>}
            </fieldset>
          )}
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
    const [audit, grant, revenue] = await Promise.all([repo.listAudit(id, 50), repo.getSupportGrant(id), repo.getPlatformRevenue(currentMonth())]);
    return { o, audit, grant, billing: revenue.rows.find((r) => r.tenantId === id) ?? null, defaultPrice: revenue.defaultPriceCents };
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
  const { o, audit, grant, billing, defaultPrice } = q.data;
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
              <dt>Preis</dt><dd data-testid="tenant-price">{priceText(o.license, defaultPrice)}</dd>
              <dt>Abrechnung</dt><dd>{o.license?.plan === "pilot_free" ? "keine (keine Zahlungsdaten, keine Rechnungen)" : "manuell (Status je Monat unter „Umsatz“)"}</dd>
              <dt>Gültig ab</dt><dd>{o.license ? formatDateDE(o.license.validFrom) : "—"}</dd>
              <dt>Gültig bis</dt><dd>{o.license?.validUntil ? formatDateDE(o.license.validUntil) : "unbefristet"}</dd>
            </dl>
            <SelectField label="Lizenzmodell" value={lic.plan} onValue={(v) => setLic({ ...lic, plan: v as LicensePlan })} disabled={readOnly}
              options={PLANS.map((p) => ({ value: p.plan, label: PLAN_LABEL[p.plan]! }))} />
            {lic.plan === "pilot_free"
              ? <Alert tone="success" title="Kostenlos – Pilot"><p>Preis 0 €, unbegrenzte Mitarbeitende, unbefristet. Keine Zahlungsdaten, keine Rechnungen, keine automatische Umstellung.</p></Alert>
              : <>
                  <InputField label="Max. Mitarbeitende" optional inputMode="numeric" value={lic.maxEmployees} onValue={(v) => setLic({ ...lic, maxEmployees: v })} disabled={readOnly} hint="Leer = unbegrenzt" />
                  <InputField label="Gültig bis" optional type="date" value={lic.validUntil} onValue={(v) => setLic({ ...lic, validUntil: v })} disabled={readOnly} />
                  <fieldset class="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend><strong>Sonderkondition</strong></legend>
                    <Checkbox label="Kostenloses Konto" hint="z. B. Test- oder Pilotkunde ohne Pilot-Lizenz – es wird nichts berechnet." checked={lic.free} onChange={(v) => setLic({ ...lic, free: v })} disabled={readOnly} />
                    <InputField label="Sonderpreis je Mitarbeiter (€ netto)" optional inputMode="decimal" value={lic.price} onValue={(v) => setLic({ ...lic, price: v })} disabled={readOnly || lic.free}
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
              <dt>Preis je Mitarbeiter</dt><dd>{formatEuro(billing.unitPriceCents)} ({BILLING_CONDITION_LABEL[billing.condition]})</dd>
              <dt>Summe netto</dt><dd>{formatEuro(billing.amountCents)} <span class="xsmall muted">{VAT_NOTE}</span></dd>
            </dl>
          : <p class="muted">Keine Daten.</p>}
        <p class="xsmall muted">Nur Zahlen – Namen sieht ausschließlich der Mandant selbst. <a href="#/umsatz">Alle Monate unter „Umsatz“</a></p>
      </Card>
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

function PlansPage({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const q = useAsync(() => repo.getBillingSettings(), [tick]);
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const current = q.data?.defaultPriceCents ?? DEFAULT_EMPLOYEE_PRICE_CENTS;

  const save = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      const cents = parseEuro(price);
      await repo.setDefaultPrice(cents, reason);
      toast(`Standardpreis auf ${formatEuro(cents)} gesetzt.`);
      setPrice(""); setReason(""); setTick((x) => x + 1);
    } catch (err) { setError(errorText(err)); }
  };

  return (
    <div class="stack">
      <h1 class="page-title">Preismodell</h1>
      <Card title="Preis je Mitarbeiter" accent>
        <p class="stat-value" data-testid="default-price">{formatEuro(current)} <span class="small muted">netto je abrechenbarem Mitarbeiter und Monat, {VAT_NOTE}</span></p>
        <ul class="stack-sm small" style={{ margin: 0, paddingLeft: "1.3em" }}>
          <li>Keine Grundgebühr, keine Mindestanzahl, keine Staffeln. Beispiele: 5 → {formatEuro(5 * current)}, 20 → {formatEuro(20 * current)}, 100 → {formatEuro(100 * current)}.</li>
          <li>Abrechenbar: Mitarbeiter/innen, die im Monat mindestens zeitweise aktiv waren. Gesperrte/deaktivierte ab dem Folgemonat nicht mehr; nur eingeladene nie.</li>
          <li>Inhaber und Vorgesetzte kostenlos, solange sie im Monat keine eigenen Arbeitszeiten erfassen.</li>
          <li>Sonderkonditionen (eigener Preis, kostenloses Konto, Gültigkeit) je Mandant unter „Mandanten“ → „Verwalten“.</li>
          <li>Kein Zahlungsdienstleister angebunden: Abrechnung manuell, keine Abbuchungen, keine Kontodaten.</li>
        </ul>
        {!readOnly && (
          <form class="stack" onSubmit={save} noValidate style={{ marginTop: "var(--space-4)" }}>
            <div class="grid-2">
              <InputField label="Neuer Standardpreis (€ netto)" inputMode="decimal" value={price} onValue={setPrice} hint="Gilt für alle nicht abgeschlossenen Monate ohne Sonderkondition." />
              <InputField label="Grund (Protokoll)" value={reason} onValue={setReason} />
            </div>
            {error && <Alert tone="danger" live>{error}</Alert>}
            <div><Button type="submit" icon="check">Standardpreis speichern</Button></div>
          </form>
        )}
      </Card>
      <h2>Lizenzen</h2>
      <div class="grid-2">
        {PLANS.map((p) => (
          <Card key={p.plan} title={PLAN_LABEL[p.plan]} accent={p.plan === "pilot_free"}>
            <p class="muted small">{p.text}</p>
            <dl class="kv">
              <dt>Preis</dt><dd>{p.plan === "pilot_free" ? "0,00 € – Kostenlos – Pilot" : `${formatEuro(current)} je Mitarbeiter/Monat`}</dd>
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
  const r = q.data;
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
      <p class="muted">Nur Zahlen je Mandant – keine Namen von Mitarbeitenden. Beträge netto, {VAT_NOTE}</p>
      <Card>
        <div class="toolbar">
          <SelectField label="Monat" value={month} onValue={setMonth}
            options={months.map((m) => ({ value: m, label: m === now ? `${monthLabelDE(m)} (laufend, Vorschau)` : monthLabelDE(m) }))} />
          {r && <p class="small muted mb-0">Standardpreis {formatEuro(r.defaultPriceCents)} · Zahlungsdienstleister: {r.paymentProvider === "none" ? "keiner (manuelle Abrechnung)" : r.paymentProvider}</p>}
        </div>
      </Card>
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      {r && (
        <>
          <div class="grid-4">
            <StatTile label="Abrechenbare Mitarbeitende" value={r.totals.billableCount} hint="ohne Demo-Mandanten" />
            <StatTile label="Umsatz netto" value={formatEuro(r.totals.amountCents)} hint="ohne Demo, ohne erlassene Monate" tone="brand" />
            <StatTile label="Erlassen" value={formatEuro(r.totals.waivedCents)} />
            <StatTile label="Demo-Mandanten" value={formatEuro(r.totals.demoAmountCents)} hint="kein Umsatz" />
          </div>
          {!closable && <Alert tone="info" title="Laufender Monat"><p>Vorschau. Der Abrechnungsstatus kann erst nach Monatsende gesetzt werden; dabei werden Anzahl und Betrag festgeschrieben.</p></Alert>}
          <Card>
            <Table<PlatformRevenueRow>
              caption="Umsatz je Mandant"
              rows={r.rows}
              rowKey={(x) => x.tenantId}
              empty={<p class="muted">Keine Mandanten in diesem Monat.</p>}
              columns={[
                { key: "n", header: "Mandant", render: (x) => <><a href={`#/mandant/${x.tenantId}`}><strong>{x.tenantName}</strong></a>{x.isDemo && <div class="xsmall muted">Demo-Mandant</div>}</> },
                { key: "k", header: "Kondition", render: (x) => <span class="small">{BILLING_CONDITION_LABEL[x.condition]}</span> },
                { key: "c", header: "Abrechenbar", align: "right", render: (x) => <span class="num">{x.billableCount}</span> },
                { key: "p", header: "Preis je MA", align: "right", render: (x) => <span class="num">{formatEuro(x.unitPriceCents)}</span> },
                { key: "a", header: "Summe netto", align: "right", render: (x) => <span class="num">{formatEuro(x.amountCents)}</span> },
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


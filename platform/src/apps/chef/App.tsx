import { useEffect, useState } from "preact/hooks";
import type { Employee, Tenant } from "../../core/types";
import type { Session } from "../../data/repository";
import { Avatar, Button, DialogProvider, Sidebar, ThemeSwitch, ToastProvider, applyBranding, type NavGroup } from "../../design";
import { getRepository, onAuthFailure } from "../shared/repo";
import { useRoute } from "../shared/router";
import { LoginScreen, ProductMark, TenantLogo, rememberTenant } from "../shared/ui";
import { TwoFactorGate } from "../shared/twoFactor";
import { ROLE_LABEL, currentMonth } from "../shared/format";
import { shiftMonth } from "../../data/demo";
import { errorText } from "../shared/hooks";
import { Ctx, type ChefCtx } from "./context";
import { DashboardPage } from "./pages/Dashboard";
import { EmployeesPage } from "./pages/Employees";
import { TimesPage } from "./pages/Times";
import { HoursPage } from "./pages/Hours";
import { StatementsPage } from "./pages/Statements";
import { AccountsPage } from "./pages/Accounts";
import { CompanyPage } from "./pages/Company";
import { SettingsPage } from "./pages/Settings";
import { AuditPage } from "./pages/Audit";
import { CorrectionsPage } from "./pages/Corrections";
import { BillingPage } from "./pages/Billing";
import { PrivacyPage } from "./pages/Privacy";
import { AppGuidePage } from "./pages/AppGuide";

const repo = getRepository("chef");

const checkArea = (s: Session): string | null =>
  (s.role === "owner" || s.role === "manager" ? null : "Dieses Konto hat keinen Zugang zum Chef-Portal. Mitarbeitende nutzen bitte die Mitarbeiter-App.");

/** Navigation in groups; counts (open items) are filled in at runtime. */
function navGroups(counts: { corrections: number; statements: number }): NavGroup[] {
  return [
    { label: "Übersicht", items: [
      { href: "#/", label: "Dashboard", icon: "chart", match: "/" },
    ] },
    { label: "Zeiten & Nachweise", items: [
      { href: "#/stunden", label: "Stundenübersicht", icon: "calendar", match: "/stunden" },
      { href: "#/zeiten", label: "Arbeitszeiten", icon: "clock", match: "/zeiten" },
      { href: "#/nachweise", label: "Monatsnachweise", icon: "fileCheck", match: "/nachweise", count: counts.statements },
      { href: "#/korrekturen", label: "Korrekturanfragen", icon: "message", match: "/korrekturen", count: counts.corrections },
      { href: "#/konten", label: "Arbeitszeitkonten", icon: "wallet", match: "/konten" },
    ] },
    { label: "Team", items: [
      { href: "#/mitarbeiter", label: "Mitarbeiter", icon: "users", match: "/mitarbeiter" },
    ] },
    { label: "Verwaltung", items: [
      { href: "#/firma", label: "Firmenprofil", icon: "building", match: "/firma" },
      { href: "#/abrechnung", label: "Abrechnung", icon: "creditCard", match: "/abrechnung" },
      { href: "#/einstellungen", label: "Einstellungen", icon: "settings", match: "/einstellungen" },
      { href: "#/datenschutz", label: "Datenschutz", icon: "shield", match: "/datenschutz" },
      { href: "#/protokoll", label: "Änderungsprotokoll", icon: "log", match: "/protokoll" },
    ] },
  ];
}

export function ChefApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [data, setData] = useState<{ tenant: Tenant; me: Employee } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [counts, setCounts] = useState({ corrections: 0, statements: 0 });
  const route = useRoute();
  // Close the phone/tablet menu whenever the page changes (also on back/forward).
  useEffect(() => { setMenuOpen(false); }, [route.path]);

  useEffect(() => {
    repo.currentSession().then((s) => {
      const problem = s ? checkArea(s) : null;
      if (problem) setNotice(problem);
      setSession(problem ? null : s);
    }, (e: unknown) => { setNotice(errorText(e)); setSession(null); });
  }, []);
  useEffect(() => onAuthFailure((f) => {
    // Mandatory 2FA switched on meanwhile: the session stays, only the setup is reachable.
    if (f.kind === "two_factor_setup") { setData(null); repo.currentSession().then(setSession, () => setSession(null)); return; }
    setNotice(f.message); setError(null); setData(null); setSession(null);
  }), []);
  useEffect(() => {
    if (!session?.tenantId || session.twoFactorSetupRequired) { setData(null); applyBranding(null); return; }
    Promise.all([repo.getTenant(session.tenantId), repo.listEmployees(session.tenantId)])
      .then(([tenant, list]) => {
        const me = list.find((e) => e.id === session.employeeId);
        if (!me) throw new Error("Benutzer nicht gefunden.");
        applyBranding(tenant.branding);
        rememberTenant("chef", tenant.name, tenant.branding);
        document.title = `Chef-Portal · ${tenant.name}`;
        setData({ tenant, me });
      })
      .catch((e) => setError(errorText(e)));
  }, [session]);

  // Open items for the navigation badges (best effort – errors only hide the badges).
  const tenantId = data?.tenant.id;
  useEffect(() => {
    if (!tenantId) return;
    const month = currentMonth();
    Promise.all([
      repo.listCorrectionRequests(tenantId, { status: "open" }),
      repo.listStatements(tenantId, month), repo.listStatements(tenantId, shiftMonth(month, -1)),
    ]).then(([c, a, b]) => setCounts({ corrections: c.length, statements: [...a, ...b].filter((x) => x.status === "submitted").length }),
      () => setCounts({ corrections: 0, statements: 0 }));
  }, [tenantId, version, route.path]);

  if (session === undefined) return <p class="sr-only" role="status">Wird geladen …</p>;
  if (!session) {
    return (
      <LoginScreen
        area="chef" title="Chef-Portal" subtitle="Anmeldung für Inhaber und Vorgesetzte."
        check={checkArea} notice={notice}
        onSignedIn={(s) => { setNotice(null); setError(null); setSession(s); location.hash = "#/"; }}
      />
    );
  }
  if (session.twoFactorSetupRequired) {
    return <TwoFactorGate repo={repo} session={session} onDone={setSession} onSignOut={async () => { await repo.signOut(); setSession(null); }} />;
  }
  if (error) {
    return <div class="auth"><div class="auth-card card stack"><h1>Fehler</h1><p>{error}</p><Button onClick={async () => { await repo.signOut(); setError(null); setSession(null); }}>Zur Anmeldung</Button></div></div>;
  }
  if (!data) return <p class="sr-only" role="status">Wird geladen …</p>;

  const ctx: ChefCtx = {
    repo, session, tenant: data.tenant, me: data.me, version,
    changed: () => setVersion((v) => v + 1),
    setTenant: (t) => { applyBranding(t.branding); setData({ ...data, tenant: t }); },
    signOut: async () => { await repo.signOut(); setSession(null); setData(null); },
  };

  let page;
  switch (route.path) {
    case "/mitarbeiter": page = <EmployeesPage />; break;
    case "/app-anleitung": page = <AppGuidePage />; break;
    case "/stunden": page = <HoursPage initialMonth={route.query.get("m")} initialEmployee={route.query.get("ma")} />; break;
    case "/zeiten": page = <TimesPage />; break;
    case "/nachweise": page = <StatementsPage initialMonth={route.query.get("m")} />; break;
    case "/korrekturen": page = <CorrectionsPage />; break;
    case "/konten": page = <AccountsPage />; break;
    case "/firma": page = <CompanyPage />; break;
    case "/einstellungen": page = <SettingsPage />; break;
    case "/protokoll": page = <AuditPage />; break;
    case "/abrechnung": page = <BillingPage />; break;
    case "/datenschutz": page = <PrivacyPage />; break;
    default: page = <DashboardPage />;
  }

  return (
    <Ctx.Provider value={ctx}>
      <ToastProvider>
        <DialogProvider>
          <a class="skip-link" href="#main">Zum Inhalt springen</a>
          <div class="d-shell">
            <div class="d-topbar">
              <Button variant="ghost" icon="menu" aria-label="Menü öffnen" aria-expanded={menuOpen ? "true" : "false"} aria-controls="sidebar" onClick={() => setMenuOpen(true)} />
              <TenantLogo name={data.tenant.name} branding={data.tenant.branding} />
              <div class="topbar-end"><Avatar name={data.me.displayName} small /></div>
            </div>
            <Sidebar
              groups={navGroups(counts)}
              current={route.path}
              open={menuOpen}
              onNavigate={() => setMenuOpen(false)}
              brand={<div class="stack-sm"><TenantLogo name={data.tenant.name} branding={data.tenant.branding} showSlogan /><span class="sidebar-area">Chef-Portal</span></div>}
              footer={
                <>
                  <div class="user-chip">
                    <Avatar name={data.me.displayName} />
                    <div class="user-chip-text"><strong>{data.me.displayName}</strong><span>{ROLE_LABEL[data.me.role]} · {data.tenant.name}</span></div>
                  </div>
                  <div class="sidebar-actions"><ThemeSwitch compact />
                  <Button variant="secondary" size="sm" icon="logout" onClick={ctx.signOut}>Abmelden</Button></div>
                  <div class="product-line"><ProductMark compact /></div>
                </>
              }
            />
            <main class="d-main" id="main">{page}</main>
          </div>
        </DialogProvider>
      </ToastProvider>
    </Ctx.Provider>
  );
}

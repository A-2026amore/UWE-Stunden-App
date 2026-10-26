import { useEffect, useState } from "preact/hooks";
import type { Employee, Tenant } from "../../core/types";
import type { Session } from "../../data/repository";
import { Button, DialogProvider, Sidebar, ToastProvider, applyBranding, type NavItem } from "../../design";
import { getRepository } from "../shared/repo";
import { useRoute } from "../shared/router";
import { LoginScreen, ProductMark, TenantLogo } from "../shared/ui";
import { ROLE_LABEL } from "../shared/format";
import { errorText } from "../shared/hooks";
import { Ctx, type ChefCtx } from "./context";
import { DashboardPage } from "./pages/Dashboard";
import { EmployeesPage } from "./pages/Employees";
import { TimesPage } from "./pages/Times";
import { StatementsPage } from "./pages/Statements";
import { AccountsPage } from "./pages/Accounts";
import { CompanyPage } from "./pages/Company";
import { SettingsPage } from "./pages/Settings";
import { AuditPage } from "./pages/Audit";

const repo = getRepository("chef");

const NAV: NavItem[] = [
  { href: "#/", label: "Dashboard", icon: "chart", match: "/" },
  { href: "#/mitarbeiter", label: "Mitarbeiter", icon: "users", match: "/mitarbeiter" },
  { href: "#/zeiten", label: "Arbeitszeiten", icon: "clock", match: "/zeiten" },
  { href: "#/nachweise", label: "Monatsnachweise", icon: "fileCheck", match: "/nachweise" },
  { href: "#/konten", label: "Arbeitszeitkonten", icon: "wallet", match: "/konten" },
  { href: "#/firma", label: "Firmenprofil", icon: "building", match: "/firma" },
  { href: "#/einstellungen", label: "Einstellungen", icon: "settings", match: "/einstellungen" },
  { href: "#/protokoll", label: "Änderungsprotokoll", icon: "log", match: "/protokoll" },
];

export function ChefApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [data, setData] = useState<{ tenant: Tenant; me: Employee } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useRoute();

  useEffect(() => { repo.currentSession().then(setSession); }, []);
  useEffect(() => {
    if (!session?.tenantId) { setData(null); applyBranding(null); return; }
    Promise.all([repo.getTenant(session.tenantId), repo.listEmployees(session.tenantId)])
      .then(([tenant, list]) => {
        const me = list.find((e) => e.id === session.employeeId);
        if (!me) throw new Error("Benutzer nicht gefunden.");
        applyBranding(tenant.branding);
        document.title = `Chef-Portal · ${tenant.name}`;
        setData({ tenant, me });
      })
      .catch((e) => setError(errorText(e)));
  }, [session]);

  if (session === undefined) return <p class="sr-only" role="status">Wird geladen …</p>;
  if (!session) {
    return (
      <LoginScreen
        area="chef" title="Chef-Portal" subtitle="Anmeldung für Inhaber und Vorgesetzte."
        check={(s) => (s.role === "owner" || s.role === "manager" ? null : "Dieses Konto hat keinen Zugang zum Chef-Portal. Mitarbeitende nutzen bitte die Mitarbeiter-App.")}
        onSignedIn={(s) => { setError(null); setSession(s); location.hash = "#/"; }}
      />
    );
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
    case "/zeiten": page = <TimesPage />; break;
    case "/nachweise": page = <StatementsPage />; break;
    case "/konten": page = <AccountsPage />; break;
    case "/firma": page = <CompanyPage />; break;
    case "/einstellungen": page = <SettingsPage />; break;
    case "/protokoll": page = <AuditPage />; break;
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
            </div>
            <Sidebar
              items={NAV}
              current={route.path}
              open={menuOpen}
              onNavigate={() => setMenuOpen(false)}
              brand={<div class="stack-sm"><TenantLogo name={data.tenant.name} branding={data.tenant.branding} showSlogan /><span class="xsmall muted">Chef-Portal</span></div>}
              footer={
                <div class="stack-sm">
                  <div><strong>{data.me.displayName}</strong><div class="xsmall muted">{ROLE_LABEL[data.me.role]} · {data.tenant.name}</div></div>
                  <Button variant="secondary" size="sm" icon="logout" onClick={ctx.signOut}>Abmelden</Button>
                  <div class="xsmall"><ProductMark compact /></div>
                </div>
              }
            />
            <main class="d-main" id="main">{page}</main>
          </div>
        </DialogProvider>
      </ToastProvider>
    </Ctx.Provider>
  );
}

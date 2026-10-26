import { useEffect, useState } from "preact/hooks";
import type { Employee, Tenant } from "../../core/types";
import type { Session } from "../../data/repository";
import { BottomNav, DialogProvider, ToastProvider, applyBranding, type NavItem } from "../../design";
import { getRepository } from "../shared/repo";
import { useRoute } from "../shared/router";
import { LoginScreen, TenantLogo, Watermark } from "../shared/ui";
import { currentMonth } from "../shared/format";
import { errorText } from "../shared/hooks";
import { Ctx, type EmployeeCtx } from "./context";
import { StartPage } from "./pages/Start";
import { EntryPage } from "./pages/Entry";
import { MonthPage } from "./pages/Month";
import { AccountPage } from "./pages/Account";
import { SettingsPage } from "./pages/Settings";

const NAV: NavItem[] = [
  { href: "#/", label: "Start", icon: "home", match: "/" },
  { href: "#/erfassen", label: "Erfassen", icon: "plusCircle", match: "/erfassen" },
  { href: "#/monat", label: "Monat", icon: "calendar", match: "/monat" },
  { href: "#/konto", label: "Konto", icon: "wallet", match: "/konto" },
  { href: "#/einstellungen", label: "Profil", icon: "settings", match: "/einstellungen" },
];

const repo = getRepository("app");

export function EmployeeApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [data, setData] = useState<{ tenant: Tenant; me: Employee } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [version, setVersion] = useState(0);
  const route = useRoute();

  useEffect(() => { repo.currentSession().then(setSession); }, []);

  useEffect(() => {
    if (!session?.tenantId || !session.employeeId) { setData(null); applyBranding(null); return; }
    Promise.all([repo.getTenant(session.tenantId), repo.listEmployees(session.tenantId)])
      .then(([tenant, list]) => {
        const me = list.find((e) => e.id === session.employeeId);
        if (!me) throw new Error("Mitarbeiterdaten nicht gefunden.");
        applyBranding(tenant.branding);
        document.title = `${tenant.name} · Zeiterfassung`;
        setData({ tenant, me });
      })
      .catch((e) => setError(errorText(e)));
  }, [session, version]);

  useEffect(() => {
    document.body.classList.toggle("has-bottom-nav", !!data);
  }, [data]);

  if (session === undefined) return <p class="sr-only" role="status">Wird geladen …</p>;

  if (!session) {
    return (
      <LoginScreen
        area="app"
        title="Anmeldung für Mitarbeitende"
        subtitle="Melde dich mit den Zugangsdaten deines Arbeitgebers an."
        check={(s) => (s.tenantId && s.employeeId ? null : "Dieses Konto gehört nicht zu einem Unternehmen. Bitte das Admin-Portal verwenden.")}
        onSignedIn={(s) => { setError(null); setSession(s); location.hash = "#/"; }}
      />
    );
  }

  if (error) {
    return (
      <div class="auth"><div class="auth-card card stack">
        <h1>Anmeldung nicht möglich</h1>
        <p>{error}</p>
        <button class="btn btn-primary" onClick={async () => { await repo.signOut(); setError(null); setSession(null); }}>Zur Anmeldung</button>
      </div></div>
    );
  }
  if (!data) return <p class="sr-only" role="status">Wird geladen …</p>;

  const ctx: EmployeeCtx = {
    repo, session, tenant: data.tenant, me: data.me, month, setMonth, version,
    changed: () => setVersion((v) => v + 1),
    signOut: async () => { await repo.signOut(); setSession(null); setData(null); },
  };

  let page;
  switch (route.path) {
    case "/erfassen": page = <EntryPage editId={route.parts[0] ?? null} presetDate={route.query.get("datum")} />; break;
    case "/monat": page = <MonthPage initialMonth={route.query.get("m")} />; break;
    case "/konto": page = <AccountPage />; break;
    case "/einstellungen": page = <SettingsPage />; break;
    default: page = <StartPage />;
  }

  return (
    <Ctx.Provider value={ctx}>
      <ToastProvider>
        <DialogProvider>
          <a class="skip-link" href="#main">Zum Inhalt springen</a>
          <div class="m-shell">
            <header class="m-header">
              <TenantLogo name={data.tenant.name} branding={data.tenant.branding} showSlogan />
              <span class="xsmall muted" style={{ textAlign: "right" }}>{data.me.displayName}<br />Nr. {data.me.personnelNumber}</span>
            </header>
            <Watermark branding={data.tenant.branding} />
            <main class="m-main" id="main">{page}</main>
            <BottomNav items={NAV} current={route.path} />
          </div>
        </DialogProvider>
      </ToastProvider>
    </Ctx.Provider>
  );
}

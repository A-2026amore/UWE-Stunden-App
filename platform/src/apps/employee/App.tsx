import { useEffect, useState } from "preact/hooks";
import type { Employee, Tenant } from "../../core/types";
import type { Session } from "../../data/repository";
import { Avatar, BottomNav, DialogProvider, ToastProvider, applyBranding, type NavItem } from "../../design";
import type { SyncStatus } from "../../data/sync";
import { useRoute } from "../shared/router";
import { getRepository, onAuthFailure } from "../shared/repo";
import { TwoFactorGate } from "../shared/twoFactor";
import { LoginScreen, TenantLogo, Watermark, rememberTenant } from "../shared/ui";
import { currentMonth } from "../shared/format";
import { errorText } from "../shared/hooks";
import { Ctx, type EmployeeCtx } from "./context";
import { StartPage } from "./pages/Start";
import { EntryPage } from "./pages/Entry";
import { MonthPage } from "./pages/Month";
import { AccountPage } from "./pages/Account";
import { SettingsPage } from "./pages/Settings";
import { LegacyImportPage } from "./pages/LegacyImport";
import { getEmployeeRepository } from "./syncRepo";
import { ConflictDialog, SyncIndicator } from "./SyncStatus";
import { UpdateBanner } from "./UpdateBanner";
import { LoginInstallHint } from "./InstallHint";

const NAV: NavItem[] = [
  { href: "#/", label: "Start", icon: "home", match: "/" },
  { href: "#/erfassen", label: "Erfassen", icon: "plus", match: "/erfassen", primary: true },
  { href: "#/monat", label: "Monat", icon: "calendar", match: "/monat" },
  { href: "#/konto", label: "Konto", icon: "wallet", match: "/konto" },
  { href: "#/einstellungen", label: "Profil", icon: "settings", match: "/einstellungen" },
];

const repo = getEmployeeRepository();

/** Error text when a session may not use the employee app. */
const checkArea = (s: Session): string | null =>
  (s.tenantId && s.employeeId ? null : "Dieses Konto gehört nicht zu einem Unternehmen. Bitte das Admin-Portal verwenden.");

export function EmployeeApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [data, setData] = useState<{ tenant: Tenant; me: Employee } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [version, setVersion] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => repo.syncStatus());
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const route = useRoute();

  useEffect(() => {
    repo.currentSession().then((s) => {
      const problem = s ? checkArea(s) : null;
      if (problem) { setNotice(problem); setSession(null); return; }
      setSession(s); setSyncStatus(repo.syncStatus()); if (s?.employeeId && !s.twoFactorSetupRequired) repo.flush().catch(() => undefined);
    }, (e: unknown) => { setNotice(errorText(e)); setSession(null); });
  }, []);

  // API: expired session (401) or suspended company → back to the login with an explanation.
  // Unsent changes stay in the outbox of this device and are sent after the next sign-in.
  useEffect(() => onAuthFailure((f) => {
    // Mandatory 2FA (managers/owners): keep the session, show only the setup.
    if (f.kind === "two_factor_setup") { setData(null); repo.currentSession().then(setSession, () => setSession(null)); return; }
    setNotice(f.message); setError(null); setData(null); setSession(null);
  }), []);

  // Reload the pages whenever synchronisation changed the data (sent changes, new conflicts).
  useEffect(() => {
    let prev = repo.syncStatus();
    return repo.subscribe((s) => {
      setSyncStatus(s);
      if (s.pending < prev.pending || s.conflicts !== prev.conflicts || s.lastSyncAt !== prev.lastSyncAt) setVersion((v) => v + 1);
      prev = s;
    });
  }, []);

  useEffect(() => {
    if (!session?.tenantId || !session.employeeId || session.twoFactorSetupRequired) { setData(null); applyBranding(null); return; }
    Promise.all([repo.getTenant(session.tenantId), repo.listEmployees(session.tenantId)])
      .then(([tenant, list]) => {
        const me = list.find((e) => e.id === session.employeeId);
        if (!me) throw new Error("Mitarbeiterdaten nicht gefunden.");
        applyBranding(tenant.branding);
        rememberTenant("app", tenant.name, tenant.branding);
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
        check={checkArea}
        notice={notice}
        onSignedIn={async (s) => {
          setNotice(null);
          // The login form signs in on the area repository; let the sync layer pick up the new session first.
          await repo.currentSession().catch(() => null);
          setSyncStatus(repo.syncStatus());
          if (!s.twoFactorSetupRequired) repo.flush().catch(() => undefined);
          setError(null); setSession(s); location.hash = "#/";
        }}
      >
        <LoginInstallHint />
      </LoginScreen>
    );
  }

  if (session.twoFactorSetupRequired) {
    return (
      <TwoFactorGate repo={getRepository("app")} session={session}
        onDone={async () => { const s = await repo.currentSession().catch(() => null); setSession(s); if (s) repo.flush().catch(() => undefined); }}
        onSignOut={async () => { await repo.signOut(); setSession(null); }} />
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
    repo, session, tenant: data.tenant, me: data.me, month, setMonth, version, syncStatus,
    openConflicts: () => setConflictsOpen(true),
    changed: () => setVersion((v) => v + 1),
    signOut: async () => { await repo.signOut(); setSession(null); setData(null); },
  };

  let page;
  switch (route.path) {
    case "/erfassen": page = <EntryPage editId={route.parts[0] ?? null} presetDate={route.query.get("datum")} />; break;
    case "/monat": page = <MonthPage initialMonth={route.query.get("m")} />; break;
    case "/konto": page = <AccountPage />; break;
    // The import from the old UWE app exists only for tenants the platform enabled it for (0024).
    case "/einstellungen": page = route.parts[0] === "import" && data.tenant.legacyImportEnabled ? <LegacyImportPage /> : <SettingsPage />; break;
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
              <a class="user-chip" href="#/einstellungen" style={{ textDecoration: "none", color: "inherit" }} aria-label={`Profil: ${data.me.displayName}, Nr. ${data.me.personnelNumber}`}>
                <span class="user-chip-text"><strong>{data.me.displayName}</strong><span>Nr. {data.me.personnelNumber}</span></span>
                <Avatar name={data.me.displayName} />
              </a>
            </header>
            <SyncIndicator status={syncStatus} onOpenConflicts={() => setConflictsOpen(true)} />
            <UpdateBanner />
            <Watermark branding={data.tenant.branding} />
            <main class="m-main" id="main">{page}</main>
            <BottomNav items={NAV} current={route.path} />
            <ConflictDialog open={conflictsOpen} onClose={() => setConflictsOpen(false)} />
          </div>
        </DialogProvider>
      </ToastProvider>
    </Ctx.Provider>
  );
}

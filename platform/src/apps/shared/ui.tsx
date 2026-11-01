/** Shared UI building blocks of the three apps (login, brand header, demo banner). */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { Branding } from "../../core/types";
import { TwoFactorRequiredError, type Session } from "../../data/repository";
import { DEMO_LOGINS, DEMO_PASSWORD } from "../../data/demo";
import {
  Alert, Button, Card, Icon, InputField, PRODUCT_NAME, PRODUCT_TAGLINE, ProductLogo, resolveAsset, type IconName,
} from "../../design";
import { IS_DEMO, getRepository, type AppArea } from "./repo";
import { errorText } from "./hooks";
import { RecoveryCodeUsedNotice, TwoFactorLoginStep } from "./twoFactor";

export function ProductMark({ compact }: { compact?: boolean }) {
  return (
    <span class={compact ? "product-mark product-mark-compact" : "product-mark"}>
      <ProductLogo size={compact ? 22 : 32} />
      <span>{PRODUCT_NAME}</span>
    </span>
  );
}

// ------------------------------------------------------------ remembered company brand (login pages)

const LAST_TENANT_KEY = "stundenwerk_last_tenant_v1";
export interface RememberedTenant { name: string; logoUrl: string | null }

/**
 * Remembers name and logo of the company last used on this device, so the
 * login page can show the company logo ("wenn bekannt"). No personal data;
 * logos stored as data: URLs are skipped when large.
 */
export function rememberTenant(area: AppArea, name: string, branding: Branding): void {
  try {
    const logo = branding.logoUrl && (!branding.logoUrl.startsWith("data:") || branding.logoUrl.length < 120_000) ? branding.logoUrl : null;
    localStorage.setItem(`${LAST_TENANT_KEY}_${area}`, JSON.stringify({ name, logoUrl: logo }));
  } catch { /* storage blocked – no logo on the next login */ }
}

export function rememberedTenant(area: AppArea): RememberedTenant | null {
  try {
    const raw = localStorage.getItem(`${LAST_TENANT_KEY}_${area}`);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RememberedTenant>;
    return typeof v.name === "string" && v.name ? { name: v.name, logoUrl: typeof v.logoUrl === "string" ? v.logoUrl : null } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ split auth layout

const AREA_PITCH: Record<AppArea | "link", { title: string; text: string; points: Array<{ icon: IconName; text: string }> }> = {
  app: {
    title: "Deine Arbeitszeit. In Sekunden erfasst.",
    text: "Einsätze und Pausen festhalten, Monat prüfen, Nachweis senden – auch ohne Netz.",
    points: [
      { icon: "clock", text: "Schnell erfassen mit Vorschlägen" },
      { icon: "refresh", text: "Funktioniert auch offline" },
      { icon: "fileCheck", text: "Monatsnachweis als PDF" },
    ],
  },
  chef: {
    title: "Alle Stunden. Ein klarer Überblick.",
    text: "Arbeitszeiten prüfen, Monatsnachweise freigeben und Arbeitszeitkonten führen – an einem Ort.",
    points: [
      { icon: "chart", text: "Kennzahlen auf einen Blick" },
      { icon: "fileCheck", text: "Freigaben mit wenigen Klicks" },
      { icon: "log", text: "Änderungen lückenlos protokolliert" },
    ],
  },
  admin: {
    title: "Plattformbetrieb mit Übersicht.",
    text: "Mandanten, Lizenzen, Preise und Systemstatus – ohne Einsicht in Arbeitszeiten ohne Freigabe.",
    points: [
      { icon: "building", text: "Mandanten und Lizenzen" },
      { icon: "euro", text: "Preismodell und Umsatz" },
      { icon: "shield", text: "Zwei-Faktor-Anmeldung" },
    ],
  },
  link: {
    title: "Willkommen bei Stundenwerk.",
    text: PRODUCT_TAGLINE + ".",
    points: [
      { icon: "lock", text: "Sicheres Passwort festlegen" },
      { icon: "clock", text: "Danach direkt loslegen" },
    ],
  },
};

/** Decorative illustration of the brand panel (abstract time bars). */
function AuthIllustration() {
  const bars = [46, 72, 58, 88, 64, 30, 20];
  return (
    <svg class="auth-illustration" viewBox="0 0 420 260" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="420" height="260" rx="28" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.18)" />
      <rect x="28" y="28" width="120" height="10" rx="5" fill="rgba(255,255,255,0.55)" />
      <rect x="28" y="48" width="74" height="8" rx="4" fill="rgba(255,255,255,0.28)" />
      {bars.map((h, i) => (
        <rect key={i} x={36 + i * 50} y={220 - h * 1.6} width="28" height={h * 1.6} rx="7"
          fill={i === 3 ? "rgba(34,211,238,0.95)" : "rgba(255,255,255,0.42)"} />
      ))}
      <line x1="28" x2="392" y1="222" y2="222" stroke="rgba(255,255,255,0.3)" />
    </svg>
  );
}

/**
 * Two-column login layout: brand panel left (desktop), form right; one
 * column on phones. Used by all sign-in, password, invitation and 2FA pages.
 */
export function AuthLayout({ area, tenant, children }: {
  area: AppArea | "link"; tenant?: RememberedTenant | null; children: ComponentChildren;
}) {
  const pitch = AREA_PITCH[area];
  const logo = resolveAsset(tenant?.logoUrl);
  return (
    <div class="auth">
      <aside class="auth-aside" aria-label={`${PRODUCT_NAME} – Überblick`}>
        <ProductMark />
        <div>
          {tenant && (
            <div class="tenant-plate">
              {logo ? <img class="brand-logo" src={logo} alt={`${tenant.name} – Logo`} /> : <span class="brand-name">{tenant.name}</span>}
            </div>
          )}
          <p class="auth-aside-title">{pitch.title}</p>
          <p>{pitch.text}</p>
          <ul class="auth-points">
            {pitch.points.map((p) => <li key={p.text}><span class="ico"><Icon name={p.icon} size={18} /></span>{p.text}</li>)}
          </ul>
        </div>
        <p class="auth-legal mb-0">{PRODUCT_NAME} · {PRODUCT_TAGLINE}</p>
        <AuthIllustration />
      </aside>
      <div class="auth-panel">
        <main class="auth-card stack" id="main">
          <div class="auth-mobile-brand">
            <ProductMark />
            {tenant && (logo
              ? <img class="brand-logo" src={logo} alt={`${tenant.name} – Logo`} style={{ maxHeight: "36px", maxWidth: "150px", margin: 0 }} />
              : <span class="small muted">{tenant.name}</span>)}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}

/** Tenant logo, or the tenant name as text when no logo exists. */
export function TenantLogo({ name, branding, showSlogan }: { name: string; branding: Branding; showSlogan?: boolean }) {
  const logo = resolveAsset(branding.logoUrl);
  return (
    <div>
      {logo ? <img class="brand-logo" src={logo} alt={`${name} – Logo`} /> : <div class="brand-name">{name}</div>}
      {showSlogan && branding.slogan && <div class="brand-slogan">{branding.slogan}</div>}
    </div>
  );
}

export function Watermark({ branding }: { branding: Branding }) {
  const mark = resolveAsset(branding.markUrl);
  if (!mark) return null;
  return <div class="watermark" aria-hidden="true"><img src={mark} alt="" /></div>;
}

export function DemoBanner() {
  return (
    <Alert tone="warning" title="Demo-Umgebung">
      <p>Alle Namen und Zeiten sind erfunden. Änderungen bleiben nur in diesem Browser gespeichert.</p>
    </Alert>
  );
}

export function LoginScreen({ area, title, subtitle, onSignedIn, check, notice, children }: {
  area: AppArea; title: string; subtitle: string;
  onSignedIn: (s: Session) => void;
  /** Returns an error text when the session may not use this area. */
  check: (s: Session) => string | null;
  /** Shown above the form, e.g. "Sitzung abgelaufen" or "Firmenzugang gesperrt". */
  notice?: string | null;
  children?: ComponentChildren;
}) {
  const repo = getRepository(area);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "code" | "recoveryUsed" | "reset" | "resetSent">("login");
  const [signedIn, setSignedIn] = useState<Session | null>(null);

  /** Area check, then either straight in or – after a recovery code – a notice first. */
  const finish = async (s: Session) => {
    const problem = check(s);
    if (problem) { await repo.signOut(); setMode("login"); setError(problem); return; }
    if (s.recoveryCodesRemaining !== undefined) { setSignedIn(s); setMode("recoveryUsed"); return; }
    onSignedIn(s);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) { setError("Bitte E-Mail-Adresse und Passwort eingeben."); return; }
    setBusy(true);
    try {
      await finish(await repo.signIn(email, password));
    } catch (err) {
      if (err instanceof TwoFactorRequiredError) { setPassword(""); setMode("code"); return; }
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      await repo.requestPasswordReset(email);
      setMode("resetSent");
    } catch (err) {
      setError(errorText(err));
    }
  };

  const logins = DEMO_LOGINS.filter((l) => l.area === area);
  const [tenant] = useState(() => (area === "admin" ? null : rememberedTenant(area)));
  return (
    <AuthLayout area={area} tenant={tenant}>
        <div class="auth-head">
          <h1>{title}</h1>
          <p class="muted mb-0">{subtitle}</p>
        </div>
        <Card>
          {mode === "login" && (
            <form class="stack" onSubmit={submit} noValidate>
              {notice && !error && <Alert tone="warning" live>{notice}</Alert>}
              <InputField label="E-Mail-Adresse" type="email" autoComplete="username" value={email} onValue={setEmail} required />
              <InputField label="Passwort" type="password" autoComplete="current-password" value={password} onValue={setPassword} required />
              {error && <Alert tone="danger" live>{error}</Alert>}
              <Button type="submit" block busy={busy}>Anmelden</Button>
              <Button variant="ghost" onClick={() => { setMode("reset"); setError(null); }}>Passwort vergessen?</Button>
            </form>
          )}
          {mode === "code" && (
            <TwoFactorLoginStep repo={repo} area={area} onVerified={(s) => void finish(s)}
              onCancel={() => { void repo.signOut().catch(() => undefined); setMode("login"); setError(null); }} />
          )}
          {mode === "recoveryUsed" && signedIn && (
            <RecoveryCodeUsedNotice remaining={signedIn.recoveryCodesRemaining ?? 0} onContinue={() => onSignedIn(signedIn)} />
          )}
          {mode === "reset" && (
            <form class="stack" onSubmit={reset} noValidate>
              <h2>Passwort zurücksetzen</h2>
              <p class="muted small">Gib deine E-Mail-Adresse ein. Wenn ein Konto existiert, erhältst du einen Link zum Zurücksetzen.</p>
              <InputField label="E-Mail-Adresse" type="email" autoComplete="username" value={email} onValue={setEmail} required />
              {error && <Alert tone="danger" live>{error}</Alert>}
              <Button type="submit" block>Link anfordern</Button>
              <Button variant="ghost" onClick={() => setMode("login")}>Zurück zur Anmeldung</Button>
            </form>
          )}
          {mode === "resetSent" && (
            <div class="stack">
              <Alert tone="success" live title="Anfrage gesendet">
                <p>Falls ein Konto mit dieser Adresse existiert, wurde ein Link versendet.{IS_DEMO ? ` Im Demo-Modus wird keine E-Mail verschickt – das Passwort ist immer „${DEMO_PASSWORD}“.` : " Bitte prüfe dein Postfach (auch den Spam-Ordner). Der Link ist eine Stunde gültig."}</p>
              </Alert>
              <Button onClick={() => setMode("login")}>Zurück zur Anmeldung</Button>
            </div>
          )}
        </Card>
        {IS_DEMO && <Card muted>
          <div class="demo-hint stack-sm">
            <strong>Demo-Zugänge (Passwort: <code>{DEMO_PASSWORD}</code>)</strong>
            <ul class="list-plain demo-logins">
              {logins.map((l) => (
                <li key={l.email}>
                  <button type="button" class="linklike" onClick={() => { setEmail(l.email); setPassword(DEMO_PASSWORD); setMode("login"); }}>
                    {l.email}
                  </button>
                  <div class="xsmall muted">{l.label}</div>
                </li>
              ))}
            </ul>
          </div>
        </Card>}
        {children}
        <p class="footer-note"><a href="../index.html">{IS_DEMO ? "Zur Übersicht der Demo-Umgebung" : "Zur Übersicht"}</a></p>
    </AuthLayout>
  );
}

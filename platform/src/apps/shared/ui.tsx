/** Shared UI building blocks of the three apps (login, brand header, demo banner). */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { Branding } from "../../core/types";
import { TwoFactorRequiredError, type Session } from "../../data/repository";
import { DEMO_LOGINS, DEMO_PASSWORD } from "../../data/demo";
import {
  Alert, Button, Card, InputField, PRODUCT_NAME, PRODUCT_NAME_NOTE, resolveAsset,
} from "../../design";
import { IS_DEMO, getRepository, type AppArea } from "./repo";
import { errorText } from "./hooks";
import { RecoveryCodeUsedNotice, TwoFactorLoginStep } from "./twoFactor";

export function ProductMark({ compact }: { compact?: boolean }) {
  return (
    <span class="product-mark">
      <img src={resolveAsset("product-mark.svg") ?? ""} alt="" width={compact ? 24 : 32} height={compact ? 24 : 32} />
      <span>{PRODUCT_NAME} <small>({PRODUCT_NAME_NOTE})</small></span>
    </span>
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
  return (
    <div class="auth">
      <main class="auth-card stack">
        <div class="auth-head">
          <ProductMark />
          <h1 style={{ marginTop: "var(--space-4)" }}>{title}</h1>
          <p class="muted">{subtitle}</p>
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
            <ul class="list-plain stack-sm">
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
      </main>
    </div>
  );
}

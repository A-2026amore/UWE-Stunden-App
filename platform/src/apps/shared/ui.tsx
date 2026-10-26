/** Shared UI building blocks of the three apps (login, brand header, demo banner). */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { Branding } from "../../core/types";
import type { Session } from "../../data/repository";
import { DEMO_LOGINS, DEMO_PASSWORD } from "../../data/demo";
import {
  Alert, Button, Card, InputField, PRODUCT_NAME, PRODUCT_NAME_NOTE, resolveAsset,
} from "../../design";
import { getRepository, type AppArea } from "./repo";
import { errorText } from "./hooks";

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

export function LoginScreen({ area, title, subtitle, onSignedIn, check, children }: {
  area: AppArea; title: string; subtitle: string;
  onSignedIn: (s: Session) => void;
  /** Returns an error text when the session may not use this area. */
  check: (s: Session) => string | null;
  children?: ComponentChildren;
}) {
  const repo = getRepository(area);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "reset" | "resetSent">("login");

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) { setError("Bitte E-Mail-Adresse und Passwort eingeben."); return; }
    setBusy(true);
    try {
      const s = await repo.signIn(email, password);
      const problem = check(s);
      if (problem) { await repo.signOut(); setError(problem); return; }
      onSignedIn(s);
    } catch (err) {
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
              <InputField label="E-Mail-Adresse" type="email" autoComplete="username" value={email} onValue={setEmail} required />
              <InputField label="Passwort" type="password" autoComplete="current-password" value={password} onValue={setPassword} required />
              {error && <Alert tone="danger" live>{error}</Alert>}
              <Button type="submit" block busy={busy}>Anmelden</Button>
              <Button variant="ghost" onClick={() => { setMode("reset"); setError(null); }}>Passwort vergessen?</Button>
            </form>
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
                <p>Falls ein Konto mit dieser Adresse existiert, wurde ein Link versendet. Im Demo-Modus wird keine E-Mail verschickt – das Passwort ist immer „{DEMO_PASSWORD}“.</p>
              </Alert>
              <Button onClick={() => setMode("login")}>Zurück zur Anmeldung</Button>
            </div>
          )}
        </Card>
        <Card muted>
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
        </Card>
        {children}
        <p class="footer-note"><a href="../index.html">Zur Übersicht der Demo-Umgebung</a></p>
      </main>
    </div>
  );
}

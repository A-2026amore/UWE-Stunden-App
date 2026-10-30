/**
 * Pages opened from e-mail links (api mode):
 *  - /passwort-neu/#token=…  → POST /api/auth/password-reset/confirm
 *  - /einladung/#token=…     → POST /api/auth/invitation/accept
 *
 * The token travels in the URL fragment (never sent to a server, not in
 * access logs). It is read once and then removed from the address bar.
 */
import { render, type ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import "../../design/styles";
import { Alert, Button, Card, InputField, LinkButton, initTheme, setAssetBase } from "../../design";
import { errorText } from "../shared/hooks";
import { IS_DEMO, getApiRepository } from "../shared/repo";
import { AuthLayout } from "../shared/ui";

setAssetBase("../");
initTheme();

const MIN_PASSWORD = 10;

/** Reads "#token=…" and removes it from the address bar / history entry. */
export function takeToken(): string | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = params.get("token");
  if (token) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* keep the URL */ }
  }
  return token && /^[A-Za-z0-9_-]{16,200}$/.test(token) ? token : null;
}

function passwordProblem(password: string, repeat: string): string | null {
  if (password.length < MIN_PASSWORD) return `Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen lang sein.`;
  if (password !== repeat) return "Die beiden Passwörter stimmen nicht überein.";
  return null;
}

function SignInLinks() {
  return (
    <div class="stack-sm">
      <LinkButton href="../app/" variant="primary" icon="clock">Zur Mitarbeiter-App</LinkButton>
      <LinkButton href="../chef/" icon="building">Zum Chef-Portal</LinkButton>
    </div>
  );
}

/**
 * After accepting an invitation: straight on to the employee app, which shows
 * how to put it on the home screen (installing works only from the app's own
 * address – not from this page).
 */
function NextStepApp() {
  return (
    <div class="stack-sm" data-testid="invitation-next-step">
      <h2 class="h3 mb-0">Letzter Schritt: die App aufs Handy holen</h2>
      <p class="small mb-0">Tippe auf den Knopf. Die Zeiterfassung zeigt dir dann genau, wie du sie als Symbol auf deinen Startbildschirm legst – kostenlos, ohne App-Store.</p>
      <LinkButton href="../app/" variant="primary" icon="clock">Weiter zur Mitarbeiter-App</LinkButton>
    </div>
  );
}

function Shell({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <AuthLayout area="link">
      <div class="auth-head">
        <h1>{title}</h1>
      </div>
      <Card>{children}</Card>
    </AuthLayout>
  );
}

function MissingToken() {
  return (
    <div class="stack">
      <Alert tone="danger" title="Link unvollständig">
        <p>Der Link ist ungültig oder unvollständig. Bitte öffne den Link direkt aus der E-Mail oder fordere einen neuen an.</p>
      </Alert>
      <SignInLinks />
    </div>
  );
}

function DemoNotice() {
  return (
    <div class="stack">
      <Alert tone="info" title="Demo-Umgebung">
        <p>In der Demo werden keine E-Mails verschickt. Bitte melde dich mit einem der Demo-Zugänge an.</p>
      </Alert>
      <SignInLinks />
    </div>
  );
}

function ResetPage({ token }: { token: string | null }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (IS_DEMO) return <DemoNotice />;
  if (!token) return <MissingToken />;
  if (done) {
    return (
      <div class="stack">
        <Alert tone="success" live title="Passwort geändert">
          <p>Dein neues Passwort ist gespeichert. Aus Sicherheitsgründen wurden alle bisherigen Anmeldungen beendet – bitte melde dich neu an.</p>
        </Alert>
        <SignInLinks />
      </div>
    );
  }

  const submit = async (e: Event) => {
    e.preventDefault();
    const problem = passwordProblem(password, repeat);
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      await getApiRepository().confirmPasswordReset(token, password);
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="stack" onSubmit={submit} noValidate>
      <p class="muted small">Lege ein neues Passwort fest (mindestens {MIN_PASSWORD} Zeichen). Der Link aus der E-Mail ist eine Stunde gültig und funktioniert nur einmal.</p>
      <InputField label="Neues Passwort" type="password" autoComplete="new-password" value={password} onValue={setPassword} required />
      <InputField label="Neues Passwort wiederholen" type="password" autoComplete="new-password" value={repeat} onValue={setRepeat} required />
      {error && <Alert tone="danger" live>{error}</Alert>}
      <Button type="submit" block busy={busy}>Passwort speichern</Button>
    </form>
  );
}

function InvitePage({ token }: { token: string | null }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"new" | "existing" | null>(null);
  const [result, setResult] = useState<{ message: string; existingAccount: boolean } | null>(null);

  if (IS_DEMO) return <DemoNotice />;
  if (!token) return <MissingToken />;
  if (result) {
    return (
      <div class="stack">
        <Alert tone="success" live title={result.existingAccount ? "Einladung verknüpft" : "Einladung angenommen"}>
          <p data-testid="invitation-result">{result.message}</p>
        </Alert>
        <NextStepApp />
        <LinkButton href="../chef/" icon="building">Ich bin Chef: zum Chef-Portal</LinkButton>
      </div>
    );
  }

  const accept = async (withPassword: boolean) => {
    setError(null);
    if (withPassword) {
      const problem = passwordProblem(password, repeat);
      if (problem) { setError(problem); return; }
    }
    setBusy(withPassword ? "new" : "existing");
    try {
      setResult(await getApiRepository().acceptInvitation(token, withPassword ? password : undefined));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="stack">
      <form class="stack" onSubmit={(e) => { e.preventDefault(); void accept(true); }} noValidate>
        <p class="muted small">Du wurdest zur Zeiterfassung deines Arbeitgebers eingeladen. Lege ein Passwort fest (mindestens {MIN_PASSWORD} Zeichen), um dein Konto zu aktivieren.</p>
        <InputField label="Passwort" type="password" autoComplete="new-password" value={password} onValue={setPassword} required />
        <InputField label="Passwort wiederholen" type="password" autoComplete="new-password" value={repeat} onValue={setRepeat} required />
        {error && <Alert tone="danger" live>{error}</Alert>}
        <Button type="submit" block busy={busy === "new"}>Einladung annehmen</Button>
      </form>
      <div class="stack-sm">
        <p class="muted small mb-0">Du hast mit dieser E-Mail-Adresse schon ein Konto (z. B. bei einem anderen Arbeitgeber)? Dann wird die Einladung mit deinem Konto verknüpft – dein bisheriges Passwort bleibt gültig.</p>
        <Button variant="secondary" block busy={busy === "existing"} onClick={() => void accept(false)}>Ich habe bereits ein Konto</Button>
      </div>
    </div>
  );
}

function LinkApp() {
  const page = document.getElementById("root")?.dataset.page === "invite" ? "invite" : "reset";
  const [token] = useState(takeToken);
  return page === "invite"
    ? <Shell title="Einladung annehmen"><InvitePage token={token} /></Shell>
    : <Shell title="Neues Passwort festlegen"><ResetPage token={token} /></Shell>;
}

render(<LinkApp />, document.getElementById("root")!);

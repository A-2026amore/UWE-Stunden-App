/**
 * Two-factor authentication UI shared by the three apps:
 *  - TwoFactorLoginStep: second step of the sign-in (code or recovery code)
 *  - TwoFactorCard: settings card "Zwei-Faktor-Anmeldung"
 *  - TwoFactorGate: full screen while the mandatory setup is pending
 * The QR code is rendered with our own encoder (security/qrcode.ts) as SVG.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Session, TwoFactorProof, TwoFactorSetup, TwoFactorStatus } from "../../data/repository";
import { Alert, Badge, Button, Card, Checkbox, InputField, useToast } from "../../design";
import { encodeQr, qrSvgPath } from "../../security/qrcode";
import { groupSecret } from "../../security/totp";
import { dateTimeDE, downloadBlob } from "./format";
import { errorText, useAsync } from "./hooks";
import { IS_DEMO, demoTwoFactorCode, type AppArea, type AreaRepository } from "./repo";
import { AuthLayout } from "./ui";

export const CODE_LABEL = "Bestätigungscode aus der Authenticator-App";
export const RECOVERY_LABEL = "Wiederherstellungscode";

// ------------------------------------------------------------------ small parts

export function QrCodeImage({ text, label }: { text: string; label: string }) {
  const code = useMemo(() => encodeQr(text, "M"), [text]);
  const n = code.size + 8;
  return (
    <div class="qr-box">
      <svg viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
        <rect width={n} height={n} fill="#ffffff" />
        <path d={qrSvgPath(code)} fill="#000000" />
      </svg>
    </div>
  );
}

function recoveryText(codes: string[], account: string | null): string {
  const lines = [
    "Wiederherstellungscodes für die Zwei-Faktor-Anmeldung",
    account ? `Konto: ${account}` : null,
    `Erstellt: ${dateTimeDE(new Date().toISOString())}`,
    "",
    "Jeder Code funktioniert nur einmal. Bewahre diese Datei sicher auf (z. B. ausgedruckt oder im Passwort-Manager),",
    "nicht auf demselben Smartphone wie die Authenticator-App.",
    "",
    ...codes.map((c, i) => `${String(i + 1).padStart(2, " ")}. ${c}`),
    "",
  ].filter((l) => l !== null);
  return lines.join("\r\n");
}

/** Shows new recovery codes once, with download as .txt. */
export function RecoveryCodesView({ codes, account, onDone, doneLabel = "Fertig" }: {
  codes: string[]; account: string | null; onDone: () => void; doneLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <div class="stack">
      <Alert tone="warning" title="Wiederherstellungscodes sicher aufbewahren">
        <p>Mit diesen Codes kommst du in dein Konto, wenn du dein Smartphone verlierst. Jeder Code funktioniert nur einmal. Sie werden <strong>nur jetzt</strong> angezeigt.</p>
      </Alert>
      <ol class="recovery-codes" aria-label="Wiederherstellungscodes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div class="btn-row">
        <Button variant="secondary" icon="download" onClick={() => downloadBlob(new Blob([recoveryText(codes, account)], { type: "text/plain;charset=utf-8" }), "wiederherstellungscodes.txt")}>
          Als Textdatei herunterladen
        </Button>
      </div>
      <Checkbox label="Ich habe die Wiederherstellungscodes sicher gespeichert." checked={saved} onChange={setSaved} />
      <div><Button icon="check" disabled={!saved} onClick={onDone}>{doneLabel}</Button></div>
    </div>
  );
}

/** Code input or recovery code input, with switch. */
function ProofFields({ useRecovery, setUseRecovery, value, setValue, autoFocus }: {
  useRecovery: boolean; setUseRecovery: (v: boolean) => void; value: string; setValue: (v: string) => void; autoFocus?: boolean;
}) {
  return (
    <div class="stack-sm">
      {/* Distinct keys: a reused <input> would keep (or reset to 0) the numeric field's maxLength. */}
      {useRecovery
        ? <InputField key="recovery" label={RECOVERY_LABEL} value={value} onValue={setValue} autoComplete="off" autoCapitalize="characters" spellcheck={false}
            hint="16 Zeichen, z. B. ABCD-EFGH-JKMN-PQRS. Jeder Code funktioniert nur einmal." fieldClass="otp-input" autoFocus={autoFocus} />
        : <InputField key="code" label={CODE_LABEL} value={value} onValue={setValue} inputMode="numeric" autoComplete="one-time-code" maxLength={7}
            hint="6 Ziffern, wechselt alle 30 Sekunden." fieldClass="otp-input" autoFocus={autoFocus} />}
      <div>
        <button type="button" class="linklike small" onClick={() => { setUseRecovery(!useRecovery); setValue(""); }}>
          {useRecovery ? "Stattdessen Code aus der Authenticator-App eingeben" : "Smartphone nicht zur Hand? Wiederherstellungscode verwenden"}
        </button>
      </div>
    </div>
  );
}

const proofOf = (useRecovery: boolean, value: string): TwoFactorProof => (useRecovery ? { recoveryCode: value } : { code: value });

// ------------------------------------------------------------------ setup

/** Starts the setup, shows QR code + secret, confirms with the first code, then shows the recovery codes. */
export function TwoFactorSetupFlow({ repo, account, onDone, onCancel }: {
  repo: AreaRepository; account: string | null; onDone: () => void; onCancel?: () => void;
}) {
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    repo.startTwoFactorSetup().then((s) => alive && setSetup(s), (e: unknown) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [repo]);

  const confirm = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code.replace(/\s/g, ""))) { setError("Bitte den 6-stelligen Code aus der Authenticator-App eingeben."); return; }
    setBusy(true);
    try {
      const r = await repo.confirmTwoFactorSetup(code.replace(/\s/g, ""));
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (codes) return <RecoveryCodesView codes={codes} account={account} onDone={onDone} />;
  if (!setup) {
    return error
      ? <div class="stack"><Alert tone="danger" live>{error}</Alert>{onCancel && <div><Button variant="secondary" onClick={onCancel}>Abbrechen</Button></div>}</div>
      : <p class="muted" role="status">Einrichtung wird vorbereitet …</p>;
  }
  return (
    <form class="stack" onSubmit={confirm} noValidate>
      <ol class="stack-sm small" style={{ paddingLeft: "1.25rem", margin: 0 }}>
        <li>Installiere eine Authenticator-App auf deinem Smartphone (z. B. Microsoft Authenticator, Google Authenticator, FreeOTP oder Aegis).</li>
        <li>Scanne den QR-Code mit der App – oder gib den Schlüssel von Hand ein.</li>
        <li>Gib zur Bestätigung den 6-stelligen Code ein, den die App anzeigt.</li>
      </ol>
      <QrCodeImage text={setup.otpauthUri} label={`QR-Code für die Authenticator-App (${setup.issuer}, ${setup.account})`} />
      <div class="stack-sm">
        <div class="small"><strong>Schlüssel für die manuelle Eingabe</strong></div>
        <div class="secret-groups" aria-label="Schlüssel in Vierergruppen" data-testid="totp-secret">{groupSecret(setup.secret)}</div>
        <p class="xsmall muted mb-0">Konto: {setup.account} · Typ: zeitbasiert (TOTP) · 6 Ziffern · 30 Sekunden · SHA-1</p>
        <p class="xsmall mb-0"><a href={setup.otpauthUri}>Auf diesem Gerät in der Authenticator-App öffnen</a></p>
      </div>
      <InputField label={CODE_LABEL} value={code} onValue={setCode} inputMode="numeric" autoComplete="one-time-code" maxLength={7} fieldClass="otp-input" required />
      {error && <Alert tone="danger" live>{error}</Alert>}
      <div class="btn-row">
        <Button type="submit" icon="check" busy={busy}>Bestätigen und aktivieren</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Abbrechen</Button>}
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ settings card

const REQUIRED_TEXT: Record<"platform" | "tenant", string> = {
  platform: "Für Konten des Plattformbetriebs ist die Zwei-Faktor-Anmeldung Pflicht.",
  tenant: "Dein Unternehmen verlangt die Zwei-Faktor-Anmeldung für Inhaber und Vorgesetzte.",
};

export function TwoFactorCard({ repo, account }: { repo: AreaRepository; account: string | null }) {
  const toast = useToast();
  const status = useAsync(() => repo.getTwoFactorStatus(), []);
  const [mode, setMode] = useState<"view" | "setup" | "disable" | "regenerate">("view");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [proof, setProof] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const st: TwoFactorStatus | undefined = status.data;

  const reset = () => { setMode("view"); setPassword(""); setProof(""); setUseRecovery(false); setError(null); };

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!password || !proof.trim()) { setError("Bitte Passwort und Code eingeben."); return; }
    setBusy(true);
    try {
      if (mode === "disable") {
        const r = await repo.disableTwoFactor(password, proofOf(useRecovery, proof.trim()));
        if (r.setupRequired) { location.reload(); return; }
        toast("Zwei-Faktor-Anmeldung deaktiviert.");
        reset();
      } else {
        const r = await repo.regenerateRecoveryCodes(password, proofOf(useRecovery, proof.trim()));
        reset();
        setCodes(r.recoveryCodes);
      }
      status.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Zwei-Faktor-Anmeldung" id="zwei-faktor">
      <div class="stack">
        <p class="muted small mb-0">Zusätzlich zum Passwort fragt die Anmeldung nach einem Code aus einer Authenticator-App auf deinem Smartphone. So bleibt dein Konto geschützt, auch wenn jemand dein Passwort kennt.</p>
        {status.error && <Alert tone="danger" live>{status.error}</Alert>}
        {st && st.requiredBy && <Alert tone="info"><p>{REQUIRED_TEXT[st.requiredBy]}</p></Alert>}
        {codes && <RecoveryCodesView codes={codes} account={account} onDone={() => setCodes(null)} />}
        {!codes && st && mode === "view" && (st.enabled ? (
          <div class="stack-sm">
            <div class="row"><Badge tone="success" dot>Aktiv</Badge>{st.enrolledAt && <span class="small muted">seit {dateTimeDE(st.enrolledAt)}</span>}</div>
            <p class="small mb-0">Unbenutzte Wiederherstellungscodes: <strong>{st.recoveryCodesRemaining}</strong> von 10</p>
            {st.recoveryCodesRemaining <= 3 && <Alert tone="warning"><p>Nur noch wenige Wiederherstellungscodes übrig – bitte neue erzeugen.</p></Alert>}
            <div class="btn-row">
              <Button variant="secondary" icon="refresh" onClick={() => setMode("regenerate")}>Neue Wiederherstellungscodes</Button>
              <Button variant="danger" onClick={() => setMode("disable")}>Zwei-Faktor-Anmeldung deaktivieren</Button>
            </div>
          </div>
        ) : (
          <div class="stack-sm">
            <div><Badge tone="neutral">Nicht eingerichtet</Badge></div>
            <div><Button icon="shield" onClick={() => setMode("setup")}>Zwei-Faktor-Anmeldung einrichten</Button></div>
          </div>
        ))}
        {!codes && mode === "setup" && (
          <TwoFactorSetupFlow repo={repo} account={account} onCancel={reset}
            onDone={() => { reset(); toast("Zwei-Faktor-Anmeldung ist aktiv."); status.reload(); }} />
        )}
        {!codes && (mode === "disable" || mode === "regenerate") && (
          <form class="stack" onSubmit={submit} noValidate>
            <h3 class="mb-0">{mode === "disable" ? "Zwei-Faktor-Anmeldung deaktivieren" : "Neue Wiederherstellungscodes erzeugen"}</h3>
            {mode === "disable" && st?.required && <Alert tone="warning"><p>Die Zwei-Faktor-Anmeldung ist für dein Konto vorgeschrieben. Nach dem Deaktivieren musst du sie sofort neu einrichten (z. B. beim Wechsel des Smartphones).</p></Alert>}
            {mode === "regenerate" && <p class="small muted mb-0">Die bisherigen Wiederherstellungscodes werden dabei ungültig.</p>}
            <InputField label="Passwort" type="password" autoComplete="current-password" value={password} onValue={setPassword} required />
            <ProofFields useRecovery={useRecovery} setUseRecovery={setUseRecovery} value={proof} setValue={setProof} />
            {error && <Alert tone="danger" live>{error}</Alert>}
            <div class="btn-row">
              <Button type="submit" variant={mode === "disable" ? "danger" : "primary"} busy={busy}>{mode === "disable" ? "Deaktivieren" : "Neue Codes erzeugen"}</Button>
              <Button variant="ghost" onClick={reset}>Abbrechen</Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ mandatory setup (full screen)

export function TwoFactorGate({ repo, session, onDone, onSignOut }: {
  repo: AreaRepository; session: Session; onDone: (s: Session) => void; onSignOut: () => void;
}) {
  const status = useAsync(() => repo.getTwoFactorStatus(), []);
  const [error, setError] = useState<string | null>(null);
  const finish = async () => {
    try {
      const s = await repo.currentSession();
      if (s) onDone(s); else onSignOut();
    } catch (e) { setError(errorText(e)); }
  };
  const by = status.data?.requiredBy;
  return (
    <AuthLayout area={session.platformRole ? "admin" : session.employeeId && session.role === "employee" ? "app" : "chef"}>
      <div class="auth-head">
        <h1>Zwei-Faktor-Anmeldung einrichten</h1>
        <p class="muted mb-0">{by ? REQUIRED_TEXT[by] : "Für dein Konto ist die Zwei-Faktor-Anmeldung vorgeschrieben."} Bitte richte sie jetzt ein – danach geht es weiter.</p>
      </div>
      <Card>
        <TwoFactorSetupFlow repo={repo} account={session.email} onDone={finish} />
        {error && <Alert tone="danger" live>{error}</Alert>}
      </Card>
      <Button variant="ghost" icon="logout" onClick={onSignOut}>Abmelden</Button>
    </AuthLayout>
  );
}

// ------------------------------------------------------------------ sign-in, second step

export function TwoFactorLoginStep({ repo, area, onVerified, onCancel }: {
  repo: AreaRepository; area: AppArea; onVerified: (s: Session) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!value.trim()) { setError(useRecovery ? "Bitte einen Wiederherstellungscode eingeben." : "Bitte den 6-stelligen Code eingeben."); return; }
    setBusy(true);
    try {
      onVerified(await repo.verifyTwoFactor(proofOf(useRecovery, value.trim())));
    } catch (err) {
      setError(errorText(err));
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  const fillDemoCode = async () => {
    const c = await demoTwoFactorCode(area);
    if (c) { setUseRecovery(false); setValue(c); } else setError("Kein Demo-Code verfügbar – bitte erneut anmelden.");
  };

  return (
    <form class="stack" onSubmit={submit} noValidate>
      <h2 class="mb-0">Bestätigung</h2>
      <p class="muted small mb-0">Dein Konto ist mit der Zwei-Faktor-Anmeldung geschützt. Öffne die Authenticator-App auf deinem Smartphone.</p>
      <ProofFields useRecovery={useRecovery} setUseRecovery={setUseRecovery} value={value} setValue={setValue} autoFocus />
      {error && <Alert tone="danger" live>{error}</Alert>}
      <Button type="submit" block busy={busy}>Bestätigen</Button>
      {IS_DEMO && <Button variant="secondary" onClick={fillDemoCode}>Demo: aktuellen Code einsetzen</Button>}
      <Button variant="ghost" onClick={onCancel}>Zurück zur Anmeldung</Button>
    </form>
  );
}

/** Notice after a sign-in with a recovery code. */
export function RecoveryCodeUsedNotice({ remaining, onContinue }: { remaining: number; onContinue: () => void }) {
  return (
    <div class="stack">
      <Alert tone="warning" live title="Mit Wiederherstellungscode angemeldet">
        <p>Dieser Code ist jetzt verbraucht. Unbenutzte Wiederherstellungscodes: <strong>{remaining}</strong>. Falls du dein Smartphone verloren hast, richte die Zwei-Faktor-Anmeldung in den Einstellungen neu ein und erzeuge neue Codes.</p>
      </Alert>
      <Button block onClick={onContinue}>Weiter</Button>
    </div>
  );
}

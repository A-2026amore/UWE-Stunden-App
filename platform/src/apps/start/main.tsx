import { render } from "preact";
import { useState } from "preact/hooks";
import "../../design/styles";
import {
  Alert, Button, Card, DialogProvider, Icon, PRODUCT_NAME, PRODUCT_TAGLINE, ThemeSwitch, ToastProvider, applyBranding, initTheme, setAssetBase, useDialogs, useToast,
} from "../../design";
import { DEMO_LOGINS, DEMO_PASSWORD } from "../../data/demo";
import { IS_DEMO, getDemoRepository } from "../shared/repo";
import { ProductMark } from "../shared/ui";

setAssetBase("./");
initTheme();
applyBranding(null);

const AREAS = [
  { href: "app/", title: "Mitarbeiter-App", icon: "clock" as const, text: "Mobile App (PWA) für Mitarbeitende: Zeiten erfassen, Monatsübersicht, PDF-Nachweis, Arbeitszeitkonto." },
  { href: "chef/", title: "Chef-Portal", icon: "building" as const, text: "Web-Portal für Arbeitgeber: Mitarbeitende, Arbeitszeiten, Monatsnachweise, Arbeitszeitkonten, Firmenprofil." },
  { href: "admin/", title: "Super-Admin", icon: "shield" as const, text: "Plattformbetrieb: Mandanten, Lizenzen, Aktionscodes, Systemstatus. Keine Einsicht in Arbeitszeiten ohne Freigabe." },
];

function AreaCards() {
  return (
    <div class="area-grid">
      {AREAS.map((a) => (
        <Card key={a.href} class="area-card">
          <span class="area-icon"><Icon name={a.icon} size={22} /></span>
          <h2 class="mb-0">{a.title}</h2>
          <p class="muted small" style={{ flex: 1 }}>{a.text}</p>
          <a class="btn btn-primary" href={a.href}>{a.title} öffnen</a>
        </Card>
      ))}
    </div>
  );
}

function Start() {
  const dialogs = useDialogs();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    const ok = await dialogs.confirm({ title: "Demo-Daten zurücksetzen?", message: "Alle in diesem Browser gemachten Änderungen werden verworfen und die Beispieldaten neu erzeugt. Alle Bereiche werden abgemeldet.", confirmLabel: "Zurücksetzen", danger: true });
    if (!ok) return;
    setBusy(true);
    const repo = getDemoRepository("app");
    repo.resetDemoData();
    await Promise.all((["app", "chef", "admin"] as const).map((a) => getDemoRepository(a).signOut()));
    setBusy(false);
    toast("Demo-Daten wurden zurückgesetzt.");
  };
  return (
    <main class="m-main" style={{ maxWidth: "1100px", paddingBottom: "var(--space-10)", paddingTop: "var(--space-6)" }} id="main">
      <div class="stack">
        <section class="hero">
          <div class="row-between">
            <ProductMark />
            <span class="badge badge-warning badge-dot">DEMO / STAGING</span>
          </div>
          <h1>{PRODUCT_NAME} – Demo-Umgebung</h1>
          <p class="mb-0">{PRODUCT_TAGLINE}. Probiere Mitarbeiter-App, Chef-Portal und Super-Admin mit erfundenen Beispieldaten aus.</p>
        </section>
        <Alert tone="warning" title="Nur zur Vorschau">
          <p>Dies ist ein Demo- und Staging-Build. Alle Firmen, Personen und Zeiten sind <strong>erfunden</strong>. Daten werden ausschließlich in diesem Browser gespeichert – es findet keine Übertragung an einen Server statt. Bitte keine echten personenbezogenen Daten eingeben.</p>
        </Alert>
        <AreaCards />
        <Card title="Demo-Zugänge">
          <p class="muted small">Passwort für alle Zugänge: <code>{DEMO_PASSWORD}</code>. Jeder Bereich hat eine eigene Anmeldung.</p>
          <div class="table-wrap">
            <table class="table table-responsive">
              <caption class="sr-only">Demo-Zugänge</caption>
              <thead><tr><th scope="col">E-Mail</th><th scope="col">Rolle</th><th scope="col">Bereich</th></tr></thead>
              <tbody>
                {DEMO_LOGINS.map((l) => (
                  <tr key={l.email}>
                    <td data-label="E-Mail"><code>{l.email}</code></td>
                    <td data-label="Rolle">{l.label}</td>
                    <td data-label="Bereich"><a href={`${l.area}/`}>{l.area === "app" ? "Mitarbeiter-App" : l.area === "chef" ? "Chef-Portal" : "Super-Admin"}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Mandanten in der Demo" muted>
          <ul class="stack-sm" style={{ margin: 0, paddingLeft: "1.2em" }}>
            <li><strong>Demo Krankentransporte</strong> – UWE-Markenauftritt als Mandanten-Branding, UWE-Pausenregeln, Arbeitszeitkonto pro NRW-Schuljahr mit Startsaldo –100 Std., Pilotlizenz „Kostenlos – Pilot“.</li>
            <li><strong>Muster Pflegedienst GmbH</strong> – eigenes Logo und Farben, Arbeitszeitkonto pro Kalenderjahr, Standardkunde (5,00 € inkl. USt. je abrechenbarem Mitarbeiter und Monat).</li>
          </ul>
        </Card>
        <Card><div style={{ maxWidth: "420px" }}><ThemeSwitch hint="Wird nur auf diesem Gerät gespeichert." /></div></Card>
        <div class="row-between">
          <p class="muted small mb-0">Die bestehende UWE Stunden-App bleibt davon unberührt.</p>
          <Button variant="secondary" icon="refresh" onClick={reset} busy={busy}>Demo-Daten zurücksetzen</Button>
        </div>
      </div>
    </main>
  );
}

/** API build: plain entry page to the three areas (no demo data, no demo logins). */
function ApiStart() {
  return (
    <main class="m-main" style={{ maxWidth: "1100px", paddingBottom: "var(--space-10)", paddingTop: "var(--space-6)" }} id="main">
      <div class="stack">
        <section class="hero">
          <ProductMark />
          <h1>{PRODUCT_NAME}</h1>
          <p class="mb-0">{PRODUCT_TAGLINE}.</p>
        </section>
        <AreaCards />
      </div>
    </main>
  );
}

render(IS_DEMO ? <ToastProvider><DialogProvider><Start /></DialogProvider></ToastProvider> : <ApiStart />, document.getElementById("root")!);

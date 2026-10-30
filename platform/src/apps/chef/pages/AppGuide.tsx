/**
 * Printable one-page guide for employees: QR code to the employee app plus
 * the steps for iPhone and Android. The Chef prints it (or saves it as PDF)
 * and hangs it up or hands it out. Contains no personal data – only the
 * company name and the address of the employee app.
 */
import { Button, Icon, LinkButton } from "../../../design";
import { BrowserSteps, SafariSteps } from "../../shared/installSteps";
import { QrCodeImage } from "../../shared/twoFactor";
import { TenantLogo } from "../../shared/ui";
import { useChef } from "../context";

/** Address of the employee app next to the Chef-Portal (…/chef/ → …/app/). */
export function employeeAppUrl(href: string): string {
  const u = new URL("../app/", href);
  u.hash = "";
  u.search = "";
  return u.href;
}

export function AppGuidePage() {
  const { tenant } = useChef();
  const url = employeeAppUrl(location.href);
  return (
    <div class="stack">
      <div class="row-between no-print">
        <h1 class="page-title">Kurzanleitung für Mitarbeiter</h1>
        <div class="btn-row">
          <LinkButton href="#/mitarbeiter" icon="chevronLeft">Zurück</LinkButton>
          <Button icon="printer" onClick={() => window.print()}>Drucken</Button>
        </div>
      </div>
      <p class="muted small mb-0 no-print">
        Zum Aushängen oder Mitgeben: Mit dem QR-Code öffnen deine Mitarbeiter die Zeiterfassung direkt am Handy und legen sie
        als App auf den Startbildschirm. Beim Drucken kannst du auch „Als PDF speichern“ wählen und die Datei per WhatsApp verschicken.
      </p>

      <article class="card print-sheet" data-testid="app-guide" aria-label="Kurzanleitung zum Ausdrucken">
        <header class="print-sheet-head">
          <TenantLogo name={tenant.name} branding={tenant.branding} />
          <h2 class="mb-0">Deine Zeiterfassung als App</h2>
          <p class="muted mb-0">Kostenlos · ohne App-Store · für iPhone und Android</p>
        </header>

        <section class="print-sheet-qr">
          <QrCodeImage text={url} label={`QR-Code zur Mitarbeiter-App: ${url}`} />
          <div class="stack-sm">
            <p class="mb-0"><strong>1. Mit der Handy-Kamera scannen</strong> und den Link öffnen.</p>
            <p class="small mb-0">Oder diese Adresse eintippen:</p>
            <p class="share-link mb-0" data-testid="app-guide-url">{url}</p>
          </div>
        </section>

        <section class="stack-sm">
          <h3 class="mb-0">2. Als App auf den Startbildschirm legen</h3>
          <div class="print-sheet-cols">
            <div class="stack-sm">
              <h4 class="mb-0"><Icon name="smartphone" size={18} /> iPhone (Safari)</h4>
              <SafariSteps />
            </div>
            <div class="stack-sm">
              <h4 class="mb-0"><Icon name="smartphone" size={18} /> Android (Chrome)</h4>
              <BrowserSteps platform="android" />
            </div>
          </div>
        </section>

        <section class="stack-sm">
          <h3 class="mb-0">3. Anmelden</h3>
          <p class="small mb-0">
            Mit deiner E-Mail-Adresse und deinem Passwort anmelden. Noch kein Passwort? Du bekommst von uns einen
            <strong> Einladungslink</strong> per E-Mail oder WhatsApp – damit legst du es selbst fest.
            Passwort vergessen? Auf der Anmeldeseite „Passwort vergessen?“ tippen.
          </p>
        </section>

        <p class="small mb-0 print-sheet-contact">Fragen? Ansprechpartner: ____________________________</p>
      </article>
    </div>
  );
}

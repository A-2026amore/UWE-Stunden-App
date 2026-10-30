/**
 * Illustrated steps for putting the employee app on the home screen – shared
 * by the employee app (InstallHint) and the printable guide in the Chef-Portal.
 */
import type { ComponentChildren } from "preact";
import { Icon, type IconName } from "../../design";

export type InstallPlatform = "ios" | "android" | "desktop";

export function Step({ icon, children }: { icon: IconName; children: ComponentChildren }) {
  return (
    <li>
      <span class="install-step-icon" aria-hidden="true"><Icon name={icon} size={22} /></span>
      <span class="install-step-text">{children}</span>
    </li>
  );
}

const OPEN_STEP = <>Die App über das <strong>neue Symbol auf dem Startbildschirm</strong> öffnen und dort anmelden. Fertig!</>;

export function SafariSteps() {
  return (
    <>
      <ol class="install-steps" data-testid="install-steps-ios">
        <Step icon="share">Unten auf das <strong>Teilen-Symbol</strong> tippen (Quadrat mit Pfeil nach oben). Neuere iPhones: zuerst unten rechts auf <strong>„•••“</strong>.</Step>
        <Step icon="plusSquare">Etwas nach unten wischen und <strong>„Zum Home-Bildschirm“</strong> wählen.</Step>
        <Step icon="check">Oben rechts auf <strong>„Hinzufügen“</strong> tippen.</Step>
        <Step icon="smartphone">{OPEN_STEP}</Step>
      </ol>
      <p class="xsmall muted mb-0">Kein „Zum Home-Bildschirm“ zu sehen? Dann ist die Seite noch in WhatsApp oder einer anderen App geöffnet: auf das <strong>Safari-Symbol (Kompass)</strong> bzw. „In Safari öffnen“ tippen und es dort noch einmal versuchen.</p>
    </>
  );
}

export function BrowserSteps({ platform }: { platform: InstallPlatform }) {
  return (
    <ol class="install-steps" data-testid="install-steps-browser">
      <Step icon="moreVertical">Das Browser-Menü öffnen: {platform === "android" ? <strong>⋮ oben rechts</strong> : <strong>Symbol in der Adressleiste oder ⋮</strong>}.</Step>
      <Step icon="download"><strong>„App installieren“</strong> oder <strong>„Zum Startbildschirm hinzufügen“</strong> wählen.</Step>
      <Step icon="check">Mit <strong>„Installieren“</strong> bzw. <strong>„Hinzufügen“</strong> bestätigen.</Step>
      {platform !== "desktop" && <Step icon="smartphone">{OPEN_STEP}</Step>}
    </ol>
  );
}

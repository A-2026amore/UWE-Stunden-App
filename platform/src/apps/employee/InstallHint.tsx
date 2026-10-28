/**
 * "Zum Home-Bildschirm hinzufügen": installation hint for the employee app.
 *  - iPhone/iPad (Safari has no install prompt): step-by-step instructions;
 *  - Android/Chrome/Edge: the browser's install dialog (beforeinstallprompt),
 *    otherwise instructions for the browser menu;
 *  - hidden when the app already runs installed (standalone).
 * The start page shows a dismissible short version, the settings page the
 * full card.
 */
import { useEffect, useState } from "preact/hooks";
import { Button, Card } from "../../design";

export type InstallPlatform = "ios" | "android" | "desktop";

/** Platform for the instructions. iPadOS 13+ reports itself as Mac with touch. */
export function installPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "desktop";
}

export function isStandalone(): boolean {
  try {
    return window.matchMedia?.("(display-mode: standalone)").matches === true
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Captured as early as possible (the event fires once, shortly after load).
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    for (const l of listeners) l();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    for (const l of listeners) l();
  });
}

const DISMISS_KEY = "stundenwerk_install_hint_dismissed";

function readDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
}

function useInstall() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((x) => x + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  const platform = installPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  const install = async () => {
    const ev = deferred;
    if (!ev) return;
    await ev.prompt();
    await ev.userChoice.catch(() => undefined);
    deferred = null;
    rerender((x) => x + 1);
  };
  return { platform, canPrompt: deferred !== null, install, installed: isStandalone() };
}

function Steps({ platform }: { platform: InstallPlatform }) {
  if (platform === "ios") {
    return (
      <ol class="small" data-testid="install-steps-ios">
        <li>Diese Seite in <strong>Safari</strong> öffnen.</li>
        <li>Unten auf <strong>Teilen</strong> tippen (Quadrat mit Pfeil nach oben).</li>
        <li><strong>„Zum Home-Bildschirm“</strong> wählen und mit <strong>„Hinzufügen“</strong> bestätigen.</li>
      </ol>
    );
  }
  return (
    <ol class="small" data-testid="install-steps-browser">
      <li>Das Browser-Menü öffnen ({platform === "android" ? "⋮ oben rechts" : "Symbol in der Adressleiste oder ⋮"}).</li>
      <li><strong>„App installieren“</strong> oder <strong>„Zum Startbildschirm hinzufügen“</strong> wählen.</li>
    </ol>
  );
}

/** Full card for the settings page. */
export function InstallCard() {
  const { platform, canPrompt, install, installed } = useInstall();
  return (
    <Card title="App auf dem Startbildschirm">
      {installed ? (
        <p class="small mb-0">Die App ist auf diesem Gerät installiert. Du startest sie über das Symbol auf dem Startbildschirm.</p>
      ) : (
        <div class="stack-sm install-hint">
          <p class="small mb-0">Mit dem Symbol auf dem Startbildschirm öffnest du die Zeiterfassung wie eine App – ohne App-Store, auch bei schwachem Netz.</p>
          {canPrompt ? <div><Button icon="download" onClick={install}>App installieren</Button></div> : <Steps platform={platform} />}
        </div>
      )}
    </Card>
  );
}

/** Short, dismissible hint for the start page (not shown when installed or dismissed). */
export function InstallBanner() {
  const { platform, canPrompt, install, installed } = useInstall();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (installed || dismissed) return null;
  const close = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* not persisted – shown again next time */ }
  };
  return (
    <section class="card card-muted install-hint" aria-labelledby="install-hint-title" data-testid="install-hint">
      <div class="row-between">
        <h2 id="install-hint-title" class="h3 mb-0" style={{ fontSize: "var(--text-md, 1rem)" }}>Zum Home-Bildschirm hinzufügen</h2>
        <Button variant="ghost" size="sm" icon="x" aria-label="Hinweis ausblenden" onClick={close} />
      </div>
      {canPrompt
        ? <div class="row"><p class="small mb-0" style={{ flex: 1 }}>Die Zeiterfassung als App auf diesem Gerät installieren.</p><Button size="sm" icon="download" onClick={install}>Installieren</Button></div>
        : <Steps platform={platform} />}
    </section>
  );
}

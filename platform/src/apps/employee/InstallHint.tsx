/**
 * "Zum Home-Bildschirm hinzufügen": installation help for the employee app,
 * written for people who never installed a web app before.
 *  - Android/Chrome/Edge: the browser's install dialog (beforeinstallprompt),
 *    otherwise illustrated steps for the browser menu;
 *  - iPhone/iPad (Safari has no install dialog): illustrated Safari steps;
 *    other iOS browsers get "open in Safari" with a copy-link button;
 *  - in-app browsers (Facebook, Instagram, Google app, Android WebView …)
 *    cannot install at all: explain how to open the page in the real browser;
 *  - hidden when the app already runs installed (standalone) or the browser
 *    reported a successful installation.
 * The start page shows a prominent banner ("Später" hides it for a week), the
 * settings page the full card and the login screen a short version on phones,
 * so that the employee signs in only once – inside the installed app.
 */
import { useEffect, useState } from "preact/hooks";
import { Alert, Button, Card } from "../../design";
import { BrowserSteps, SafariSteps, Step, type InstallPlatform } from "../shared/installSteps";

export type { InstallPlatform };
/** "inapp": a browser inside another app, "ios-other": Chrome/Firefox/Edge … on iOS. */
export type InstallBrowser = "default" | "inapp" | "ios-other";

/** Platform for the instructions. iPadOS 13+ reports itself as Mac with touch. */
export function installPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "desktop";
}

/**
 * Browsers that cannot (or not reliably) add the app to the home screen.
 * WhatsApp and Mail on iOS open links in an in-app Safari view that is not
 * recognisable here – the Safari steps therefore mention the compass button.
 */
export function installBrowser(userAgent: string, platform: InstallPlatform): InstallBrowser {
  if (/FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Snapchat|musical_ly|TikTok|Line\/|MicroMessenger|GSA\/|; wv\)/i.test(userAgent)) return "inapp";
  if (platform === "ios" && /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|DuckDuckGo/i.test(userAgent)) return "ios-other";
  return "default";
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

const DISMISS_KEY = "stundenwerk_install_hint_dismissed";
const INSTALLED_KEY = "stundenwerk_app_installed";
/** "Später" hides the start-page banner for this long. */
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* not persisted – shown again next time */ }
}

/** Banner hidden? The stored value is the time of "Später" (older versions stored "1" = long ago). */
export function isSnoozed(stored: string | null, now = Date.now()): boolean {
  const at = Number(stored);
  return stored !== null && Number.isFinite(at) && now - at < SNOOZE_MS;
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
    storageSet(INSTALLED_KEY, "1");
    for (const l of listeners) l();
  });
}

/** Address of the employee app (without the in-app route), for "Link kopieren". */
function appUrl(): string {
  return location.origin + location.pathname;
}

function useInstall() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((x) => x + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  const platform = installPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  const browser = installBrowser(navigator.userAgent, platform);
  const install = async () => {
    const ev = deferred;
    if (!ev) return;
    await ev.prompt();
    const choice = await ev.userChoice.catch(() => undefined);
    if (choice?.outcome === "accepted") storageSet(INSTALLED_KEY, "1");
    deferred = null;
    rerender((x) => x + 1);
  };
  return {
    platform, browser, install,
    canPrompt: deferred !== null,
    standalone: isStandalone(),
    /** Installed from this browser (Android reports it); the browser tab itself is not standalone. */
    installedHere: storageGet(INSTALLED_KEY) === "1",
  };
}

/** Copies the app address (the login screen has no toast region, so the result is shown inline). */
function CopyLink() {
  const [result, setResult] = useState<"ok" | "failed" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(appUrl());
      setResult("ok");
    } catch {
      setResult("failed");
    }
  };
  return (
    <div class="stack-sm">
      <div><Button variant="secondary" size="sm" icon="share" onClick={copy}>Link kopieren</Button></div>
      {result === "ok" && <p class="xsmall mb-0" role="status">Link kopiert – jetzt im Browser oben in die Adresszeile einfügen.</p>}
      {result === "failed" && <p class="xsmall mb-0" role="status">Kopieren nicht möglich – bitte diese Adresse abtippen: <span class="share-link">{appUrl()}</span></p>}
    </div>
  );
}

/** The actual help: install button, warnings and steps for this device. */
export function InstallGuide() {
  const { platform, browser, canPrompt, install } = useInstall();
  if (browser === "inapp") {
    return (
      <div class="stack-sm" data-testid="install-inapp">
        <Alert tone="warning">
          <p>Die Seite ist gerade in einer anderen App geöffnet (z. B. Facebook, Instagram oder Google). Von hier aus lässt sich die Zeiterfassung nicht installieren.</p>
        </Alert>
        <ol class="install-steps">
          {platform === "ios"
            ? <Step icon="compass">Auf <strong>„In Safari öffnen“</strong> bzw. das <strong>Safari-Symbol</strong> tippen (oft unter <strong>•••</strong> oder dem Teilen-Symbol).</Step>
            : <Step icon="moreVertical">Oben rechts auf <strong>⋮</strong> tippen und <strong>„Im Browser öffnen“</strong> bzw. <strong>„In Chrome öffnen“</strong> wählen.</Step>}
          <Step icon="globe">Klappt das nicht: Link kopieren und im {platform === "ios" ? "Safari" : "Chrome"}-Browser einfügen.</Step>
        </ol>
        <CopyLink />
      </div>
    );
  }
  if (browser === "ios-other") {
    return (
      <div class="stack-sm" data-testid="install-ios-other">
        <Alert tone="info">
          <p>Am iPhone klappt das am einfachsten mit <strong>Safari</strong>: Link kopieren, Safari öffnen, oben in die Adresszeile einfügen – dann diese Schritte:</p>
        </Alert>
        <CopyLink />
        <SafariSteps />
      </div>
    );
  }
  if (canPrompt) {
    return (
      <div class="stack-sm">
        <Button block icon="download" onClick={install}>App installieren</Button>
        <p class="xsmall muted mb-0">Danach findest du die Zeiterfassung als Symbol auf deinem Startbildschirm.</p>
      </div>
    );
  }
  return platform === "ios" ? <SafariSteps /> : <BrowserSteps platform={platform} />;
}

/** Full card for the settings page. */
export function InstallCard() {
  const { standalone, installedHere } = useInstall();
  const [again, setAgain] = useState(false);
  return (
    <Card title="App auf dem Startbildschirm">
      {standalone ? (
        <p class="small mb-0">Die App ist auf diesem Gerät installiert. Du startest sie über das Symbol auf dem Startbildschirm.</p>
      ) : installedHere && !again ? (
        <div class="stack-sm">
          <p class="small mb-0">Die App ist auf diesem Gerät installiert. Öffne sie am besten über das Symbol auf dem Startbildschirm.</p>
          <div><Button variant="ghost" size="sm" onClick={() => setAgain(true)}>Symbol gelöscht? So holst du es zurück</Button></div>
        </div>
      ) : (
        <div class="stack-sm install-hint">
          <p class="small mb-0">Mit dem Symbol auf dem Startbildschirm öffnest du die Zeiterfassung wie eine App – kostenlos, ohne App-Store, auch bei schwachem Netz.</p>
          <InstallGuide />
        </div>
      )}
    </Card>
  );
}

/** Prominent hint for the start page (not shown when installed; "Später" hides it for a week). */
export function InstallBanner() {
  const { standalone, installedHere } = useInstall();
  const [snoozed, setSnoozed] = useState(() => isSnoozed(storageGet(DISMISS_KEY)));
  if (standalone || installedHere || snoozed) return null;
  const later = () => {
    setSnoozed(true);
    storageSet(DISMISS_KEY, String(Date.now()));
  };
  return (
    <section class="card install-hint install-banner stack-sm" aria-labelledby="install-hint-title" data-testid="install-hint">
      <div class="row-between">
        <h2 id="install-hint-title" class="h3 mb-0" style={{ fontSize: "var(--text-md, 1rem)" }}>Zeiterfassung als App aufs Handy</h2>
        <Button variant="ghost" size="sm" icon="x" aria-label="Hinweis ausblenden" onClick={later} />
      </div>
      <p class="small mb-0">Einmal einrichten, dann startest du die Zeiterfassung mit einem Tipp – wie jede andere App. Kostenlos, ohne App-Store.</p>
      <InstallGuide />
      <div><Button variant="ghost" size="sm" onClick={later}>Später erinnern</Button></div>
    </section>
  );
}

/**
 * Short version below the login form on phones. On the iPhone the installed
 * app keeps its own sign-in, so installing first saves a second login.
 */
export function LoginInstallHint() {
  const { platform, standalone, installedHere } = useInstall();
  if (standalone || installedHere || platform === "desktop") return null;
  return (
    <section class="card card-muted install-hint stack-sm" aria-labelledby="login-install-title" data-testid="login-install-hint">
      <h2 id="login-install-title" class="h3 mb-0" style={{ fontSize: "var(--text-md, 1rem)" }}>Tipp: Erst als App speichern, dann anmelden</h2>
      <p class="small mb-0">So hast du die Zeiterfassung immer mit einem Tipp auf dem Startbildschirm.</p>
      <InstallGuide />
    </section>
  );
}

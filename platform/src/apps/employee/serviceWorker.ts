/**
 * Registration of the employee app's service worker (dist/app/sw.js, scope:
 * the app directory) and the update flow "Neue Version verfügbar – neu laden".
 *
 * Registered only in production builds and only over HTTPS or on localhost.
 * A new version waits until the user confirms; then it takes over and the
 * page reloads once.
 */
type Listener = (updateAvailable: boolean) => void;

const listeners = new Set<Listener>();
let waiting: ServiceWorker | null = null;
let reloadOnChange = false;

function setWaiting(sw: ServiceWorker | null): void {
  waiting = sw;
  for (const l of [...listeners]) l(!!sw);
}

export function onUpdateAvailable(listener: Listener): () => void {
  listeners.add(listener);
  listener(!!waiting);
  return () => listeners.delete(listener);
}

/** Activates the waiting version and reloads the page once it controls it. */
export function applyUpdate(): void {
  if (!waiting) return;
  reloadOnChange = true;
  waiting.postMessage({ type: "SKIP_WAITING" });
}

export function serviceWorkerAllowed(loc: Pick<Location, "protocol" | "hostname">, prod: boolean): boolean {
  if (!prod) return false;
  return loc.protocol === "https:" || loc.hostname === "localhost" || loc.hostname === "127.0.0.1" || loc.hostname === "[::1]";
}

export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!serviceWorkerAllowed(location, import.meta.env.PROD)) return;
  const sw = navigator.serviceWorker;
  sw.addEventListener("controllerchange", () => {
    // The first installation also changes the controller (clients.claim) – reload only after "neu laden".
    if (reloadOnChange) {
      reloadOnChange = false;
      location.reload();
    }
  });
  window.addEventListener("load", () => {
    sw.register("./sw.js", { scope: "./" }).then((reg) => {
      const track = (worker: ServiceWorker | null) => {
        if (!worker) return;
        const check = () => {
          // "installed" while a controller exists = an update (not the first installation).
          if (worker.state === "installed" && sw.controller) setWaiting(worker);
        };
        worker.addEventListener("statechange", check);
        check();
      };
      if (reg.waiting && sw.controller) setWaiting(reg.waiting);
      track(reg.installing);
      reg.addEventListener("updatefound", () => track(reg.installing));
      const update = () => { reg.update().catch(() => undefined); };
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") update(); });
      setInterval(update, 30 * 60 * 1000);
    }).catch(() => undefined);
  });
}

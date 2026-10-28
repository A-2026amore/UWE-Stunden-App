/*
 * Service worker of the employee app – template. The build (platform/vite.config.ts,
 * plugin "employee-service-worker") fills in the cache version and the precache
 * list and writes dist/app/sw.js. Registered with scope "./" (the app directory only).
 *
 * Rules:
 *  - Never touches /api/ requests, other origins or non-GET requests.
 *  - Caches only the built app shell (precache list generated at build time).
 *  - Cache names start with "stundenwerk-app-"; only own old versions are deleted.
 *  - Other code on the same origin may delete our cache (the legacy UWE app's
 *    service worker deletes every foreign cache when it updates). Missing
 *    entries are therefore re-cached on every app start and on cache misses.
 *  - A new version waits until the user chooses "Neue Version verfügbar – neu laden".
 */
const PREFIX = "stundenwerk-app-";
const CACHE = PREFIX + "__VERSION__";
const PRECACHE = __PRECACHE__; // eslint-disable-line no-undef -- filled in by the build

const SCOPE = new URL("./", self.location.href);
const SHELL = new URL("./index.html", SCOPE).href;
const PRECACHE_URLS = new Set(PRECACHE.map((u) => new URL(u, self.location.href).href));

function isApi(url) {
  return /(^|\/)api(\/|$)/.test(url.pathname);
}

/** Adds every precache URL that is missing in the cache (e.g. after a foreign cache deletion). */
async function fillCache() {
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const url of PRECACHE_URLS) {
    if (!(await cache.match(url))) missing.push(url);
  }
  await Promise.all(missing.map(async (url) => {
    const res = await fetch(url, { cache: "no-cache", credentials: "same-origin" });
    if (!res.ok) throw new Error("precache failed: " + url);
    await cache.put(url, res);
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(fillCache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Only our own older versions – never caches of other apps on this origin.
    await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

async function fromCache(key) {
  const cache = await caches.open(CACHE);
  return cache.match(key);
}

/** App start: network first (fresh HTML), offline → cached shell. Re-caches missing files in the background. */
async function navigation(event) {
  try {
    const res = await fetch(event.request);
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((c) => c.put(SHELL, copy)).then(fillCache).catch(() => undefined));
    }
    return res;
  } catch (e) {
    const cached = await fromCache(SHELL);
    if (cached) return cached;
    throw e;
  }
}

/** Shell files (hashed assets, icons, manifest): cache first, on a miss load and store again. */
async function shellFile(event, key) {
  const cached = await fromCache(key);
  if (cached) return cached;
  const res = await fetch(event.request);
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    event.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => undefined));
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isApi(url)) return;
  if (req.mode === "navigate") {
    if (url.pathname.startsWith(SCOPE.pathname)) event.respondWith(navigation(event));
    return;
  }
  const key = url.origin + url.pathname;
  if (PRECACHE_URLS.has(key)) event.respondWith(shellFile(event, key));
});

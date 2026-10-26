/**
 * Optional static file serving of the built frontend (platform/dist) by the
 * API process itself (STATIC_DIR). Everything below /api/ goes to the API.
 *
 * - Only GET/HEAD, only files inside STATIC_DIR (no traversal, no dotfiles,
 *   symlinks are resolved and must stay inside the root).
 * - "/dir" → 301 "/dir/" when dir/index.html exists, so the relative asset
 *   URLs of the built pages ("../assets/…") resolve correctly. Browsers keep
 *   the URL fragment (e.g. "#token=…") across the redirect.
 * - Hashed files under /assets/ are cached for a year; HTML, the service
 *   worker and the manifest are revalidated on every load.
 * - Strict CSP for the pages: only own scripts/styles (the Vite build has no
 *   inline scripts), images also as data:/blob: (logos, PDF preview), API on
 *   the same origin.
 */
import { createReadStream, realpathSync, statSync, type Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const HEADERS: Record<string, string> = {
  "Content-Security-Policy": STATIC_CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export interface StaticOptions {
  root: string;
  secure: boolean;
  log: (entry: Record<string, unknown>) => void;
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.statusCode = status;
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(status === 204 ? undefined : text);
}

/**
 * Wraps the API handler: /api/* → api, everything else → files from `root`.
 */
export function withStaticFiles(
  api: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  o: StaticOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = realpathSync(resolve(o.root));
  const inside = (p: string) => p === root || p.startsWith(root + sep);

  return async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      plain(res, 400, "Ungültige Adresse.");
      return;
    }
    if (isApiPath(url.pathname)) return api(req, res);

    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    if (o.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      plain(res, 405, "Diese Methode ist hier nicht erlaubt.", { Allow: "GET, HEAD" });
      return;
    }
    req.resume();

    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      plain(res, 400, "Ungültige Adresse.");
      return;
    }
    // No NUL bytes, no traversal, no hidden files (".env", ".git", …).
    if (path.includes("\0") || path.split("/").some((seg) => seg === ".." || (seg.startsWith(".") && seg !== ""))) {
      plain(res, 404, "Nicht gefunden.");
      return;
    }

    let file = join(root, path);
    let st = safeStat(file);
    if (st?.isDirectory()) {
      const index = join(file, "index.html");
      if (!safeStat(index)?.isFile()) {
        plain(res, 404, "Nicht gefunden.");
        return;
      }
      if (!url.pathname.endsWith("/")) {
        // Relative asset URLs need the trailing slash; the browser keeps "#token=…".
        plain(res, 301, "", { Location: url.pathname + "/" + url.search });
        return;
      }
      file = index;
      st = safeStat(file);
    }
    if (!st?.isFile()) {
      plain(res, 404, "Nicht gefunden.");
      return;
    }
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      plain(res, 404, "Nicht gefunden.");
      return;
    }
    if (!inside(real)) {
      plain(res, 404, "Nicht gefunden.");
      return;
    }

    const ext = extname(real).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", TYPES[ext] ?? "application/octet-stream");
    res.setHeader("Content-Length", st.size);
    const immutable = path.startsWith("/assets/") && /[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path);
    res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    if (method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(real);
    stream.on("error", (e) => {
      o.log({ level: "error", msg: "static file failed", path: path.slice(0, 200), error: e.message });
      res.destroy();
    });
    stream.pipe(res);
  };
}

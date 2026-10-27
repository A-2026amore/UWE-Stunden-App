/**
 * Minimal HTTP layer on node:http: routing, JSON bodies with size limits,
 * cookies, security headers, CORS and CSRF protection.
 *
 * CSRF: the session cookie is SameSite=Strict; additionally every
 * state-changing request (POST/PUT/PATCH/DELETE) must carry
 * `Content-Type: application/json` (not sendable by plain HTML forms) and an
 * `Origin` header that is one of PUBLIC_ORIGIN.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { HttpError, toHttpError } from "./errors.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const STATE_CHANGING: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

export interface RequestContext {
  req: IncomingMessage;
  method: Method;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  ip: string;
  cookies: Record<string, string>;
  requestId: string;
}

export type Handler = (ctx: RequestContext) => Promise<Reply>;

interface Route {
  method: Method;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  bodyLimit: number;
}

export const DEFAULT_BODY_LIMIT = 32 * 1024;

export class Router {
  private readonly routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler, opts: { bodyLimit?: number } = {}): void {
    const keys: string[] = [];
    const src = pattern.replace(/:([A-Za-z]+)/g, (_m, k: string) => {
      keys.push(k);
      return "([^/]+)";
    });
    this.routes.push({ method, regex: new RegExp(`^${src}$`), keys, handler, bodyLimit: opts.bodyLimit ?? DEFAULT_BODY_LIMIT });
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]!);
        } catch {
          throw new HttpError(400, "invalid", "Ungültige Adresse.");
        }
      });
      return { route: r, params };
    }
    return pathMatched ? "method" : null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (o.secure) parts.push("Secure");
  if (o.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAgeSeconds))}`);
  return parts.join("; ");
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-site",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cache-Control": "no-store",
};

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, "payload_too_large", "Die Anfrage ist zu groß."));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, "payload_too_large", "Die Anfrage ist zu groß."));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

export interface HttpOptions {
  allowedOrigins: string[];
  secure: boolean;
  trustProxy: boolean;
  /** Networks (CIDR) whose peers may set X-Forwarded-For. Empty = every peer (only when TRUST_PROXY=1). */
  trustedProxies?: readonly string[];
  log: (entry: Record<string, unknown>) => void;
}

/** "::ffff:172.18.0.2" → "172.18.0.2"; other addresses unchanged. */
function normalizeAddress(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1]! : addr;
}

/**
 * Parses a list of networks ("172.18.0.0/16", "10.0.0.5", "fd00::/8") into a matcher
 * for the socket peer address. Throws on invalid entries.
 */
export function createProxyMatcher(cidrs: readonly string[]): (addr: string | undefined) => boolean {
  const list = new BlockList();
  for (const raw of cidrs) {
    const [ip, prefixRaw, extra] = raw.trim().split("/");
    const family = isIP(ip ?? "");
    const max = family === 4 ? 32 : 128;
    const prefix = prefixRaw === undefined ? max : Number(prefixRaw);
    if (!family || extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max || (prefixRaw !== undefined && !/^\d+$/.test(prefixRaw))) {
      throw new Error(`TRUST_PROXY_CIDRS enthält kein gültiges Netz: ${raw}`);
    }
    list.addSubnet(ip!, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return (addr) => {
    if (!addr) return false;
    const a = normalizeAddress(addr);
    const family = isIP(a);
    if (!family) return false;
    return list.check(a, family === 4 ? "ipv4" : "ipv6");
  };
}

const matcherCache = new WeakMap<readonly string[], (addr: string | undefined) => boolean>();

export function clientIp(req: IncomingMessage, trustProxy: boolean, trustedProxies: readonly string[] = []): string {
  let trusted = trustProxy;
  if (trusted && trustedProxies.length > 0) {
    let match = matcherCache.get(trustedProxies);
    if (!match) {
      match = createProxyMatcher(trustedProxies);
      matcherCache.set(trustedProxies, match);
    }
    // Only the reverse proxy's network may name the client; anyone else gets their socket address.
    trusted = match(req.socket.remoteAddress);
  }
  if (trusted) {
    const xff = req.headers["x-forwarded-for"];
    const value = Array.isArray(xff) ? xff.join(",") : xff;
    // The local proxy appends the real client address as the last entry.
    const last = value?.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (status === 204 || body === undefined) {
    res.statusCode = status;
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(json));
  res.end(json);
}

export function createRequestHandler(router: Router, o: HttpOptions) {
  // The opaque origin "null" (sandboxed frames, file://) is never trusted.
  const allowedOrigins = o.allowedOrigins.filter((a) => a !== "null");
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const requestId = randomUUID();
    const method = (req.method ?? "GET").toUpperCase();
    let path = "/";
    let status = 500;
    try {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      if (o.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      res.setHeader("X-Request-Id", requestId);

      const url = new URL(req.url ?? "/", "http://localhost");
      path = url.pathname;
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
      // Echo the configured value, never the request header itself.
      const allowedOrigin = origin === null ? undefined : allowedOrigins.find((a) => a === origin);
      const originAllowed = allowedOrigin !== undefined;
      if (originAllowed) {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      res.setHeader("Vary", "Origin");

      if (method === "OPTIONS") {
        if (!originAllowed) throw new HttpError(403, "forbidden", "Ungültige Herkunft der Anfrage.");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
        status = 204;
        send(res, 204, undefined);
        return;
      }

      const matched = router.match(method, path);
      if (matched === null) throw new HttpError(404, "not_found", "Diese Adresse gibt es nicht.");
      if (matched === "method") throw new HttpError(405, "method_not_allowed", "Diese Methode ist hier nicht erlaubt.");

      let body: unknown = undefined;
      if (STATE_CHANGING.has(method)) {
        if (!originAllowed) throw new HttpError(403, "forbidden", "Ungültige Herkunft der Anfrage.");
        const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (ct !== "application/json") {
          throw new HttpError(415, "unsupported_media_type", "Anfragen müssen als JSON (Content-Type: application/json) gesendet werden.");
        }
        const raw = await readBody(req, matched.route.bodyLimit);
        if (raw.trim() === "") body = {};
        else {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new HttpError(400, "invalid", "Die Anfrage enthält kein gültiges JSON.");
          }
        }
      } else {
        req.resume();
      }

      const reply = await matched.route.handler({
        req,
        method: method as Method,
        path,
        params: matched.params,
        query: url.searchParams,
        body,
        ip: clientIp(req, o.trustProxy, o.trustedProxies),
        cookies: parseCookies(req.headers.cookie),
        requestId,
      });
      status = reply.status;
      send(res, reply.status, reply.body, reply.headers);
    } catch (err) {
      const e = toHttpError(err);
      status = e.status;
      if (e.status >= 500) {
        const pg = err as { code?: string; message?: string };
        o.log({ level: "error", requestId, msg: "request failed", code: pg?.code ?? null, error: pg?.message?.slice(0, 300) ?? String(err) });
      }
      if (!res.headersSent) send(res, e.status, { error: { code: e.code, message: e.message } }, e.headers);
      else res.end();
    } finally {
      // Never log bodies, cookies or query strings (may contain personal data).
      o.log({ level: "info", requestId, method, path: path.slice(0, 200), status, ms: Date.now() - started });
    }
  };
}

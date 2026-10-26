/**
 * Application wiring: authentication routes, session handling and the shared
 * helpers used by the domain routes (routes.ts).
 *
 * Request pipeline (docs/api.md): cookie → session lookup as app_auth →
 * new transaction as app_user with request.jwt.claims.sub = verified user id.
 * Row Level Security in PostgreSQL is the security boundary.
 */
import type pg from "pg";
import type { Session } from "../../platform/src/data/repository.ts";
import type { TenantRole } from "../../platform/src/core/types.ts";
import {
  createPasswordReset, createSession, getDummyHash, getLogin, ONE_TIME_TOKEN_RE, passwordProblem,
  resolveSession, revokeSession, verifyPassword, acceptInvitation, invitationNeedsExistingLogin, resetPassword, PASSWORD_MAX, type SessionRecord,
} from "./auth.ts";
import type { Config } from "./config.ts";
import { withTx, type Queryable } from "./db.ts";
import { HttpError, badRequest } from "./errors.ts";
import { Router, createRequestHandler, serializeCookie, type Reply, type RequestContext } from "./http.ts";
import type { Mail, Mailer } from "./mailer.ts";
import { RateLimiter } from "./rateLimit.ts";
import { registerDomainRoutes } from "./routes.ts";
import { withStaticFiles } from "./static.ts";
import * as v from "./validate.ts";

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  mailer: Mailer;
  log?: (entry: Record<string, unknown>) => void;
}

export interface Membership {
  tenantId: string;
  employeeId: string;
  role: TenantRole;
  tenantName: string;
  /** Since 0008: memberships of suspended/pending tenants are listed too. */
  tenantStatus: "active" | "suspended" | "pending";
}

/** Session as in repository.ts, plus all memberships (for a later tenant switch). */
export type ApiSession = Session & { memberships: Membership[] };

/** Helpers handed to the domain routes. */
export interface AppContext {
  config: Config;
  pool: pg.Pool;
  /** Runs fn as app_user for the signed-in user (401 without valid session). */
  asUser<T>(ctx: RequestContext, fn: (q: Queryable, s: SessionRecord) => Promise<T>): Promise<T>;
  asAnon<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Sends mails after the transaction committed; failures are logged, never shown. */
  sendLater(mails: Mail[]): void;
  link(kind: "reset" | "invite", token: string): string;
  /** How mails leave this server: SMTP, development log (no SMTP) or not at all (production without SMTP). */
  mailDelivery: "email" | "log" | "none";
  log: (entry: Record<string, unknown>) => void;
}

const defaultLog = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  if (entry.level === "error") console.error(line);
  else console.log(line);
};

export interface Blocked {
  code: "tenant_suspended" | "forbidden";
  message: string;
}

export async function buildSession(q: Queryable, userId: string, email: string): Promise<{ session: ApiSession; blocked: Blocked | null }> {
  const ctx = (await q.query<{ c: { memberships: Membership[]; platformRole: Session["platformRole"] } }>(
    "select public.current_session_context() as c",
  )).rows[0]!.c;
  const memberships = ctx.memberships ?? [];
  const active = memberships.find((m) => m.tenantStatus === "active") ?? null;
  const session: ApiSession = {
    userId,
    email,
    tenantId: active?.tenantId ?? null,
    employeeId: active?.employeeId ?? null,
    role: active?.role ?? null,
    platformRole: ctx.platformRole ?? null,
    memberships,
  };
  let blocked: Blocked | null = null;
  if (!active && !session.platformRole) {
    blocked = memberships.length
      ? { code: "tenant_suspended", message: "Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber." }
      : { code: "forbidden", message: "Dein Zugang ist nicht aktiv. Bitte wende dich an deinen Arbeitgeber." };
  }
  return { session, blocked };
}

export function createApp(deps: AppDeps) {
  const { config, pool, mailer } = deps;
  const log = deps.log ?? defaultLog;
  const cookieName = config.secureCookies ? "__Host-sid" : "sid";
  const rl = config.rateLimit;
  const limiters = {
    loginKey: new RateLimiter(rl.loginPerKey, rl.windowMs),
    loginIp: new RateLimiter(rl.loginPerIp, rl.windowMs),
    resetKey: new RateLimiter(rl.resetPerKey, rl.windowMs),
    resetIp: new RateLimiter(rl.loginPerIp, rl.windowMs),
    tokenIp: new RateLimiter(rl.tokenPerIp, rl.windowMs),
  };

  const tooMany = (seconds: number, what: string) =>
    new HttpError(429, "rate_limited", `Zu viele ${what}. Bitte in ${Math.max(1, Math.ceil(seconds / 60))} Minuten erneut versuchen.`, {
      "Retry-After": String(seconds),
    });

  const sessionCookie = (token: string, maxAgeSeconds: number) =>
    serializeCookie(cookieName, token, { secure: config.secureCookies, maxAgeSeconds });
  const clearCookie = () => serializeCookie(cookieName, "", { secure: config.secureCookies, maxAgeSeconds: 0 });

  async function requireSession(ctx: RequestContext): Promise<SessionRecord> {
    const token = ctx.cookies[cookieName];
    const rec = token ? await resolveSession(pool, token, config.sessionIdleMinutes) : null;
    if (!rec) throw new HttpError(401, "unauthenticated", "Bitte melde dich an.");
    return rec;
  }

  const app: AppContext = {
    config,
    pool,
    log,
    mailDelivery: config.smtp ? "email" : config.production ? "none" : "log",
    async asUser(ctx, fn) {
      const rec = await requireSession(ctx);
      return withTx(pool, "app_user", rec.userId, async (q) => {
        // An existing session stops working as soon as the tenant is suspended
        // (RLS would only answer with empty results / generic 403).
        const { blocked } = await buildSession(q, rec.userId, rec.email);
        if (blocked) throw new HttpError(403, blocked.code, blocked.message);
        return fn(q, rec);
      });
    },
    asAnon(fn) {
      return withTx(pool, "app_anon", null, fn);
    },
    sendLater(mails) {
      for (const m of mails) {
        mailer.send(m).catch((e: unknown) => log({ level: "error", msg: "mail delivery failed", error: (e as Error)?.message ?? "unknown" }));
      }
    },
    link(kind, token) {
      const path = kind === "reset" ? config.resetLinkPath : config.inviteLinkPath;
      // Token in the fragment: never sent to servers, not in access logs or Referer.
      return `${config.publicOrigins[0]}${path}#token=${encodeURIComponent(token)}`;
    },
  };

  const router = new Router();

  // ---------------------------------------------------------------- health & public
  router.add("GET", "/api/health", async () => {
    await app.asAnon((q) => q.query("select 1"));
    return { status: 200, body: { ok: true } };
  });

  router.add("GET", "/api/public/tenants/:slug/branding", async (ctx) => {
    const slug = v.str(ctx.params.slug, { label: "Kurzname", max: 50, pattern: /^[a-z0-9-]{3,50}$/ });
    const row = await app.asAnon(async (q) => (await q.query("select * from public.public_tenant_branding($1)", [slug])).rows[0]);
    if (!row) throw new HttpError(404, "not_found", "Firma nicht gefunden.");
    return { status: 200, body: { slug: row.slug, name: row.name, branding: row.branding } };
  });

  // ---------------------------------------------------------------- authentication
  router.add("POST", "/api/auth/login", async (ctx): Promise<Reply> => {
    const b = v.object(ctx.body, ["email", "password"]);
    if (typeof b.email !== "string" || typeof b.password !== "string" || b.email.length > 254 || b.password.length > PASSWORD_MAX) {
      throw badRequest("Bitte E-Mail-Adresse und Passwort eingeben.");
    }
    const email = b.email.trim().toLowerCase();
    const key = `${ctx.ip}|${email}`;
    const wait = Math.max(limiters.loginIp.blockedFor(ctx.ip), limiters.loginKey.blockedFor(key));
    if (wait > 0) throw tooMany(wait, "Anmeldeversuche");
    limiters.loginIp.hit(ctx.ip);

    const login = email ? await getLogin(pool, email) : null;
    // Same work for unknown accounts (scrypt on a dummy hash) – no enumeration via timing.
    const ok = login ? await verifyPassword(b.password, login.passwordHash) : (await verifyPassword(b.password, await getDummyHash()), false);
    if (!login || !ok) {
      limiters.loginKey.hit(key);
      throw new HttpError(401, "unauthenticated", "E-Mail-Adresse oder Passwort ist falsch.");
    }
    limiters.loginKey.reset(key);

    const { session, blocked } = await withTx(pool, "app_user", login.userId, (q) => buildSession(q, login.userId, email));
    if (blocked) throw new HttpError(403, blocked.code, blocked.message);
    const ua = typeof ctx.req.headers["user-agent"] === "string" ? ctx.req.headers["user-agent"] : null;
    const { token, expiresAt } = await createSession(pool, login.userId, config.sessionTtlHours, ua);
    log({ level: "info", msg: "login", requestId: ctx.requestId, userId: login.userId });
    return {
      status: 200,
      body: session,
      headers: { "Set-Cookie": sessionCookie(token, (expiresAt.getTime() - Date.now()) / 1000) },
    };
  });

  router.add("POST", "/api/auth/logout", async (ctx) => {
    const token = ctx.cookies[cookieName];
    if (token) await revokeSession(pool, token);
    return { status: 204, headers: { "Set-Cookie": clearCookie() } };
  });

  router.add("GET", "/api/auth/session", async (ctx): Promise<Reply> => {
    const token = ctx.cookies[cookieName];
    const rec = token ? await resolveSession(pool, token, config.sessionIdleMinutes) : null;
    if (!rec) return { status: 200, body: null, headers: token ? { "Set-Cookie": clearCookie() } : undefined };
    const { session, blocked } = await withTx(pool, "app_user", rec.userId, (q) => buildSession(q, rec.userId, rec.email));
    return { status: 200, body: blocked ? null : session };
  });

  // Always 204 for well-formed input – known and unknown addresses look the same.
  router.add("POST", "/api/auth/password-reset", async (ctx) => {
    const b = v.object(ctx.body, ["email"]);
    const email = v.email(b.email);
    const key = `${ctx.ip}|${email}`;
    const wait = Math.max(limiters.resetIp.blockedFor(ctx.ip), limiters.resetKey.blockedFor(key));
    if (wait > 0) throw tooMany(wait, "Anfragen");
    limiters.resetIp.hit(ctx.ip);
    limiters.resetKey.hit(key);
    const token = await createPasswordReset(pool, email);
    if (token) {
      app.sendLater([{
        to: email,
        subject: "Passwort zurücksetzen",
        text: `Hallo,\n\nfür dein Konto wurde ein neues Passwort angefordert. Über diesen Link kannst du es innerhalb einer Stunde festlegen:\n\n${app.link("reset", token)}\n\nWenn du das nicht warst, kannst du diese E-Mail ignorieren.\n`,
      }]);
    }
    return { status: 204 };
  });

  function tokenBody(ctx: RequestContext): { token: string; password: unknown } {
    const wait = limiters.tokenIp.blockedFor(ctx.ip);
    if (wait > 0) throw tooMany(wait, "Versuche");
    limiters.tokenIp.hit(ctx.ip);
    const b = v.object(ctx.body, ["token", "password"]);
    if (typeof b.token !== "string" || !ONE_TIME_TOKEN_RE.test(b.token)) throw badRequest("Der Link ist ungültig oder abgelaufen.");
    return { token: b.token, password: b.password };
  }
  function newPassword(password: unknown): string {
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);
    return password as string;
  }

  router.add("POST", "/api/auth/password-reset/confirm", async (ctx) => {
    const b = tokenBody(ctx);
    const token = b.token;
    const password = newPassword(b.password);
    await resetPassword(pool, token, password);
    return { status: 204 };
  });

  // Activates the membership. New account → the password is set. Existing
  // account with that e-mail → linked WITHOUT changing its password (a typed
  // password is not used) and the user is told to sign in with the existing
  // password. No automatic sign-in in either case.
  router.add("POST", "/api/auth/invitation/accept", async (ctx): Promise<Reply> => {
    const b = tokenBody(ctx);
    if (await invitationNeedsExistingLogin(pool, b.token)) {
      try {
        await acceptInvitation(pool, b.token, null);
      } catch (e) {
        if ((e as { code?: string }).code === "PT409") throw new HttpError(409, "existing_account", (e as Error).message);
        throw e;
      }
      return {
        status: 200,
        body: {
          existingAccount: true,
          message: "Für diese E-Mail-Adresse gibt es bereits ein Benutzerkonto. Die Einladung wurde damit verknüpft – bitte melde dich mit deinem bisherigen Passwort an.",
        },
      };
    }
    const password = newPassword(b.password);
    try {
      await acceptInvitation(pool, b.token, password);
    } catch (e) {
      // Race: an account with that e-mail was created in between.
      if ((e as { code?: string }).code === "PT409") throw new HttpError(409, "existing_account", (e as Error).message);
      throw e;
    }
    return { status: 200, body: { existingAccount: false, message: "Dein Passwort ist gespeichert. Du kannst dich jetzt anmelden." } };
  });

  registerDomainRoutes(router, app);

  const apiHandler = createRequestHandler(router, {
    allowedOrigins: config.publicOrigins,
    secure: config.secureCookies,
    trustProxy: config.trustProxy,
    log,
  });
  const handler = config.staticDir ? withStaticFiles(apiHandler, { root: config.staticDir, secure: config.secureCookies, log }) : apiHandler;
  return { handler, limiters, cookieName };
}

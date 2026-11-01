/**
 * Promo codes (decision 30.10.2026, migration 0022, docs/api.md):
 *
 *   GET  /api/platform/promo-codes                    platform staff: codes with redemptions (company names only)
 *   POST /api/platform/promo-codes                    super_admin: create (code, discountPercent 1–100, note, maxRedemptions, redeemableUntil)
 *   POST /api/platform/promo-codes/:id/end            super_admin: end the code and all running discounts (reason)
 *   POST /api/platform/tenants/:tenantId/promo/end    super_admin: end the running discount of one tenant (reason)
 *   GET  /api/tenants/:tenantId/promo                 leadership of the tenant: own redemptions
 *   POST /api/tenants/:tenantId/promo                 owner: redeem a code (rate limited against guessing)
 *
 * Access checks, rules and audit live in the database (SECURITY DEFINER functions).
 */
import type { PromoCode, PromoRedemption } from "../../platform/src/core/types.ts";
import type { AppContext } from "./app.ts";
import { HttpError } from "./errors.ts";
import type { Router } from "./http.ts";
import { RateLimiter } from "./rateLimit.ts";
import * as v from "./validate.ts";

const CODE_RE = /^[A-Za-z0-9-]{6,32}$/;
const CODE_MESSAGE = "Der Aktionscode muss 6–32 Zeichen lang sein (Buchstaben A–Z, Ziffern, Bindestrich).";

export function registerPromoRoutes(router: Router, app: AppContext): void {
  const json = (status: number, body: unknown) => ({ status, body });
  // Redeeming: at most 10 attempts per IP and per tenant in the rate-limit window.
  const redeemIp = new RateLimiter(10, app.config.rateLimit.windowMs);
  const redeemTenant = new RateLimiter(10, app.config.rateLimit.windowMs);

  router.add("GET", "/api/platform/promo-codes", async (ctx) =>
    app.asUser(ctx, async (q) => json(200, (await q.query("select public.platform_promo_codes() as l")).rows[0].l as PromoCode[])));

  router.add("POST", "/api/platform/promo-codes", async (ctx) => {
    const b = v.object(ctx.body, ["code", "discountPercent", "note", "maxRedemptions", "redeemableUntil"]);
    const code = v.str(b.code, { label: "Der Aktionscode", max: 32, min: 6, pattern: CODE_RE, patternMessage: CODE_MESSAGE });
    const pct = v.int(b.discountPercent, "Der Nachlass (%)", 1, 100);
    const note = v.optStr(b.note, { label: "Die Notiz", max: 500 });
    const max = b.maxRedemptions === undefined || b.maxRedemptions === null ? null : v.int(b.maxRedemptions, "Die Anzahl der Einlösungen", 1, 100000);
    const until = b.redeemableUntil === undefined || b.redeemableUntil === null || b.redeemableUntil === "" ? null : v.date(b.redeemableUntil, "Datum (einlösbar bis)");
    return app.asUser(ctx, async (q) =>
      json(201, (await q.query("select public.platform_create_promo_code($1, $2, $3, $4, $5) as c", [code, pct, note, max, until])).rows[0].c as PromoCode));
  });

  router.add("POST", "/api/platform/promo-codes/:id/end", async (ctx) => {
    const id = v.uuid(ctx.params.id, "Aktionscode-ID");
    const b = v.object(ctx.body, ["reason"]);
    const reason = v.reason(b.reason, 3, "Bitte einen Grund für das Beenden angeben.");
    return app.asUser(ctx, async (q) =>
      json(200, (await q.query("select public.platform_end_promo_code($1, $2) as c", [id, reason])).rows[0].c as PromoCode));
  });

  router.add("POST", "/api/platform/tenants/:tenantId/promo/end", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["reason"]);
    const reason = v.reason(b.reason, 3, "Bitte einen Grund für das Beenden angeben.");
    return app.asUser(ctx, async (q) =>
      json(200, (await q.query("select public.platform_end_promo_redemption($1, $2) as r", [id, reason])).rows[0].r as PromoRedemption));
  });

  router.add("GET", "/api/tenants/:tenantId/promo", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    return app.asUser(ctx, async (q) => json(200, (await q.query("select public.tenant_promo($1) as l", [id])).rows[0].l as PromoRedemption[]));
  });

  router.add("POST", "/api/tenants/:tenantId/promo", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["code"]);
    const code = v.str(b.code, { label: "Der Aktionscode", max: 32, min: 1 });
    const wait = Math.max(redeemIp.blockedFor(ctx.ip), redeemTenant.blockedFor(id));
    if (wait > 0) {
      throw new HttpError(429, "rate_limited", `Zu viele Versuche. Bitte in ${Math.max(1, Math.ceil(wait / 60))} Minuten erneut versuchen.`, { "Retry-After": String(wait) });
    }
    redeemIp.hit(ctx.ip);
    redeemTenant.hit(id);
    if (!CODE_RE.test(code)) throw new HttpError(400, "invalid", "Der Aktionscode ist ungültig oder nicht mehr einlösbar.");
    return app.asUser(ctx, async (q) =>
      json(201, (await q.query("select public.tenant_redeem_promo_code($1, $2) as r", [id, code])).rows[0].r as PromoRedemption));
  });
}

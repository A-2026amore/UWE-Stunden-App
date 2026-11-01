/**
 * Two-factor authentication (TOTP, RFC 6238): encryption of the secret,
 * code verification with replay protection, recovery codes, pending sign-in
 * challenges. All database access runs as app_auth (db/migrations/0009).
 *
 * - Secret: 20 random bytes, stored only as AES-256-GCM ciphertext
 *   "v1.<key id>.<iv>.<tag>.<ciphertext>" (base64url). Additional
 *   authenticated data = "totp:<user id>", so a ciphertext copied to another
 *   user does not decrypt. Key: TOTP_ENCRYPTION_KEY (config.twoFactor.keys[0]);
 *   older keys (TOTP_ENCRYPTION_KEY_PREVIOUS) only decrypt and the secret is
 *   re-encrypted with the current key on the next successful use.
 * - Codes: HMAC-SHA-1 via node:crypto, 6 digits, 30 s, window ±1 step; all
 *   candidates are compared with crypto.timingSafeEqual. A code is accepted
 *   only for a step newer than last_used_step (no replay); the factor row is
 *   locked (FOR UPDATE) during verification.
 * - Recovery codes: 10 × 16 characters (~78 bit), stored as
 *   SHA-256("<user id>:<code>"), single use; compared in constant time.
 * - Challenge: 32 random bytes as HttpOnly cookie, only the SHA-256 hash in
 *   auth.two_factor_challenges, 5 minutes, max. 5 attempts, single use.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import {
  base32Encode, generateRecoveryCode, matchTotpStep, normalizeRecoveryCode, normalizeTotpCode, otpauthUri,
  RECOVERY_CODE_COUNT, TOTP_SECRET_BYTES, type HmacSha1,
} from "../../platform/src/security/totp.ts";
import type { TwoFactorConfig } from "./config.ts";
import { withTx, type Queryable } from "./db.ts";
import { sha256Hex } from "./auth.ts";

export const CHALLENGE_MINUTES = 5;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const CHALLENGE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type RequiredBy = "platform" | "tenant" | null;

export interface TwoFactorState {
  enrolled: boolean;
  requiredBy: RequiredBy;
}

export interface TwoFactorStatus extends TwoFactorState {
  enabled: boolean;
  enrolledAt: string | null;
  /** Setup started but not yet confirmed. */
  pending: boolean;
  required: boolean;
  recoveryCodesRemaining: number;
}

export type Proof = { kind: "totp"; code: string } | { kind: "recovery"; code: string };

export const nodeHmacSha1: HmacSha1 = (key, message) => createHmac("sha1", key).update(message).digest();

/** Constant-time comparison of two equal-length ASCII strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ encryption

export function encryptSecret(cfg: TwoFactorConfig, userId: string, secret: Uint8Array): string {
  const k = cfg.keys[0]!;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(`totp:${userId}`, "utf8"));
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return `v1.${k.id}.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

export class TotpKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TotpKeyError";
  }
}

export function decryptSecret(cfg: TwoFactorConfig, userId: string, stored: string): { secret: Buffer; currentKey: boolean } {
  const m = /^v1\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) throw new TotpKeyError("TOTP ciphertext has an unknown format");
  const k = cfg.keys.find((x) => x.id === m[1]);
  // Never log key material; the id is enough to find the missing key.
  if (!k) throw new TotpKeyError(`TOTP key ${m[1]} is not configured (TOTP_ENCRYPTION_KEY / TOTP_ENCRYPTION_KEY_PREVIOUS)`);
  try {
    const d = createDecipheriv("aes-256-gcm", k.key, Buffer.from(m[2]!, "base64url"), { authTagLength: 16 });
    d.setAAD(Buffer.from(`totp:${userId}`, "utf8"));
    d.setAuthTag(Buffer.from(m[3]!, "base64url"));
    const secret = Buffer.concat([d.update(Buffer.from(m[4]!, "base64url")), d.final()]);
    return { secret, currentKey: k.id === cfg.keys[0]!.id };
  } catch {
    throw new TotpKeyError(`TOTP secret could not be decrypted with key ${k.id}`);
  }
}

export function recoveryCodeHash(userId: string, normalized: string): string {
  return createHash("sha256").update(`${userId}:${normalized}`, "utf8").digest("hex");
}

/** Parses the request body of a verification: {code} or {recoveryCode}. null = malformed. */
export function parseProof(body: Record<string, unknown>): Proof | null {
  const hasCode = body.code !== undefined && body.code !== null && body.code !== "";
  const hasRecovery = body.recoveryCode !== undefined && body.recoveryCode !== null && body.recoveryCode !== "";
  if (hasCode === hasRecovery) return null;
  if (hasCode) {
    const c = normalizeTotpCode(body.code);
    return c ? { kind: "totp", code: c } : null;
  }
  const r = normalizeRecoveryCode(body.recoveryCode);
  return r ? { kind: "recovery", code: r } : null;
}

// ------------------------------------------------------------------ service

export interface TwoFactorService {
  state(q: Queryable, userId: string): Promise<TwoFactorState>;
  status(userId: string): Promise<TwoFactorStatus>;
  /** Locks the user and either creates a full session (no factor) or a pending challenge (factor enrolled). */
  /**
   * After a correct password: challenge (2FA enrolled) or session. With
   * allowSession = false (access blocked) an account without 2FA gets
   * "refused" and no session is created; enrolled accounts still get the
   * challenge, so the block is only revealed after the second factor.
   */
  beginLogin(userId: string, ttlHours: number, userAgent: string | null, opts?: { allowSession?: boolean }): Promise<
    | { kind: "session"; token: string; expiresAt: Date; requiredBy: RequiredBy }
    | { kind: "challenge"; token: string }
    | { kind: "refused" }
  >;
  /** Counts one attempt on the challenge; null when unknown, used, expired or out of attempts. */
  takeChallenge(token: string): Promise<{ challengeId: string; userId: string; email: string } | null>;
  /** Marks the challenge as used; false when it was used concurrently. */
  completeChallenge(challengeId: string): Promise<boolean>;
  verify(userId: string, proof: Proof): Promise<{ ok: boolean; recoveryCodesRemaining?: number }>;
  startSetup(userId: string, email: string): Promise<{ secret: string; otpauthUri: string; issuer: string; account: string } | "enrolled">;
  confirmSetup(userId: string, code: string, keepSessionId: string): Promise<{ recoveryCodes: string[] } | "invalid" | "no_setup">;
  disable(userId: string): Promise<void>;
  regenerateRecoveryCodes(userId: string): Promise<string[]>;
}

async function stateOf(q: Queryable, userId: string): Promise<TwoFactorState> {
  const r = await q.query<{ enrolled: boolean; required_by: RequiredBy }>("select * from auth.two_factor_state($1)", [userId]);
  return { enrolled: Boolean(r.rows[0]?.enrolled), requiredBy: r.rows[0]?.required_by ?? null };
}

async function insertRecoveryCodes(q: Queryable, userId: string): Promise<string[]> {
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODE_COUNT) {
    const c = generateRecoveryCode((n) => randomBytes(n));
    if (!codes.includes(c)) codes.push(c);
  }
  const hashes = codes.map((c) => recoveryCodeHash(userId, c.replace(/-/g, "")));
  await q.query(
    "insert into auth.totp_recovery_codes (user_id, code_hash) select $1, h from unnest($2::text[]) as h",
    [userId, hashes],
  );
  return codes;
}

export function createTwoFactorService(pool: pg.Pool, cfg: TwoFactorConfig, now: () => number = Date.now): TwoFactorService {
  const auth = <T>(fn: (q: Queryable) => Promise<T>) => withTx(pool, "app_auth", null, fn);

  /** Checks a TOTP code against the locked factor row and stores the step. */
  async function verifyTotp(q: Queryable, userId: string, code: string): Promise<boolean> {
    const f = (await q.query<{ secret_ciphertext: string; last_used_step: string | null }>(
      "select secret_ciphertext, last_used_step from auth.totp_factors where user_id = $1 and enrolled_at is not null for update",
      [userId],
    )).rows[0];
    if (!f) return false;
    const { secret, currentKey } = decryptSecret(cfg, userId, f.secret_ciphertext);
    const step = matchTotpStep(secret, code, now(), { hmac: nodeHmacSha1, equal: safeEqual });
    const last = f.last_used_step === null ? -1 : Number(f.last_used_step);
    if (step === null || step <= last) return false;
    await q.query(
      `update auth.totp_factors set last_used_step = $2${currentKey ? "" : ", secret_ciphertext = $3"} where user_id = $1`,
      currentKey ? [userId, step] : [userId, step, encryptSecret(cfg, userId, secret)],
    );
    return true;
  }

  async function verifyRecovery(q: Queryable, userId: string, normalized: string): Promise<{ ok: boolean; remaining?: number }> {
    // Lock the factor: concurrent uses of the same code are serialised.
    const f = await q.query("select 1 from auth.totp_factors where user_id = $1 and enrolled_at is not null for update", [userId]);
    if (!f.rowCount) return { ok: false };
    const rows = (await q.query<{ id: string; code_hash: string }>(
      "select id, code_hash from auth.totp_recovery_codes where user_id = $1 and used_at is null", [userId],
    )).rows;
    const candidate = recoveryCodeHash(userId, normalized);
    let match: string | null = null;
    for (const r of rows) if (safeEqual(r.code_hash, candidate) && match === null) match = r.id;
    if (!match) return { ok: false };
    const u = await q.query("update auth.totp_recovery_codes set used_at = now() where id = $1 and used_at is null", [match]);
    if (!u.rowCount) return { ok: false };
    return { ok: true, remaining: rows.length - 1 };
  }

  return {
    state: stateOf,

    async status(userId) {
      return auth(async (q) => {
        const st = await stateOf(q, userId);
        const f = (await q.query<{ enrolled_at: Date | null; remaining: number }>(
          `select f.enrolled_at,
                  (select count(*)::int from auth.totp_recovery_codes c where c.user_id = f.user_id and c.used_at is null) as remaining
             from auth.totp_factors f where f.user_id = $1`, [userId],
        )).rows[0];
        return {
          ...st,
          enabled: st.enrolled,
          enrolledAt: f?.enrolled_at ? f.enrolled_at.toISOString() : null,
          pending: !!f && !f.enrolled_at,
          required: st.requiredBy !== null,
          recoveryCodesRemaining: f?.enrolled_at ? f.remaining : 0,
        };
      });
    },

    async beginLogin(userId, ttlHours, userAgent, opts = {}) {
      return auth(async (q) => {
        // Serialises against a concurrent enrolment (confirmSetup locks the same row).
        const u = await q.query("select 1 from auth.users where id = $1 and disabled_at is null for update", [userId]);
        if (!u.rowCount) throw new Error("user disabled");
        const st = await stateOf(q, userId);
        const token = randomBytes(32).toString("base64url");
        if (st.enrolled) {
          await q.query("delete from auth.two_factor_challenges where user_id = $1 and (used_at is not null or expires_at <= now())", [userId]);
          await q.query(
            `insert into auth.two_factor_challenges (user_id, token_hash, expires_at)
             values ($1, $2, now() + make_interval(mins => $3))`,
            [userId, sha256Hex(token), CHALLENGE_MINUTES],
          );
          return { kind: "challenge" as const, token };
        }
        if (opts.allowSession === false) return { kind: "refused" as const };
        const r = await q.query<{ expires_at: Date }>(
          `insert into auth.sessions (user_id, token_hash, expires_at, user_agent)
           values ($1, $2, now() + make_interval(hours => $3), left($4, 512)) returning expires_at`,
          [userId, sha256Hex(token), ttlHours, userAgent],
        );
        return { kind: "session" as const, token, expiresAt: r.rows[0]!.expires_at, requiredBy: st.requiredBy };
      });
    },

    async takeChallenge(token) {
      if (!CHALLENGE_TOKEN_RE.test(token)) return null;
      return auth(async (q) => {
        const r = await q.query<{ id: string; user_id: string; email: string }>(
          `update auth.two_factor_challenges c set attempts = c.attempts + 1
             from auth.users u
            where c.token_hash = $1 and c.used_at is null and c.expires_at > now() and c.attempts < $2
              and u.id = c.user_id and u.disabled_at is null
           returning c.id, c.user_id, u.email`,
          [sha256Hex(token), CHALLENGE_MAX_ATTEMPTS],
        );
        const row = r.rows[0];
        return row ? { challengeId: row.id, userId: row.user_id, email: row.email } : null;
      });
    },

    async completeChallenge(challengeId) {
      return auth(async (q) => {
        const r = await q.query("update auth.two_factor_challenges set used_at = now() where id = $1 and used_at is null and expires_at > now()", [challengeId]);
        return r.rowCount === 1;
      });
    },

    async verify(userId, proof) {
      return auth(async (q) => {
        if (proof.kind === "totp") return { ok: await verifyTotp(q, userId, proof.code) };
        const r = await verifyRecovery(q, userId, proof.code);
        return r.ok ? { ok: true, recoveryCodesRemaining: r.remaining } : { ok: false };
      });
    },

    async startSetup(userId, email) {
      return auth(async (q) => {
        await q.query("select 1 from auth.users where id = $1 for update", [userId]);
        const f = (await q.query<{ enrolled_at: Date | null }>("select enrolled_at from auth.totp_factors where user_id = $1", [userId])).rows[0];
        if (f?.enrolled_at) return "enrolled" as const;
        const secret = randomBytes(TOTP_SECRET_BYTES);
        const ct = encryptSecret(cfg, userId, secret);
        await q.query(
          `insert into auth.totp_factors (user_id, secret_ciphertext) values ($1, $2)
           on conflict (user_id) do update set secret_ciphertext = excluded.secret_ciphertext, created_at = now(), last_used_step = null
           where auth.totp_factors.enrolled_at is null`,
          [userId, ct],
        );
        const b32 = base32Encode(secret);
        secret.fill(0);
        return { secret: b32, otpauthUri: otpauthUri({ issuer: cfg.issuer, account: email, secret: b32 }), issuer: cfg.issuer, account: email };
      });
    },

    async confirmSetup(userId, code, keepSessionId) {
      return auth(async (q) => {
        await q.query("select 1 from auth.users where id = $1 for update", [userId]);
        const f = (await q.query<{ secret_ciphertext: string; enrolled_at: Date | null; created_at: Date }>(
          "select secret_ciphertext, enrolled_at, created_at from auth.totp_factors where user_id = $1 for update", [userId],
        )).rows[0];
        // A started setup is valid for one hour.
        if (!f || f.enrolled_at || f.created_at.getTime() < now() - 3600_000) return "no_setup" as const;
        const { secret } = decryptSecret(cfg, userId, f.secret_ciphertext);
        const step = matchTotpStep(secret, code, now(), { hmac: nodeHmacSha1, equal: safeEqual });
        secret.fill(0);
        if (step === null) return "invalid" as const;
        await q.query("update auth.totp_factors set enrolled_at = now(), last_used_step = $2 where user_id = $1", [userId, step]);
        await q.query("delete from auth.totp_recovery_codes where user_id = $1", [userId]);
        const recoveryCodes = await insertRecoveryCodes(q, userId);
        // Sessions that were opened with the password only end now (except this one).
        await q.query("update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null and id <> $2", [userId, keepSessionId]);
        await q.query("delete from auth.two_factor_challenges where user_id = $1", [userId]);
        return { recoveryCodes };
      });
    },

    async disable(userId) {
      await auth(async (q) => {
        await q.query("select 1 from auth.users where id = $1 for update", [userId]);
        await q.query("delete from auth.totp_factors where user_id = $1", [userId]); // recovery codes: on delete cascade
        await q.query("delete from auth.two_factor_challenges where user_id = $1", [userId]);
      });
    },

    async regenerateRecoveryCodes(userId) {
      return auth(async (q) => {
        await q.query("select 1 from auth.totp_factors where user_id = $1 and enrolled_at is not null for update", [userId]);
        await q.query("delete from auth.totp_recovery_codes where user_id = $1", [userId]);
        return insertRecoveryCodes(q, userId);
      });
    },
  };
}

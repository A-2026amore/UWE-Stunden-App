/**
 * Passwords (scrypt), sessions and one-time-token helpers.
 *
 * - Passwords: Node crypto.scrypt, random 16-byte salt, constant-time compare.
 *   Stored format: "scrypt$N$r$p$<salt base64>$<hash base64>".
 * - Sessions: random 32-byte token (base64url) sent only as HttpOnly cookie;
 *   auth.sessions stores only its SHA-256 hash (same hash as
 *   private.hash_token, so auth.resolve_session/revoke_session stay usable).
 *   Absolute expiry (expires_at) plus an idle timeout (last_seen_at).
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type pg from "pg";
import { withTx } from "./db.ts";

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 } as const;
const MAX_N = 1 << 20;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function scryptOpts(N: number, r: number, p: number): ScryptOptions {
  return { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, scryptOpts(SCRYPT.N, SCRYPT.r, SCRYPT.p));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Constant-time verification. Malformed hashes simply fail. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return false;
  const actual = await scrypt(password, salt, expected.length, scryptOpts(N, r, p));
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;
/** Hash used to burn the same CPU time for unknown accounts (no user enumeration via timing). */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString("base64"));
  return dummyHash;
}

export function sha256Hex(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** One-time tokens from the database: 64 hex chars (seed/demo tokens may differ, max 200 chars). */
export const ONE_TIME_TOKEN_RE = /^[A-Za-z0-9_-]{16,200}$/;

export interface SessionRecord {
  sessionId: string;
  userId: string;
  email: string;
  expiresAt: Date;
  /** Since 0009: TOTP factor confirmed. */
  twoFactorEnrolled: boolean;
  /** Since 0009: "platform" (platform staff) or "tenant" (owner requires it for managers); null = optional. */
  twoFactorRequiredBy: "platform" | "tenant" | null;
}

/** Signed in, but 2FA is mandatory and not set up yet: only the 2FA setup is reachable. */
export function needsTwoFactorSetup(rec: Pick<SessionRecord, "twoFactorEnrolled" | "twoFactorRequiredBy">): boolean {
  return rec.twoFactorRequiredBy !== null && !rec.twoFactorEnrolled;
}

export async function createSession(
  pool: pg.Pool,
  userId: string,
  ttlHours: number,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const row = await withTx(pool, "app_auth", null, async (q) => {
    const r = await q.query<{ expires_at: Date }>(
      `insert into auth.sessions (user_id, token_hash, expires_at, user_agent)
       select u.id, $2, now() + make_interval(hours => $3), left($4, 512)
       from auth.users u where u.id = $1 and u.disabled_at is null
       returning expires_at`,
      [userId, sha256Hex(token), ttlHours, userAgent],
    );
    return r.rows[0];
  });
  if (!row) throw new Error("user disabled");
  return { token, expiresAt: row.expires_at };
}

/**
 * Valid session for a cookie token, or null. auth.resolve_session (0008)
 * checks expiry, disabled accounts and the idle timeout (revokes idle
 * sessions) and refreshes last_seen_at. auth.two_factor_state (0009) adds
 * whether 2FA is set up and whether it is mandatory for this account.
 */
export async function resolveSession(pool: pg.Pool, token: string, idleMinutes: number): Promise<SessionRecord | null> {
  if (!SESSION_TOKEN_RE.test(token)) return null;
  return withTx(pool, "app_auth", null, async (q) => {
    const r = await q.query<{ session_id: string; user_id: string; expires_at: Date; email: string; enrolled: boolean; required_by: SessionRecord["twoFactorRequiredBy"] }>(
      `select s.session_id, s.user_id, s.expires_at, u.email, st.enrolled, st.required_by
         from auth.resolve_session($1, $2) s
         join auth.users u on u.id = s.user_id
         cross join lateral auth.two_factor_state(s.user_id) st`,
      [token, idleMinutes],
    );
    const s = r.rows[0];
    return s ? {
      sessionId: s.session_id, userId: s.user_id, email: s.email, expiresAt: s.expires_at,
      twoFactorEnrolled: Boolean(s.enrolled), twoFactorRequiredBy: s.required_by ?? null,
    } : null;
  });
}

export async function revokeSession(pool: pg.Pool, token: string): Promise<void> {
  if (!SESSION_TOKEN_RE.test(token)) return;
  await withTx(pool, "app_auth", null, (q) => q.query("select auth.revoke_session($1)", [token]));
}

/** Login lookup: user id + hash, or null for unknown/disabled/no-password accounts. */
export async function getLogin(pool: pg.Pool, email: string): Promise<{ userId: string; passwordHash: string } | null> {
  return withTx(pool, "app_auth", null, async (q) => {
    const r = await q.query<{ user_id: string; password_hash: string }>("select * from auth.get_login($1)", [email]);
    const row = r.rows[0];
    return row ? { userId: row.user_id, passwordHash: row.password_hash } : null;
  });
}

/** Creates a reset token (or null for unknown e-mail). */
export async function createPasswordReset(pool: pg.Pool, email: string): Promise<string | null> {
  return withTx(pool, "app_auth", null, async (q) => {
    const r = await q.query<{ token: string | null }>("select auth.create_password_reset($1) as token", [email]);
    return r.rows[0]?.token ?? null;
  });
}

export async function resetPassword(pool: pg.Pool, token: string, password: string): Promise<string> {
  const hash = await hashPassword(password);
  return withTx(pool, "app_auth", null, async (q) => {
    const r = await q.query<{ user_id: string }>("select auth.reset_password($1, $2) as user_id", [token, hash]);
    return r.rows[0]!.user_id;
  });
}

/** True when the invitation's e-mail already has an account (link without new password). */
export async function invitationNeedsExistingLogin(pool: pg.Pool, token: string): Promise<boolean> {
  return withTx(pool, "app_auth", null, async (q) => {
    const r = await q.query<{ v: boolean }>("select auth.invitation_needs_existing_login($1) as v", [token]);
    return Boolean(r.rows[0]?.v);
  });
}

/**
 * Accepts an invitation. password = null links an existing account (its
 * password stays unchanged); for a new account a password is required.
 */
export async function acceptInvitation(pool: pg.Pool, token: string, password: string | null): Promise<string> {
  const hash = password === null ? null : await hashPassword(password);
  return withTx(pool, "app_auth", null, async (q) => {
    const r = await q.query<{ user_id: string }>("select auth.accept_invitation($1, $2) as user_id", [token, hash]);
    return r.rows[0]!.user_id;
  });
}

/**
 * Operator/test helper: sets a password through the regular reset functions
 * (create_password_reset + reset_password). Returns false for unknown e-mails.
 */
export async function setPasswordViaReset(pool: pg.Pool, email: string, password: string): Promise<boolean> {
  const token = await createPasswordReset(pool, email);
  if (!token) return false;
  await resetPassword(pool, token, password);
  return true;
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** German problem text for a new password, or null when acceptable. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Bitte ein Passwort angeben.";
  if (password.length < PASSWORD_MIN) return `Das Passwort muss mindestens ${PASSWORD_MIN} Zeichen lang sein.`;
  if (password.length > PASSWORD_MAX) return `Das Passwort darf höchstens ${PASSWORD_MAX} Zeichen lang sein.`;
  return null;
}

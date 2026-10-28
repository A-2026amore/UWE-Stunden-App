/**
 * Operator functions used by server/src/cli.ts (never reachable over HTTP).
 *
 * invite-link: creates an invitation without sending an e-mail and returns the
 * link so that the operator can hand it over personally (operation without
 * SMTP, QA finding B1). The link is printed on the console by the CLI only –
 * it is never logged and no API route returns it.
 */
import type pg from "pg";
import { withTx } from "./db.ts";

export const INVITE_ROLES = ["employee", "manager", "owner"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export interface OperatorInvitation {
  tenantName: string;
  tenantStatus: "active" | "suspended" | "pending";
  employeeId: string;
  role: InviteRole;
  createdEmployee: boolean;
  invitationId: string;
  token: string;
  expiresAt: string;
}

/** Link with the token in the URL fragment (never sent to servers, not in access logs or Referer). */
export function oneTimeLink(origin: string, path: string, token: string): string {
  return `${origin}${path}#token=${encodeURIComponent(token)}`;
}

/**
 * Origin and path for invitation links from the environment – the same
 * variables and defaults as loadConfig (PUBLIC_ORIGIN: first entry,
 * INVITE_LINK_PATH), without requiring the other server settings.
 */
export function inviteLinkBase(env: NodeJS.ProcessEnv): { origin: string; path: string } {
  const production = env.NODE_ENV === "production";
  const raw = (env.PUBLIC_ORIGIN ?? (production ? "" : "http://localhost:5173")).split(",").map((s) => s.trim()).filter(Boolean)[0];
  if (!raw) throw new Error("PUBLIC_ORIGIN fehlt (z. B. https://zeit.example.de).");
  let origin: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
    origin = u.origin;
  } catch {
    throw new Error(`PUBLIC_ORIGIN enthält keine gültige Adresse: ${raw}`);
  }
  if (production && !origin.startsWith("https://")) throw new Error("In Produktion muss PUBLIC_ORIGIN mit https:// beginnen.");
  return { origin, path: env.INVITE_LINK_PATH ?? "/einladung" };
}

/** Creates (or renews) the invitation via auth.operator_create_invitation (role app_auth). */
export async function createOperatorInvitation(
  pool: pg.Pool,
  input: { tenantSlug: string; email: string; role: InviteRole; displayName?: string | null; validDays?: number },
): Promise<OperatorInvitation> {
  return withTx(pool, "app_auth", null, async (q) => {
    const r = await q.query<{ inv: OperatorInvitation }>(
      "select auth.operator_create_invitation($1, $2, $3, $4, $5) as inv",
      [input.tenantSlug, input.email, input.role, input.displayName ?? null, input.validDays ?? 7],
    );
    return r.rows[0]!.inv;
  });
}

/**
 * Payment provider interface – PREPARED ONLY (price model 2026-10-28).
 *
 * The platform bills manually (status per tenant and month in the super-admin
 * portal). This interface marks the place where a payment provider could be
 * connected later. The only implementation is "none":
 *  - no external calls, no network access, no account or card data stored,
 *  - every charge attempt is refused.
 * Connecting a real provider needs a decision of the client, a contract, a
 * data-protection review and its own implementation + tests.
 */

export type PaymentProviderName = "none";

export interface ChargeRequest {
  tenantId: string;
  /** Billing month YYYY-MM. */
  month: string;
  /** Net amount in cents. */
  amountCents: number;
  currency: "EUR";
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** False: automatic payments are switched off. */
  readonly active: boolean;
  /** Would collect a payment. "none" always refuses (no external call). */
  charge(request: ChargeRequest): Promise<never>;
}

export class PaymentsDisabledError extends Error {
  constructor() {
    super("Es ist kein Zahlungsdienstleister angebunden. Abrechnung erfolgt manuell; es werden keine Zahlungen ausgelöst.");
    this.name = "PaymentsDisabledError";
  }
}

export const nonePaymentProvider: PaymentProvider = Object.freeze({
  name: "none" as const,
  active: false,
  async charge(): Promise<never> {
    throw new PaymentsDisabledError();
  },
});

/** PAYMENT_PROVIDER: empty or "none". Anything else stops the server (nothing is activated by accident). */
export function parsePaymentProviderName(raw: string | undefined): PaymentProviderName {
  const v = (raw ?? "").trim();
  if (v === "" || v === "none") return "none";
  throw new Error(`PAYMENT_PROVIDER=${v.slice(0, 40)} wird nicht unterstützt. Zulässig ist nur "none" (kein Zahlungsdienstleister).`);
}

export function createPaymentProvider(name: PaymentProviderName): PaymentProvider {
  if (name === "none") return nonePaymentProvider;
  throw new Error("Unbekannter Zahlungsdienstleister.");
}

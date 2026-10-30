import { describe, expect, it } from "vitest";
import { PaymentsDisabledError, createPaymentProvider, nonePaymentProvider, parsePaymentProviderName } from "../../server/src/payment.ts";
import { loadConfig } from "../../server/src/config.ts";

describe("payment provider (prepared only)", () => {
  it("only 'none' exists and it never charges", async () => {
    expect(parsePaymentProviderName(undefined)).toBe("none");
    expect(parsePaymentProviderName(" none ")).toBe("none");
    expect(() => parsePaymentProviderName("stripe")).toThrow("nicht unterstützt");
    const p = createPaymentProvider("none");
    expect(p).toBe(nonePaymentProvider);
    expect(p.active).toBe(false);
    await expect(p.charge({ tenantId: "t", month: "2026-10", amountCents: 2500, currency: "EUR" })).rejects.toBeInstanceOf(PaymentsDisabledError);
  });
  it("the server refuses any other PAYMENT_PROVIDER at start", () => {
    const base = { DATABASE_URL: "postgres://x@localhost/y", PUBLIC_ORIGIN: "http://localhost:5173" };
    expect(loadConfig(base).paymentProvider).toBe("none");
    expect(() => loadConfig({ ...base, PAYMENT_PROVIDER: "paypal" })).toThrow("PAYMENT_PROVIDER");
  });
});

import { describe, expect, it } from "vitest";
import { invitationShareText, whatsappShareUrl } from "./invitation";

describe("invitation sharing", () => {
  const text = invitationShareText({
    tenantName: "Demo Krankentransporte", employeeName: "Lena Neu", link: "https://zeit.example/einladung/#token=abc_DEF-123", expiresAt: "2026-11-27T10:00:00+01:00",
  });

  it("greets by first name, names the company, contains the link and the expiry, never a password", () => {
    expect(text).toContain("Hallo Lena,");
    expect(text).toContain("Zeiterfassung von Demo Krankentransporte");
    expect(text).toContain("https://zeit.example/einladung/#token=abc_DEF-123");
    expect(text).toContain("nur einmal");
    expect(text).toMatch(/gültig bis 27\.11\.2026, \d{2}:\d{2} Uhr/);
    expect(text.toLowerCase()).not.toMatch(/passwort: /);
  });

  it("builds a wa.me link with the encoded text (with or without number)", () => {
    const url = whatsappShareUrl(text);
    expect(url.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(url.slice("https://wa.me/?text=".length))).toBe(text);
    expect(url).not.toContain("#token");
    expect(whatsappShareUrl("Hi", "+49 241 123")).toBe("https://wa.me/49241123?text=Hi");
  });
});
